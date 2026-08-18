import { useActionStore, type WorkspaceAction } from "../../stores/actionStore";
import { createBlockId, useBlocksStore, type TerminalBlock } from "../../stores/blocksStore";
import { findTerminalPane, useTerminalStore } from "../../stores/terminalStore";
import {
  extractCommandOutput,
  isEchoOnlyTerminalOutput,
  isLikelyCommandEchoAsOutput,
  isMeaningfulTerminalBlock,
  looksLikePowerShellProgressText,
  normalizeBlockCommand,
  watchHasTrailingPowerShellPrompt,
} from "./terminalOutputText";
import { terminalPaneSenders } from "./terminalPaneSenders";
import { isWarpDisplay } from "./terminalDisplayMode";
import {
  prepareShellForAiTool,
  recoverShellAfterAiTool,
} from "./terminalShellRecovery";
import { maybeAppendAutoLsToCommand, scheduleCdBlockFallbackComplete, scheduleShellBlockFallbackComplete } from "./terminalAutoLs";
import { isCdNavigationCommand, isCdOnlyCommand } from "./terminalAutoLsPolicy";
import { useTerminalUiStore } from "./terminalUiStore";
import {
  FULL_TERMINAL_BLOCK_SUMMARY,
  useTerminalRunStateStore,
} from "./terminalRunStateStore";
import {
  resolveCommandProfile,
  shouldUseFullTerminalForUser,
  type CommandProfileKind,
} from "./terminalCommandProfile";

export const BLOCK_WAIT_TIMEOUT_MS = 60_000;
export const OUTPUT_IDLE_MS = 600;
const MERGE_WINDOW_MS = 120;
const OSC_WAIT_CAP_MS = 5_000;

export interface WaitForCommandOptions {
  timeoutMs?: number;
  outputIdleMs?: number;
  profileKind?: CommandProfileKind;
}

const pendingExecutions = new Map<
  string,
  {
    tabId: string;
    command: string;
    source: WorkspaceAction["source"];
    waitForBlock?: boolean;
    resolveBlock?: (block: TerminalBlock) => void;
    rejectBlock?: (err: Error) => void;
  }
>();

interface OutputWatch {
  command: string;
  cwd: string;
  output: string;
  sawOutput: boolean;
  outputIdleMs: number;
  profileKind?: CommandProfileKind;
  idleTimer: ReturnType<typeof setTimeout> | null;
  hardTimer: ReturnType<typeof setTimeout>;
  resolve: (block: TerminalBlock) => void;
  reject: (err: Error) => void;
}

const outputWatches = new Map<string, OutputWatch>();

/** 同一会话串行执行终端命令，避免上一条未完成时下一条被当作输入粘贴 */
const sessionExecutionChains = new Map<string, Promise<void>>();

/** 上一任务卡住时，最多等这么久再放行下一任务，避免会话链永久死锁 */
const SESSION_CHAIN_PREV_WAIT_MS = 8_000;

function enqueueSessionExecution(
  sessionId: string,
  task: () => Promise<void>,
): Promise<void> {
  const previous = sessionExecutionChains.get(sessionId) ?? Promise.resolve();
  const previousOrTimeout = Promise.race([
    previous.catch(() => undefined),
    sleep(SESSION_CHAIN_PREV_WAIT_MS).then(() => undefined),
  ]);
  const current = previousOrTimeout.then(task);
  sessionExecutionChains.set(
    sessionId,
    current.then(
      () => undefined,
      () => undefined,
    ),
  );
  return current;
}

/** Command Bar 模式下预注册的 Feed 采集块（与 OSC 133 合并） */
const feedCaptures = new Map<string, string>();

export function hasActiveFeedCapture(sessionId: string): boolean {
  return feedCaptures.has(sessionId) || outputWatches.has(sessionId);
}

/** OSC 133;C 优先绑定到预注册块，避免重复 shell block */
export function claimFeedCaptureBlockId(sessionId: string): string | null {
  const blockId = feedCaptures.get(sessionId);
  if (!blockId) return null;
  return blockId;
}

export function releaseFeedCapture(sessionId: string): void {
  feedCaptures.delete(sessionId);
}

export function clearOutputWatch(sessionId: string): void {
  const watch = outputWatches.get(sessionId);
  if (!watch) return;
  if (watch.idleTimer) clearTimeout(watch.idleTimer);
  clearTimeout(watch.hardTimer);
  outputWatches.delete(sessionId);
}

function ensureShellBlockInStore(sessionId: string, block: TerminalBlock): TerminalBlock {
  const store = useBlocksStore.getState();
  const existing = store.findBlockById(block.id);
  if (existing) return existing;

  const sentNorm = normalizeBlockCommand(block.command);
  const blocks = store.getBlocks(sessionId);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const candidate = blocks[i];
    if (candidate.kind === "ai") continue;
    if (normalizeBlockCommand(candidate.command) !== sentNorm) continue;
    if (
      candidate.status === "running" ||
      (block.id.startsWith("syn-") &&
        (candidate.status === "completed" || candidate.status === "failed"))
    ) {
      store.updateBlock(candidate.id, {
        output: block.output || candidate.output,
        exitCode: block.exitCode ?? candidate.exitCode,
        status: block.status,
        cwd: block.cwd || candidate.cwd,
      });
      return { ...block, id: candidate.id };
    }
  }

  const blockId = createBlockId();
  store.addBlock(sessionId, {
    ...block,
    id: blockId,
    sessionId,
    kind: "shell",
  });
  return { ...block, id: blockId };
}

function armFeedCapture(sessionId: string, command: string, silent = false): string {
  const prevBlockId = feedCaptures.get(sessionId);
  if (prevBlockId) {
    // 同会话重复 arm 会覆盖 capture；旧块若仍 running 会永久转圈
    const prev = useBlocksStore.getState().findBlockById(prevBlockId);
    if (prev?.status === "running") {
      useBlocksStore.getState().updateBlock(prevBlockId, {
        status: "failed",
        exitCode: 130,
      });
    }
  }

  const blockId = createBlockId();
  const cwd = resolveSessionCwd(sessionId);
  feedCaptures.set(sessionId, blockId);

  useBlocksStore.getState().addBlock(sessionId, {
    id: blockId,
    sessionId,
    kind: "shell",
    command: normalizeBlockCommand(command) || command,
    output: "",
    exitCode: null,
    startLine: -1,
    endLine: -1,
    marker: null,
    cwd,
    timestamp: Date.now(),
    status: "running",
    ...(silent ? { silent: true } : {}),
  });

  if (silent) {
    if (isCdOnlyCommand(command)) {
      scheduleCdBlockFallbackComplete(sessionId, blockId);
    } else {
      scheduleShellBlockFallbackComplete(sessionId, blockId);
    }
  }

  return blockId;
}

/** Block Feed 内静默执行命令（不经审批 action，走 feed capture） */
export function runSilentFeedCommand(sessionId: string, command: string): void {
  void enqueueSessionExecution(sessionId, async () => {
    const sender = terminalPaneSenders[sessionId];
    if (!sender || !isWarpDisplay(sessionId)) return;
    await waitForConcreteSessionCwd(sessionId);
    armFeedCapture(sessionId, command, true);
    sender(command);
  });
}

export interface TerminalExecutionRequest {
  tabId: string;
  command: string;
  resourceId?: string;
  source: WorkspaceAction["source"];
  title?: string;
  description?: string;
  waitForBlock?: boolean;
}

export interface TerminalExecutionResult {
  action: WorkspaceAction;
  block?: TerminalBlock;
}

function isStaleDefaultCwd(cwd: string): boolean {
  const trimmed = cwd.trim();
  return trimmed === "~/workspace" || trimmed === "~/workspace/";
}

function isConcreteSessionCwd(cwd: string): boolean {
  const trimmed = cwd.trim();
  if (!trimmed) return false;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith("/") && trimmed !== "/") return true;
  return false;
}

async function waitForConcreteSessionCwd(sessionId: string, maxWaitMs = 3000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const cwd = resolveSessionCwd(sessionId);
    if (isConcreteSessionCwd(cwd)) return cwd;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return resolveSessionCwd(sessionId);
}

function resolveSessionCwd(tabId: string): string {
  const state = useTerminalStore.getState();
  const tab = state.tabs.find((item) => item.id === tabId);
  const pane = state.embeddedPanes[tabId];
  const cwd = (pane?.cwd || tab?.session.cwd || "").trim();
  if (isStaleDefaultCwd(cwd)) return "~";
  return cwd;
}

function sessionIsPowerShell(sessionId: string): boolean {
  const pane = findTerminalPane(sessionId);
  const kind = pane?.shellSpec?.kind;
  if (kind === "powershell" || kind === "powershell5") return true;
  return /powershell|pwsh/i.test(pane?.shellLabel ?? "");
}

function watchLooksUnfinished(sessionId: string, command: string): boolean {
  const text = getOutputWatchText(sessionId);
  if (!text.trim()) return true;
  if (looksLikePowerShellProgressText(text)) return true;
  if (sessionIsPowerShell(sessionId) && !watchHasTrailingPowerShellPrompt(text)) {
    return true;
  }
  return (
    isEchoOnlyTerminalOutput(text, command) ||
    isLikelyCommandEchoAsOutput(text, command)
  );
}

function buildSyntheticBlock(
  sessionId: string,
  command: string,
  cwd: string,
  output: string,
  exitCode: number | null = 0,
  status: TerminalBlock["status"] = "completed",
): TerminalBlock {
  return {
    id: `syn-${Date.now()}`,
    sessionId,
    command,
    output,
    exitCode,
    startLine: -1,
    endLine: -1,
    marker: null,
    cwd,
    timestamp: Date.now(),
    status,
  };
}

function findLatestMeaningfulBlock(
  sessionId: string,
  command: string,
  excludeIds?: Set<string>,
): TerminalBlock | null {
  const blocks = useBlocksStore.getState().getBlocks(sessionId);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (excludeIds?.has(block.id)) continue;
    if (block.status === "running" && block.output.trim().length === 0) continue;
    if (!isMeaningfulTerminalBlock(block, command)) continue;
    return block;
  }
  return null;
}

export function getOutputWatchText(sessionId: string): string {
  return outputWatches.get(sessionId)?.output ?? "";
}

function finishOutputWatch(sessionId: string): void {
  const watch = outputWatches.get(sessionId);
  if (!watch) return;

  if (watch.profileKind === "progress") {
    const captureId = feedCaptures.get(sessionId);
    if (captureId) {
      const block = useBlocksStore.getState().findBlockById(captureId);
      if (block?.status === "running") {
        if (watch.idleTimer) clearTimeout(watch.idleTimer);
        watch.idleTimer = setTimeout(
          () => finishOutputWatch(sessionId),
          watch.outputIdleMs,
        );
        return;
      }
    }
  }

  const cleaned = extractCommandOutput(watch.output, watch.command);
  if (
    looksLikePowerShellProgressText(watch.output) ||
    (sessionIsPowerShell(sessionId) &&
      !watchHasTrailingPowerShellPrompt(watch.output)) ||
    isEchoOnlyTerminalOutput(watch.output, watch.command) ||
    isLikelyCommandEchoAsOutput(watch.output, watch.command) ||
    (cleaned.length > 0 &&
      (isEchoOnlyTerminalOutput(cleaned, watch.command) ||
        isLikelyCommandEchoAsOutput(cleaned, watch.command)))
  ) {
    if (watch.idleTimer) clearTimeout(watch.idleTimer);
    watch.idleTimer = setTimeout(() => finishOutputWatch(sessionId), watch.outputIdleMs);
    return;
  }
  if (watch.idleTimer) clearTimeout(watch.idleTimer);
  clearTimeout(watch.hardTimer);
  outputWatches.delete(sessionId);
  const output = cleaned || watch.output.trim();
  if (
    output &&
    !isEchoOnlyTerminalOutput(output, watch.command) &&
    !isLikelyCommandEchoAsOutput(output, watch.command)
  ) {
    watch.resolve(
      buildSyntheticBlock(sessionId, watch.command, watch.cwd, output),
    );
    return;
  }
  const fallback = findLatestMeaningfulBlock(sessionId, watch.command);
  if (fallback) {
    watch.resolve(fallback);
    return;
  }
  watch.resolve(
    buildSyntheticBlock(sessionId, watch.command, watch.cwd, "", 0),
  );
}

function scheduleOutputIdle(sessionId: string): void {
  const watch = outputWatches.get(sessionId);
  if (!watch || !watch.sawOutput) return;
  if (watch.idleTimer) clearTimeout(watch.idleTimer);
  watch.idleTimer = setTimeout(() => finishOutputWatch(sessionId), watch.outputIdleMs);
}

function startOutputWatch(
  sessionId: string,
  command: string,
  options?: WaitForCommandOptions,
): Promise<TerminalBlock> {
  clearOutputWatch(sessionId);
  const cwd = resolveSessionCwd(sessionId);
  const timeoutMs = options?.timeoutMs ?? BLOCK_WAIT_TIMEOUT_MS;
  const outputIdleMs = options?.outputIdleMs ?? OUTPUT_IDLE_MS;
  return new Promise<TerminalBlock>((resolve, reject) => {
    const watch: OutputWatch = {
      command,
      cwd,
      output: "",
      sawOutput: false,
      outputIdleMs,
      profileKind: options?.profileKind,
      idleTimer: null,
      hardTimer: setTimeout(() => {
        clearOutputWatch(sessionId);
        reject(new Error("等待命令输出超时"));
      }, timeoutMs),
      resolve,
      reject,
    };
    outputWatches.set(sessionId, watch);
  });
}

/** 终端输出流回调：采集命令输出到 output watch */
export function feedTerminalOutputForWatch(sessionId: string, chunk: string): void {
  const watch = outputWatches.get(sessionId);
  if (!watch || !chunk) return;
  watch.output += chunk;
  watch.sawOutput = true;
  scheduleOutputIdle(sessionId);
}

function mergeCommandResults(
  sessionId: string,
  command: string,
  outputBlock: TerminalBlock,
  oscBlock: TerminalBlock | null,
): TerminalBlock {
  const cwd =
    oscBlock?.cwd?.trim() ||
    outputBlock.cwd?.trim() ||
    resolveSessionCwd(sessionId);
  const oscOutput = oscBlock?.output.trim() ?? "";
  const cleanedWatch = extractCommandOutput(outputBlock.output, command);
  const output = oscOutput || cleanedWatch || outputBlock.output.trim();
  const blockCommand =
    (oscBlock?.command ?? "").trim().replace(/^[^#$>]*[$#>]\s*/, "") || command;
  const exitCode = oscBlock?.exitCode ?? outputBlock.exitCode ?? 0;
  const status = oscBlock?.status ?? outputBlock.status;

  if (oscBlock) {
    return {
      ...oscBlock,
      command: blockCommand,
      output,
      exitCode,
      status,
      cwd,
    };
  }

  return buildSyntheticBlock(sessionId, blockCommand, cwd, output, exitCode, status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function capOscWait(
  sessionId: string,
  command: string,
  timeoutMs = OSC_WAIT_CAP_MS,
): Promise<TerminalBlock | null> {
  return Promise.race([
    waitForMeaningfulBlock(sessionId, command, timeoutMs),
    sleep(timeoutMs).then(() => null),
  ]).catch(() => null);
}

export async function waitForCommandResult(
  sessionId: string,
  command: string,
  options?: WaitForCommandOptions,
): Promise<TerminalBlock> {
  const outputIdleMs = options?.outputIdleMs ?? OUTPUT_IDLE_MS;
  const timeoutMs = options?.timeoutMs ?? BLOCK_WAIT_TIMEOUT_MS;
  const outputPromise = startOutputWatch(sessionId, command, options);
  const oscPromise = capOscWait(sessionId, command);

  const first = await Promise.race([
    outputPromise.then((block) => ({ kind: "out" as const, block })),
    oscPromise.then((block) => ({ kind: "osc" as const, block })),
  ]);

  const watchUnfinished = (): boolean => watchLooksUnfinished(sessionId, command);

  let outputBlock: TerminalBlock | null = first.kind === "out" ? first.block : null;
  let oscBlock: TerminalBlock | null = first.kind === "osc" ? first.block : null;

  if (first.kind === "osc" && watchUnfinished()) {
    // OSC 可能是旧 prompt / 第一条语句结束；进度条或半截回显时继续等真实结束。
    // 不能空等满 timeout（AI batch 15s）——SSH 上 command not found 早已出来。
    const unfinishedWaitMs = Math.min(timeoutMs, Math.max(800, outputIdleMs * 2));
    outputBlock = await Promise.race([
      outputPromise.catch(() => null),
      sleep(unfinishedWaitMs).then(() => null),
    ]);
  } else if (!outputBlock) {
    const settleMs = outputIdleMs + MERGE_WINDOW_MS;
    outputBlock = await Promise.race([
      outputPromise.catch(() => null),
      sleep(settleMs).then(() => null),
    ]);
  }
  if (!oscBlock) {
    oscBlock = await Promise.race([
      oscPromise,
      sleep(MERGE_WINDOW_MS).then(() => null),
    ]);
  }

  const resolvedOutput =
    outputBlock ??
    findLatestMeaningfulBlock(sessionId, command) ??
    buildSyntheticBlock(sessionId, command, resolveSessionCwd(sessionId), "", 0);

  return mergeCommandResults(sessionId, command, resolvedOutput, oscBlock);
}

/**
 * 通过 actionStore 登记并执行终端命令。
 * 人工手动执行不走审批（用户已主动发起）；
 * AI 命令审批在 toolGate / inlineToolBridge / internalToolBridge，此处不再二次拦截。
 */
export function requestTerminalExecution(
  request: TerminalExecutionRequest,
): TerminalExecutionResult | Promise<TerminalExecutionResult> {
  const action = useActionStore.getState().enqueueAction(
    {
      type: "terminal",
      title: request.title ?? "终端命令",
      description: request.description ?? request.command,
      command: request.command,
      resourceId: request.resourceId,
      source: request.source,
    },
    { deferRun: true, requireApproval: false },
  );

  if (request.waitForBlock) {
    return new Promise<TerminalExecutionResult>((resolve, reject) => {
      pendingExecutions.set(action.id, {
        tabId: request.tabId,
        command: request.command,
        source: request.source,
        waitForBlock: true,
        resolveBlock: (block) => resolve({ action, block }),
        rejectBlock: reject,
      });

      // 必须先挂上 resolve/reject，再 runAction；否则 sender 缺失时 reject 会空跑
      if (action.status !== "blocked") {
        useActionStore.getState().runAction(action.id);
      }
    });
  }

  pendingExecutions.set(action.id, {
    tabId: request.tabId,
    command: request.command,
    source: request.source,
    waitForBlock: false,
  });

  if (action.status !== "blocked") {
    useActionStore.getState().runAction(action.id);
  }

  return { action };
}

/** actionStore.runAction 在 terminal 类型时调用 */
export function executeTerminalAction(action: WorkspaceAction): boolean {
  const pending = pendingExecutions.get(action.id);
  if (!pending) return false;

  const sender = terminalPaneSenders[pending.tabId];
  if (!sender) {
    // 必须拒绝 waitForBlock Promise，否则 AI 工具链会永久挂起
    pending.rejectBlock?.(
      new Error(`终端会话 ${pending.tabId} 未就绪（无输入通道），请打开对应终端页后再试`),
    );
    pendingExecutions.delete(action.id);
    return false;
  }

  const run = async () => {
    const displayCommand = maybeAppendAutoLsToCommand(pending.command, pending.tabId);
    const isAiSource = pending.source === "AI";

    if (isAiSource) {
      await prepareShellForAiTool(pending.tabId);
    }

    if (pending.waitForBlock) {
      const profile = isAiSource
        ? resolveCommandProfile(pending.command, "AI")
        : resolveCommandProfile(pending.command, "用户");
      const waitOptions = {
        timeoutMs: profile.timeoutMs,
        outputIdleMs: profile.outputIdleMs,
        profileKind: profile.kind,
      };
      let captureBlockId: string | undefined;
      const shouldPersistShellBlock = isAiSource || isWarpDisplay(pending.tabId);
      if (shouldPersistShellBlock) {
        captureBlockId = armFeedCapture(pending.tabId, displayCommand);
        // beginAiToolRun 只服务命令栏（压住 live xterm）。直通 PTY 就是主画面，
        // 切 run-state 会把门闩/收尾搅乱，SSH 卡片更容易脱锚。
        if (isAiSource && isWarpDisplay(pending.tabId)) {
          useTerminalRunStateStore.getState().beginAiToolRun(pending.tabId, {
            blockId: captureBlockId,
            command: displayCommand,
          });
        }
      }
      const resultPromise = waitForCommandResult(
        pending.tabId,
        displayCommand,
        waitOptions,
      );
      sender(displayCommand);
      try {
        const block = await resultPromise;
        const watchText = getOutputWatchText(pending.tabId);
        const mergedBlock =
          watchText.trim() && block.output.trim().length < watchText.trim().length
            ? { ...block, output: watchText }
            : block;
        const stored = shouldPersistShellBlock
          ? ensureShellBlockInStore(pending.tabId, mergedBlock)
          : mergedBlock;
        pending.resolveBlock?.(stored);
      } catch (err) {
        pending.rejectBlock?.(err instanceof Error ? err : new Error(String(err)));
      } finally {
        clearOutputWatch(pending.tabId);
        releaseFeedCapture(pending.tabId);
        pendingExecutions.delete(action.id);
        if (isAiSource) {
          useTerminalRunStateStore.getState().returnToPrompt(pending.tabId);
          await recoverShellAfterAiTool(pending.tabId);
        }
      }
      return;
    }

    if (isWarpDisplay(pending.tabId)) {
      const blockId = armFeedCapture(pending.tabId, displayCommand);
      if (pending.source === "用户") {
        const profile = resolveCommandProfile(pending.command, "用户");
        useTerminalRunStateStore.getState().beginBlockRun(pending.tabId, {
          blockId,
          command: displayCommand,
        });
        useTerminalUiStore.getState().beginCommandLive(pending.tabId);
        if (profile.kind === "progress") {
          useTerminalRunStateStore.getState().promoteToInlineRun(pending.tabId);
        }
        if (shouldUseFullTerminalForUser(displayCommand)) {
          useTerminalUiStore.getState().enterFullTerminal(pending.tabId, blockId);
          useBlocksStore.getState().updateBlock(blockId, {
            status: "completed",
            exitCode: 0,
            output: FULL_TERMINAL_BLOCK_SUMMARY,
          });
        }
      }
      if (isCdNavigationCommand(pending.command) || isCdNavigationCommand(displayCommand)) {
        scheduleCdBlockFallbackComplete(pending.tabId, blockId);
      }
    }
    sender(displayCommand);
    pendingExecutions.delete(action.id);
    if (isAiSource) {
      await recoverShellAfterAiTool(pending.tabId);
    }
  };

  void enqueueSessionExecution(pending.tabId, () => run());
  return true;
}

export function cancelTerminalExecution(actionId: string): void {
  const pending = pendingExecutions.get(actionId);
  if (pending?.rejectBlock) {
    pending.rejectBlock(new Error("用户已取消"));
  }
  if (pending) {
    clearOutputWatch(pending.tabId);
  }
  pendingExecutions.delete(actionId);
}

/** 等待有实际内容的 OSC 133 block（忽略空 block） */
function waitForMeaningfulBlock(
  sessionId: string,
  command: string,
  timeoutMs = BLOCK_WAIT_TIMEOUT_MS,
): Promise<TerminalBlock> {
  const beforeIds = new Set(
    useBlocksStore.getState().getBlocks(sessionId).map((b) => b.id),
  );

  return new Promise<TerminalBlock>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      unsub();
      reject(new Error("等待命令 block 超时"));
    }, timeoutMs);

    const unsub = useBlocksStore.subscribe((state) => {
      const blocks = state.blocks[sessionId] ?? [];
      const captureBlockId = feedCaptures.get(sessionId);
      if (captureBlockId) {
        const captured = blocks.find((item) => item.id === captureBlockId);
        if (
          captured &&
          captured.status !== "running" &&
          isMeaningfulTerminalBlock(captured, command)
        ) {
          clearTimeout(timer);
          unsub();
          resolve(captured);
          return;
        }
      }

      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        if (beforeIds.has(block.id)) continue;
        if (block.status === "running") return;
        if (!isMeaningfulTerminalBlock(block, command)) continue;
        clearTimeout(timer);
        unsub();
        resolve(block);
        return;
      }
    });
  });
}
