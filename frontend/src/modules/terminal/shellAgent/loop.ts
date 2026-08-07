import { findTerminalPane } from "../../../stores/terminalStore";
import {
  isAiThreadToolCall,
  useBlocksStore,
} from "../../../stores/blocksStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import {
  cancelInlineAiBlock,
  submitInlineFollowUp,
  submitInlineNaturalLanguage,
} from "../warpInlineAi";
import { cancelPendingInlineTools } from "../inlineToolBridge";
import { isInlineTerminalToolName } from "../inlineTerminalTool";
import { getEnterGateFlags, patchEnterGateFlags } from "../passthroughAi/enterGates";
import { schedulePassthroughPromptHintSync } from "../passthroughAi/passthroughPromptHint";
import { writeTerminalRaw } from "../terminalPaneSenders";
import { markShellPromptReady } from "../terminalShellRecovery";
import { waitForTerminalOutputIdle } from "../terminalOutputTap";
import { getXterm } from "../xtermRegistry";
import { useTerminalUiStore } from "../terminalUiStore";
import {
  archiveActiveInlineCard,
  beginShellAgentCard,
  clearShellAgentGeometry,
  consumeReanchorPtySync,
  getShellAgentGeometry,
  isShellAgentCursorPastPlaceholder,
  markShellAgentNeedsPromptSync,
  prepareShellAgentEcho,
  reanchorShellAgentCard,
  setShellAgentCardKind,
  type ShellAgentCardKind,
} from "./shellAgentGeometry";
import { useShellAgentStore } from "./shellAgentStore";
import {
  clearShellAgentLastCmd,
  clearShellAgentThinkingFull,
  markShellAgentConfirmFreeze,
} from "./thinkingCache";

/**
 * 方案 C：直通 AI 表现层（decoration / 占位 / 内存态）随 xterm 易失；
 * 可持久时间线只走命令栏 Block（blocksStore + terminalHistorySync）。
 * remount / restore 时必须同步拆掉 UI 态，禁止用持久化 aiThread 重建流内卡。
 */
export function teardownShellAgentUi(sessionId: string): void {
  clearShellAgentGeometry(sessionId);
  useShellAgentStore.getState().clear(sessionId);
  clearShellAgentThinkingFull(sessionId);
  clearShellAgentLastCmd(sessionId);
  clearPromptReleaseGuard(sessionId);
  pendingReanchorKind.delete(sessionId);
  pendingTurnFinish.delete(sessionId);
  const timer = turnFinishFallbackTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    turnFinishFallbackTimers.delete(sessionId);
  }
  patchEnterGateFlags(sessionId, { agentExecuting: false });
}

/** userTyping 时跳过的续轮重锚，打字结束后补一次 */
const pendingReanchorKind = new Map<string, ShellAgentCardKind>();

/** 等待 final 卡自适应高度完成后再归还 prompt */
const pendingTurnFinish = new Set<string>();
const turnFinishFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleTurnFinishFallback(sessionId: string): void {
  pendingTurnFinish.add(sessionId);
  const prevTimer = turnFinishFallbackTimers.get(sessionId);
  if (prevTimer) clearTimeout(prevTimer);
  turnFinishFallbackTimers.set(
    sessionId,
    setTimeout(() => {
      turnFinishFallbackTimers.delete(sessionId);
      if (pendingTurnFinish.has(sessionId)) {
        pendingTurnFinish.delete(sessionId);
        releaseShellAgentToPrompt(sessionId);
      }
    }, 800),
  );
}

/** 收紧：避免任意以 `>` 结尾的输出被当成 prompt */
function lineLooksLikeShellPrompt(line: string): boolean {
  const trimmed = line.replace(/\s+$/u, "");
  if (!trimmed) return false;
  if (/\S+@\S+.*[$#%]\s*$/u.test(trimmed)) return true;
  if (/^[$#%]\s*$/u.test(trimmed)) return true;
  if (/PS\s+\S+>\s*$/u.test(trimmed)) return true;
  if (/[$#%]\s*$/u.test(trimmed) && trimmed.length <= 120) return true;
  return false;
}

/** 光标行及以下是否已有可输入 prompt（仅看可见区，不扫被卡片盖住的上方） */
function bufferHasPromptAtOrBelowCursor(sessionId: string): boolean {
  try {
    const term = getXterm(sessionId);
    if (!term) return false;
    const buf = term.buffer.active;
    const cursorAbs = buf.baseY + buf.cursorY;
    for (let y = cursorAbs; y <= cursorAbs + 3 && y < buf.length; y += 1) {
      const line = buf.getLine(y)?.translateToString(true) ?? "";
      if (lineLooksLikeShellPrompt(line)) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/** 清掉远端当前输入行（bash/zsh: Ctrl+A Ctrl+K；PowerShell: Escape） */
export function clearRemoteInputLine(sessionId: string): void {
  const label = (findTerminalPane(sessionId)?.shellLabel ?? "").toLowerCase();
  if (/powershell|pwsh/.test(label)) {
    writeTerminalRaw(sessionId, "\x1b");
    return;
  }
  writeTerminalRaw(sessionId, "\x01");
  writeTerminalRaw(sessionId, "\x0b");
  writeTerminalRaw(sessionId, "\x15");
  markShellPromptReady(sessionId);
}

export function clearRemoteInputLineBeforeExec(sessionId: string): void {
  clearRemoteInputLine(sessionId);
  markShellPromptReady(sessionId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * 审批通过后的执行前序列（方案 C 纪律）：
 * 1. **不撤流内卡**（approve 不改几何；卡片切「已同意」态，继续盖住占位行）
 * 2. 仅当用户有残留输入才清行，并等回显静默
 * 3. 占位区下方写灰字「已同意」+ prompt 前缀 → 注入命令 echo
 */
export async function prepareShellAgentExecution(
  sessionId: string,
  command: string,
): Promise<void> {
  const agent = useShellAgentStore.getState().get(sessionId);
  const agentActive = Boolean(agent) && agent!.phase !== "cancelled";
  if (!agentActive) {
    clearRemoteInputLineBeforeExec(sessionId);
    await sleep(60);
    return;
  }
  if (getEnterGateFlags(sessionId).userTyping) {
    clearRemoteInputLineBeforeExec(sessionId);
    await waitForTerminalOutputIdle(sessionId, 50, 500);
  }
  prepareShellAgentEcho(sessionId, command);
}

function resolveCwd(sessionId: string): string {
  return findTerminalPane(sessionId)?.cwd ?? "";
}

function pushShellAgentDebugEvent(fn: string, detail?: string): void {
  if (!import.meta.env.DEV) return;
  try {
    const el = document.body;
    if (!el) return;
    const list = JSON.parse(el.dataset.shellAgentEvents ?? "[]") as unknown[];
    list.push({ t: Date.now(), fn, detail: detail ?? null });
    if (list.length > 50) list.shift();
    el.dataset.shellAgentEvents = JSON.stringify(list);
  } catch {
    // ignore
  }
}

/**
 * 直通 NL 入环。
 * 数据链路复用 inline AI（blocksStore aiThread + 后端 conversation 续轮）；
 * 表现层由本模块 phase 驱动几何（见 notify*）。
 */
export async function startOrContinueShellAgent(
  sessionId: string,
  userText: string,
): Promise<string | null> {
  const trimmed = userText.trim();
  if (!trimmed) return null;

  const settings = useSettingsStore.getState();
  if (!settings.terminalPassthroughAiEnter) return null;

  const store = useShellAgentStore.getState();
  if (store.isBusy(sessionId)) {
    const cur = store.get(sessionId);
    // 忙时追问：已清行+画蓝字，禁止静默丢输入；始终 follow-up
    if (cur?.blockId) {
      store.setPhase(sessionId, "streaming");
      store.bumpTurn(sessionId);
      await submitInlineFollowUp(sessionId, cur.blockId, trimmed, resolveCwd(sessionId));
      return cur.blockId;
    }
    // busy 但无 blockId：多半刚锚了 thinking 卡、请求还没发出，继续走新建，勿 return null 卡死
  }

  let session = store.get(sessionId);
  // cancelled 后勿 ensure() 拿回僵尸对象（旧 turn/blockId）；开干净 thread
  if (session?.phase === "cancelled") {
    session = store.newAgentThread(sessionId);
  } else if (!session || !session.blockId) {
    session = store.ensure(sessionId);
  }

  const existingBlock = session.blockId
    ? useBlocksStore.getState().findBlockById(session.blockId)
    : null;

  const canContinue =
    Boolean(existingBlock) &&
    existingBlock?.kind === "ai" &&
    existingBlock.status !== "failed" &&
    session.turn > 0 &&
    session.turn < session.maxTurns;

  store.setPhase(sessionId, "streaming");
  store.bumpTurn(sessionId);
  patchEnterGateFlags(sessionId, { agentExecuting: false });

  if (canContinue && session.blockId) {
    await submitInlineFollowUp(
      sessionId,
      session.blockId,
      trimmed,
      resolveCwd(sessionId),
    );
    return session.blockId;
  }

  const blockId = await submitInlineNaturalLanguage(
    sessionId,
    trimmed,
    resolveCwd(sessionId),
  );
  store.setBlockId(sessionId, blockId);
  return blockId;
}

export function cancelShellAgent(sessionId: string): void {
  const cur = useShellAgentStore.getState().get(sessionId);
  if (cur?.blockId) {
    cancelInlineAiBlock(sessionId, cur.blockId);
    cancelPendingInlineTools(cur.blockId);
  } else {
    cancelPendingInlineTools();
  }
  useShellAgentStore.getState().cancel(sessionId);
  clearShellAgentGeometry(sessionId);
  clearPromptReleaseGuard(sessionId);
  pendingReanchorKind.delete(sessionId);
  pendingTurnFinish.delete(sessionId);
  const timer = turnFinishFallbackTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    turnFinishFallbackTimers.delete(sessionId);
  }
  patchEnterGateFlags(sessionId, { agentExecuting: false });
}

export function newShellAgentSession(sessionId: string): void {
  const cur = useShellAgentStore.getState().get(sessionId);
  if (cur?.blockId) {
    cancelInlineAiBlock(sessionId, cur.blockId);
    cancelPendingInlineTools(cur.blockId);
  }
  // 冻结当前流内卡进 scrollback；开新 thread，但保留已归档 decoration（勿 clearShellAgentGeometry）
  archiveActiveInlineCard(sessionId);
  useShellAgentStore.getState().newAgentThread(sessionId);
  clearPromptReleaseGuard(sessionId);
  pendingReanchorKind.delete(sessionId);
  pendingTurnFinish.delete(sessionId);
  const timer = turnFinishFallbackTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    turnFinishFallbackTimers.delete(sessionId);
  }
  patchEnterGateFlags(sessionId, { agentExecuting: false });
}

/**
 * 模型开始（续）输出。
 * 首轮：入口已建好流内 thinking 卡。
 * 续轮（命令执行后）：尽早切到 final 卡，让解读正文流式出现，而不是等 turnFinished 一次性甩出。
 */
export function notifyShellAgentStreaming(sessionId: string): void {
  const store = useShellAgentStore.getState();
  const prev = store.get(sessionId);
  const wasAfterExec =
    prev?.phase === "observing" ||
    prev?.phase === "executing" ||
    prev?.phase === "awaiting_approval";
  pushShellAgentDebugEvent("streaming", `prev=${prev?.phase ?? "none"}`);
  store.setPhase(sessionId, "streaming");

  if (!wasAfterExec) return;

  // 打字中：记下待重锚 final，结束后由 flush 处理
  if (getEnterGateFlags(sessionId).userTyping) {
    pendingReanchorKind.set(sessionId, "final");
    return;
  }

  const geo = getShellAgentGeometry(sessionId);
  if (!geo?.decoration) {
    reanchorShellAgentCard(sessionId, "final");
    return;
  }
  if (geo.cardKind === "final") return;

  // 续轮解读：统一重锚 final（便于占位扩高 + 流式），勿原地 setKind 导致高度锁死裁切
  reanchorShellAgentCard(sessionId, "final");
}

/** userTyping 清除后调用：补做跳过的续轮重锚 */
export function flushPendingShellAgentReanchor(sessionId: string): void {
  const kind = pendingReanchorKind.get(sessionId);
  if (!kind) return;
  if (getEnterGateFlags(sessionId).userTyping) return;
  const agent = useShellAgentStore.getState().get(sessionId);
  if (!agent || agent.phase === "cancelled" || agent.phase === "idle") {
    pendingReanchorKind.delete(sessionId);
    return;
  }
  pendingReanchorKind.delete(sessionId);
  reanchorShellAgentCard(sessionId, kind);
}

/**
 * 工具提案到达：thinking 卡封成「思考完成」并重锚为命令卡。
 * 思考→确认统一 reanchor，避免同槽替换后 scrollback 仍留着转圈思考卡。
 */
export function notifyShellAgentApprovalPending(sessionId: string): void {
  pushShellAgentDebugEvent("approvalPending");
  useShellAgentStore.getState().setPhase(sessionId, "awaiting_approval");
  pendingReanchorKind.delete(sessionId);
  const geo = getShellAgentGeometry(sessionId);
  const past = isShellAgentCursorPastPlaceholder(sessionId);
  if (!geo?.decoration || geo.cardKind === "thinking" || past) {
    reanchorShellAgentCard(sessionId, "cmd");
  } else {
    setShellAgentCardKind(sessionId, "cmd");
  }
  try {
    getXterm(sessionId)?.scrollToBottom();
  } catch {
    // ignore
  }
}

export function notifyShellAgentExecuting(sessionId: string, executing: boolean): void {
  pushShellAgentDebugEvent("executing", String(executing));
  patchEnterGateFlags(sessionId, { agentExecuting: executing });
  useShellAgentStore.getState().setPhase(
    sessionId,
    executing ? "executing" : "observing",
  );
  // 同意后：把确认卡封成「已同意」留在 scrollback，再钉矮槽给工具条，避免同槽顶替留空白
  if (executing) {
    const geo = getShellAgentGeometry(sessionId);
    if (geo?.mode === "inline" && geo.cardKind === "cmd" && geo.decoration) {
      markShellAgentConfirmFreeze(sessionId, "agreed");
      reanchorShellAgentCard(sessionId, "cmd", undefined, 2);
    }
  }
}

/** 用户拒绝：冻成「已拒绝」确认卡，立刻归还 prompt，勿再进 streaming/sticky 思考卡 */
export function notifyShellAgentRejected(sessionId: string): void {
  pushShellAgentDebugEvent("rejected", "confirm freeze + release prompt");
  patchEnterGateFlags(sessionId, { agentExecuting: false });
  pendingReanchorKind.delete(sessionId);
  pendingTurnFinish.delete(sessionId);
  const timer = turnFinishFallbackTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    turnFinishFallbackTimers.delete(sessionId);
  }

  const geo = getShellAgentGeometry(sessionId);
  if (geo?.mode === "inline" && geo.cardKind === "cmd" && geo.decoration) {
    markShellAgentConfirmFreeze(sessionId, "rejected");
    archiveActiveInlineCard(sessionId);
  }
  // 拒绝不走 reanchor，需显式标记，否则 release 不会发 \r\n 拉新 prompt
  markShellAgentNeedsPromptSync(sessionId);
  releaseShellAgentToPrompt(sessionId);
}

/** 工具已执行完、正在等模型根据 observation 续写 */
export function notifyShellAgentObserving(sessionId: string): void {
  patchEnterGateFlags(sessionId, { agentExecuting: false });
  useShellAgentStore.getState().setPhase(sessionId, "observing");
}

/**
 * 整轮结束：流内卡定格归档 → 归还 shell prompt。
 */
/** 环 block 上是否仍有待审批/执行中的终端工具（done 提前到达时不得收官） */
function hasPendingShellTool(sessionId: string): boolean {
  const blockId = useShellAgentStore.getState().get(sessionId)?.blockId;
  if (!blockId) return false;
  const block = useBlocksStore.getState().findBlockById(blockId);
  if (!block?.aiThread) return false;
  return block.aiThread.some(
    (item) =>
      isAiThreadToolCall(item) &&
      isInlineTerminalToolName(item.toolName) &&
      (item.status === "pending" || item.status === "running"),
  );
}

/** 每轮只归还 prompt 一次，避免多个 `root@host:~#` 堆叠 */
const promptReleasedForTurn = new Map<string, number>();

/** 环结束：final 卡保留在流内 → 仅在重锚导致本地/PTY 脱节时同步一次 prompt */
function releaseShellAgentToPrompt(sessionId: string): void {
  const agent = useShellAgentStore.getState().get(sessionId);
  const turn = agent?.turn ?? 0;
  if (promptReleasedForTurn.get(sessionId) === turn) {
    useShellAgentStore.getState().setPhase(sessionId, "idle");
    patchEnterGateFlags(sessionId, { agentExecuting: false });
    return;
  }
  promptReleasedForTurn.set(sessionId, turn);

  useShellAgentStore.getState().setPhase(sessionId, "idle");
  patchEnterGateFlags(sessionId, { agentExecuting: false });

  const finishFocus = () => {
    markShellPromptReady(sessionId);
    try {
      const term = getXterm(sessionId);
      term?.scrollToBottom();
      term?.focus();
    } catch {
      // ignore
    }
    schedulePassthroughPromptHintSync(sessionId, {
      enabled: useTerminalUiStore.getState().getInputMode(sessionId) === "interactive",
      lineEmpty: true,
    });
  };

  // 等 PTY 可能迟到的 prompt 落盘，再决定要不要发 \r\n，避免双 prompt
  void waitForTerminalOutputIdle(sessionId, 80, 500).then(() => {
    if (promptReleasedForTurn.get(sessionId) !== turn) return;

    let needPtyEnter = consumeReanchorPtySync(sessionId);
    // 重锚盖住了旧 prompt：需要一次回车拉新行；若光标行及以下已有 prompt 则不再发
    if (needPtyEnter && bufferHasPromptAtOrBelowCursor(sessionId)) {
      needPtyEnter = false;
    }

    if (needPtyEnter) {
      writeTerminalRaw(sessionId, "\r\n");
    }
    finishFocus();
  });
}

function clearPromptReleaseGuard(sessionId: string): void {
  promptReleasedForTurn.delete(sessionId);
}

/** final 卡高度稳定后由 ShellAgentOverlay 回调 */
export function onShellAgentCardFitStable(sessionId: string): void {
  if (!pendingTurnFinish.has(sessionId)) return;
  pendingTurnFinish.delete(sessionId);
  const timer = turnFinishFallbackTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    turnFinishFallbackTimers.delete(sessionId);
  }
  queueMicrotask(() => {
    requestAnimationFrame(() => releaseShellAgentToPrompt(sessionId));
  });
}

export function notifyShellAgentTurnFinished(sessionId: string): void {
  const cur = useShellAgentStore.getState().get(sessionId);
  pushShellAgentDebugEvent("turnFinished", cur?.phase ?? "none");
  // idle：拒绝后已归还 prompt；cancelled：已取消 — 都勿再重锚出思考/结果卡
  if (!cur || cur.phase === "cancelled" || cur.phase === "idle") return;
  if (hasPendingShellTool(sessionId)) {
    pushShellAgentDebugEvent("turnFinished deferred", "pending tool");
    useShellAgentStore.getState().setPhase(sessionId, "awaiting_approval");
    return;
  }

  const geo = getShellAgentGeometry(sessionId);
  const past = isShellAgentCursorPastPlaceholder(sessionId);

  // 仍停在思考卡：封成「思考完成」并重锚 final，避免转圈残留
  if (geo?.decoration && geo.cardKind === "thinking") {
    reanchorShellAgentCard(sessionId, "final", () => scheduleTurnFinishFallback(sessionId));
    return;
  }

  // 命令输出已在卡下方：原地改 final 会盖住输出 → 重锚到当前行
  if (geo?.decoration && past && geo.cardKind === "cmd") {
    reanchorShellAgentCard(sessionId, "final", () => scheduleTurnFinishFallback(sessionId));
    return;
  }

  // 已在 cmd 槽且未越过：只切 final
  if (geo?.decoration && geo.cardKind !== "final") {
    setShellAgentCardKind(sessionId, "final");
    scheduleTurnFinishFallback(sessionId);
    return;
  }

  if (geo?.decoration && geo.cardKind === "final") {
    scheduleTurnFinishFallback(sessionId);
    return;
  }

  queueMicrotask(() => {
    requestAnimationFrame(() => releaseShellAgentToPrompt(sessionId));
  });
}

/** @deprecated 用 notifyShellAgentTurnFinished；保留别名防漏改 */
export function notifyShellAgentIdle(sessionId: string): void {
  notifyShellAgentTurnFinished(sessionId);
}

/** 入口建卡（由 useTerminal 在蓝字问题行绘制回调里调用）：thinking 卡占位 */
export function anchorShellAgentThinkingCard(
  sessionId: string,
  opts: { promptIndentCols: number; promptPrefix: string; query: string },
): void {
  const store = useShellAgentStore.getState();
  store.ensure(sessionId);
  // 不在此处 setPhase(streaming)：会让紧随其后的 startOrContinue 误判 busy
  // 且无 blockId 时直接 return null，界面永久停在「正在理解意图」
  beginShellAgentCard(sessionId, { kind: "thinking", ...opts });
}
