import { useActionStore, type WorkspaceAction } from "../../stores/actionStore";
import { createBlockId, useBlocksStore, type TerminalBlock } from "../../stores/blocksStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { extractCommandOutput, isMeaningfulTerminalBlock, normalizeBlockCommand } from "./terminalOutputText";
import { terminalPaneSenders } from "./terminalPaneSenders";
import { isWarpDisplay } from "./terminalDisplayMode";

const BLOCK_WAIT_TIMEOUT_MS = 60_000;
const OUTPUT_IDLE_MS = 600;
const MERGE_WINDOW_MS = 120;
const OSC_WAIT_CAP_MS = 5_000;

const pendingExecutions = new Map<
  string,
  {
    tabId: string;
    command: string;
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
  idleTimer: ReturnType<typeof setTimeout> | null;
  hardTimer: ReturnType<typeof setTimeout>;
  resolve: (block: TerminalBlock) => void;
  reject: (err: Error) => void;
}

const outputWatches = new Map<string, OutputWatch>();

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

  const blocks = store.getBlocks(sessionId);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const candidate = blocks[i];
    if (candidate.kind === "ai") continue;
    if (candidate.status === "running" && candidate.command.trim() === block.command.trim()) {
      store.updateBlock(candidate.id, {
        output: block.output || candidate.output,
        exitCode: block.exitCode,
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

function armFeedCapture(sessionId: string, command: string): string {
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
  });

  return blockId;
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

function resolveSessionCwd(tabId: string): string {
  const tab = useTerminalStore.getState().tabs.find((item) => item.id === tabId);
  return tab?.session.cwd ?? "";
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

function finishOutputWatch(sessionId: string): void {
  const watch = outputWatches.get(sessionId);
  if (!watch) return;
  if (watch.idleTimer) clearTimeout(watch.idleTimer);
  clearTimeout(watch.hardTimer);
  outputWatches.delete(sessionId);
  const cleaned = extractCommandOutput(watch.output, watch.command);
  const output = cleaned || watch.output.trim();
  if (output) {
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
  watch.idleTimer = setTimeout(() => finishOutputWatch(sessionId), OUTPUT_IDLE_MS);
}

function startOutputWatch(sessionId: string, command: string): Promise<TerminalBlock> {
  clearOutputWatch(sessionId);
  const cwd = resolveSessionCwd(sessionId);
  return new Promise<TerminalBlock>((resolve, reject) => {
    const watch: OutputWatch = {
      command,
      cwd,
      output: "",
      sawOutput: false,
      idleTimer: null,
      hardTimer: setTimeout(() => {
        clearOutputWatch(sessionId);
        reject(new Error("等待命令输出超时"));
      }, BLOCK_WAIT_TIMEOUT_MS),
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

async function waitForCommandResult(
  sessionId: string,
  command: string,
): Promise<TerminalBlock> {
  const outputPromise = startOutputWatch(sessionId, command);
  const oscPromise = capOscWait(sessionId, command);

  await Promise.race([outputPromise, oscPromise]);

  const settleMs = OUTPUT_IDLE_MS + MERGE_WINDOW_MS;
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
  const action = useActionStore.getState().enqueueAction(
    {
      type: "terminal",
      title: request.title ?? "终端命令",
      description: request.description ?? request.command,
      command: request.command,
      resourceId: request.resourceId,
      source: request.source,
    },
    { deferRun: true },
  );

  pendingExecutions.set(action.id, {
    tabId: request.tabId,
    command: request.command,
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

  if (pending.waitForBlock) {
    const resultPromise = waitForCommandResult(pending.tabId, pending.command);
    sender(pending.command);
    void resultPromise
      .then((block) => {
        const stored = isWarpDisplay(pending.tabId)
          ? ensureShellBlockInStore(pending.tabId, block)
          : block;
        pending.resolveBlock?.(stored);
      })
      .catch((err) => {
        pending.rejectBlock?.(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        clearOutputWatch(pending.tabId);
        pendingExecutions.delete(action.id);
      });
  } else {
    if (isWarpDisplay(pending.tabId)) {
      armFeedCapture(pending.tabId, pending.command);
    }
    sender(pending.command);
    pendingExecutions.delete(action.id);
  }

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
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        if (beforeIds.has(block.id)) continue;
        if (block.status === "running" && block.output.trim().length === 0) return;
        if (!isMeaningfulTerminalBlock(block, command)) continue;
        clearTimeout(timer);
        unsub();
        resolve(block);
        return;
      }
    });
  });
}

/** @deprecated 仅供测试；生产路径使用 waitForCommandResult */
export function waitForCommandBlock(
  sessionId: string,
  command: string,
  timeoutMs = BLOCK_WAIT_TIMEOUT_MS,
): Promise<TerminalBlock> {
  return waitForMeaningfulBlock(sessionId, command, timeoutMs);
}
