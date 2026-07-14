import { useActionStore, type WorkspaceAction } from "../../stores/actionStore";
import { createBlockId, useBlocksStore, type TerminalBlock } from "../../stores/blocksStore";
import { useTerminalStore } from "../../stores/terminalStore";
import {
  extractCommandOutput,
  isEchoOnlyTerminalOutput,
  isLikelyCommandEchoAsOutput,
  isMeaningfulTerminalBlock,
  normalizeBlockCommand,
} from "./terminalOutputText";
import { terminalPaneSenders } from "./terminalPaneSenders";
import { isWarpDisplay } from "./terminalDisplayMode";
import {
  prepareShellForAiTool,
  recoverShellAfterAiTool,
} from "./terminalShellRecovery";
import { maybeAppendAutoLsToCommand, scheduleCdBlockFallbackComplete } from "./terminalAutoLs";
import { isCdNavigationCommand } from "./terminalAutoLsPolicy";
import { resolveTerminalApprovalMode } from "./terminalApprovalSettings";
import { shouldRequireTerminalApproval } from "./terminalApprovalPolicy";
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

function enqueueSessionExecution(
  sessionId: string,
  task: () => Promise<void>,
): Promise<void> {
  const previous = sessionExecutionChains.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
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
    !cleaned &&
    (isEchoOnlyTerminalOutput(watch.output, watch.command) ||
      isLikelyCommandEchoAsOutput(watch.output, watch.command))
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
  const outputPromise = startOutputWatch(sessionId, command, options);
  const oscPromise = capOscWait(sessionId, command);

  await Promise.race([outputPromise, oscPromise]);

  const settleMs = outputIdleMs + MERGE_WINDOW_MS;
  const [outputBlock, oscBlock] = await Promise.all([
    Promise.race([
      outputPromise.catch(() => null),
      sleep(settleMs).then(() => null as TerminalBlock | null),
    ]),
    Promise.race([
      oscPromise,
      sleep(MERGE_WINDOW_MS).then(() => null as TerminalBlock | null),
    ]),
  ]);

  const resolvedOutput =
    outputBlock ??
    findLatestMeaningfulBlock(sessionId, command) ??
    buildSyntheticBlock(sessionId, command, resolveSessionCwd(sessionId), "", 0);

  return mergeCommandResults(sessionId, command, resolvedOutput, oscBlock);
}

/** 通过 actionStore 审批链执行终端命令，确认后才写入 PTY/SSH */
export function requestTerminalExecution(
  request: TerminalExecutionRequest,
): TerminalExecutionResult | Promise<TerminalExecutionResult> {
  const approvalMode = resolveTerminalApprovalMode(request.tabId);
  const requireApproval =
    request.source === "用户"
      ? shouldRequireTerminalApproval(request.command, approvalMode)
      : false;

  const action = useActionStore.getState().enqueueAction(
    {
      type: "terminal",
      title: request.title ?? "终端命令",
      description: request.description ?? request.command,
      command: request.command,
      resourceId: request.resourceId,
      source: request.source,
    },
    { deferRun: true, requireApproval },
  );

  pendingExecutions.set(action.id, {
    tabId: request.tabId,
    command: request.command,
    source: request.source,
    waitForBlock: request.waitForBlock,
  });

  if (action.status !== "blocked") {
    useActionStore.getState().runAction(action.id);
  }

  if (request.waitForBlock) {
    return new Promise<TerminalExecutionResult>((resolve, reject) => {
      const entry = pendingExecutions.get(action.id);
      if (!entry) {
        reject(new Error("终端执行登记失败"));
        return;
      }
      entry.resolveBlock = (block) => resolve({ action, block });
      entry.rejectBlock = reject;
    });
  }

  return { action };
}

/** actionStore.runAction 在 terminal 类型时调用 */
export function executeTerminalAction(action: WorkspaceAction): boolean {
  const pending = pendingExecutions.get(action.id);
  if (!pending) return false;

  const sender = terminalPaneSenders[pending.tabId];
  if (!sender) return false;

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
      if (isWarpDisplay(pending.tabId)) {
        captureBlockId = armFeedCapture(pending.tabId, displayCommand);
        if (isAiSource) {
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
        const stored = isWarpDisplay(pending.tabId)
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
