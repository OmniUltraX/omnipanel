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
import { writeTerminalRaw } from "../terminalPaneSenders";
import { markShellPromptReady } from "../terminalShellRecovery";
import { waitForTerminalOutputIdle } from "../terminalOutputTap";
import { getXterm } from "../xtermRegistry";
import {
  archiveActiveInlineCard,
  beginShellAgentCard,
  clearShellAgentGeometry,
  consumeReanchorPtySync,
  getShellAgentGeometry,
  isShellAgentCursorPastPlaceholder,
  prepareShellAgentEcho,
  reanchorShellAgentCard,
  setShellAgentCardKind,
} from "./shellAgentGeometry";
import { useShellAgentStore } from "./shellAgentStore";

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

function lineLooksLikeShellPrompt(line: string): boolean {
  const trimmed = line.replace(/\s+$/u, "");
  if (!trimmed) return false;
  return /[@\w.-]+.*[$#%]\s*$/u.test(trimmed) || /[$#%>]\s*$/u.test(trimmed);
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

/** TEMP-DEBUG: 环事件序列写到 DOM dataset（隔离世界可读），供 E2E 排查 */
function pushShellAgentDebugEvent(fn: string, detail?: string): void {
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
    if (cur?.blockId && settings.terminalShellAgentAutocontinue) {
      store.setPhase(sessionId, "streaming");
      store.bumpTurn(sessionId);
      await submitInlineFollowUp(sessionId, cur.blockId, trimmed, resolveCwd(sessionId));
      return cur.blockId;
    }
    return cur?.blockId ?? null;
  }

  let session = store.get(sessionId);
  if (!session || session.phase === "cancelled" || !session.blockId) {
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
  // 归档当前流内 final 卡再开新会话
  archiveActiveInlineCard(sessionId);
  useShellAgentStore.getState().newAgentThread(sessionId);
  clearShellAgentGeometry(sessionId);
  clearPromptReleaseGuard(sessionId);
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
 * 续轮：命令输出后重锚流内 thinking 卡；用户正在 prompt 打字则跳过本次重锚。
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

  if (getEnterGateFlags(sessionId).userTyping) {
    return;
  }

  reanchorShellAgentCard(sessionId, "thinking");
}

/**
 * 工具提案到达：thinking 卡扩为命令卡；无活跃卡则重锚 cmd 卡。
 */
export function notifyShellAgentApprovalPending(sessionId: string): void {
  pushShellAgentDebugEvent("approvalPending");
  useShellAgentStore.getState().setPhase(sessionId, "awaiting_approval");
  const geo = getShellAgentGeometry(sessionId);
  if (geo?.decoration && geo.cardKind === "thinking") {
    setShellAgentCardKind(sessionId, "cmd");
  } else if (!geo?.decoration) {
    reanchorShellAgentCard(sessionId, "cmd");
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
  };

  // 等 PTY 可能迟到的 prompt 落盘，再决定要不要发 \r\n，避免双 prompt
  void waitForTerminalOutputIdle(sessionId, 60, 450).then(() => {
    if (promptReleasedForTurn.get(sessionId) !== turn) return;

    let needPtyEnter = consumeReanchorPtySync(sessionId);
    try {
      const term = getXterm(sessionId);
      if (term) {
        const buf = term.buffer.active;
        const line = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "";
        // 当前行已是可输入 prompt → 禁止再发（否则双 prompt + 两次回车）
        if (lineLooksLikeShellPrompt(line)) {
          needPtyEnter = false;
        }
      }
    } catch {
      // ignore
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
  if (!cur || cur.phase === "cancelled") return;
  if (hasPendingShellTool(sessionId)) {
    pushShellAgentDebugEvent("turnFinished deferred", "pending tool");
    useShellAgentStore.getState().setPhase(sessionId, "awaiting_approval");
    return;
  }

  const geo = getShellAgentGeometry(sessionId);
  const past = isShellAgentCursorPastPlaceholder(sessionId);

  // 命令输出已在卡下方：原地改 final 会盖住输出 → 重锚到当前行（盖住已有 prompt，避免上方残留）
  if (geo?.decoration && past && geo.cardKind === "cmd") {
    reanchorShellAgentCard(sessionId, "final", () => scheduleTurnFinishFallback(sessionId));
    return;
  }

  // 续轮已重锚过 thinking：只切 final，禁止再重锚（否则双 prompt）
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
  beginShellAgentCard(sessionId, { kind: "thinking", ...opts });
}
