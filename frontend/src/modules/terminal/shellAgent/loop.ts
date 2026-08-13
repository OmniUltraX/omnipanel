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
import { lineLooksLikeShellPrompt } from "../passthroughAi/screenLine";
import { writeTerminalRaw } from "../terminalPaneSenders";
import { markShellPromptReady } from "../terminalShellRecovery";
import { waitForTerminalOutputIdle } from "../terminalOutputTap";
import { getXterm } from "../xtermRegistry";
import { useTerminalUiStore } from "../terminalUiStore";
import {
  archiveActiveInlineCard,
  beginShellAgentCard,
  clearShellAgentGeometry,
  clearReanchorPtySync,
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
  clearShellAgentConfirmFreeze,
  getShellAgentLastCmd,
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

/** 活跃卡占位区下方是否已有可输入的空 prompt */
function bufferHasUsablePromptBelowCard(sessionId: string): boolean {
  try {
    const term = getXterm(sessionId);
    if (!term) return false;
    const buf = term.buffer.active;
    const cursorAbs = buf.baseY + buf.cursorY;
    const geo = getShellAgentGeometry(sessionId);
    const cardEnd =
      geo?.mode === "inline" && geo.anchorLine >= 0
        ? geo.anchorLine + Math.max(1, geo.rows)
        : cursorAbs;
    // 只扫卡底以下，避免把卡内占位/盖住的行误判；也不回退，以免漏判后重复发回车
    const from = Math.max(0, cardEnd);
    const to = buf.length - 1;
    for (let y = from; y <= to; y += 1) {
      const line = buf.getLine(y)?.translateToString(true) ?? "";
      if (lineLooksLikeShellPrompt(line)) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/** 当前会话是否为 PowerShell / pwsh（含 shellSpec） */
export function isPowerShellSession(sessionId: string): boolean {
  const pane = findTerminalPane(sessionId);
  const kind = pane?.shellSpec?.kind;
  if (kind === "powershell" || kind === "powershell5") return true;
  const label = (pane?.shellLabel ?? "").toLowerCase();
  return /powershell|pwsh/.test(label);
}

/**
 * 清掉远端当前输入行。
 * - bash/zsh: Ctrl+A / Ctrl+K / Ctrl+U（原地清空）
 * - PowerShell: **只用 Ctrl+C**。Escape/Backspace/Ctrl+U 会回显成 `^U^C`、Vi 模式残留，
 *   或与本地 decoration 脱节导致 `>>` 续行、光标停在卡片中间。
 *   Ctrl+C 会多一行取消痕迹；由 beginRouteAi 用 `\x1b[A` 把该行改写成蓝字问题，避免「双份输入」。
 */
export function clearRemoteInputLine(
  sessionId: string,
  _opts?: { typedText?: string },
): void {
  if (isPowerShellSession(sessionId)) {
    writeTerminalRaw(sessionId, "\x03");
    markShellPromptReady(sessionId);
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

/** 续轮 final 重锚代数：避免并发 settle 落在过期位置 */
const finalSettleGen = new Map<string, number>();

function cursorOnEmptyShellPrompt(sessionId: string): boolean {
  const term = getXterm(sessionId);
  if (!term?.buffer?.active) return false;
  try {
    const buf = term.buffer.active;
    const line = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "";
    return lineLooksLikeShellPrompt(line);
  } catch {
    return false;
  }
}

/** PowerShell 续行提示 `>>`（绝不能再对其发 Enter，否则越积越多） */
function cursorOnPowerShellContinuation(sessionId: string): boolean {
  const term = getXterm(sessionId);
  if (!term?.buffer?.active) return false;
  try {
    const buf = term.buffer.active;
    const line = (buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "")
      .replace(/\s+$/u, "");
    return /^>>/.test(line);
  } catch {
    return false;
  }
}

/**
 * 光标是否在活跃卡下方的空主提示符上（真正可输入位置）。
 * 仅「行像 PS>」不够——本地 \r\n 脱节时 PTY 仍可能停在卡上。
 */
function cursorBelowActiveCardOnEmptyPrompt(sessionId: string): boolean {
  try {
    const term = getXterm(sessionId);
    if (!term?.buffer?.active || !cursorOnEmptyShellPrompt(sessionId)) return false;
    const geo = getShellAgentGeometry(sessionId);
    if (!geo || geo.mode !== "inline" || geo.anchorLine < 0) return true;
    const cursorAbs = term.buffer.active.baseY + term.buffer.active.cursorY;
    const cardEnd = geo.anchorLine + Math.max(1, geo.rows);
    return cursorAbs >= cardEnd;
  } catch {
    return false;
  }
}

/**
 * 光标是否落在活跃流内卡占位区内。
 */
function cursorInsideActiveCard(sessionId: string): boolean {
  try {
    const term = getXterm(sessionId);
    const geo = getShellAgentGeometry(sessionId);
    if (!term?.buffer?.active || !geo || geo.mode !== "inline" || geo.anchorLine < 0) {
      return false;
    }
    const cursorAbs = term.buffer.active.baseY + term.buffer.active.cursorY;
    const cardEnd = geo.anchorLine + Math.max(1, geo.rows);
    return cursorAbs >= geo.anchorLine && cursorAbs < cardEnd;
  } catch {
    return false;
  }
}

/** 执行开始时卡片底线：final 必须钉在此行之下，避免结果卡插在 Get-Date 回显之上 */
const execOutputFloor = new Map<string, number>();

function snapshotExecOutputFloor(sessionId: string): void {
  try {
    const term = getXterm(sessionId);
    const geo = getShellAgentGeometry(sessionId);
    let floor = 0;
    if (term?.buffer?.active) {
      floor = term.buffer.active.baseY + term.buffer.active.cursorY;
    }
    if (geo && geo.mode === "inline" && geo.anchorLine >= 0) {
      floor = Math.max(floor, geo.anchorLine + Math.max(1, geo.rows));
    }
    // 卡底空 PS> 与卡末行同号时，要求至少再下行才算越过，避免「未执行就钉 final」
    execOutputFloor.set(sessionId, floor);
  } catch {
    // ignore
  }
}

function clearExecOutputFloor(sessionId: string): void {
  execOutputFloor.delete(sessionId);
}

function cursorPastExecOutputFloor(sessionId: string): boolean {
  const floor = execOutputFloor.get(sessionId);
  if (floor == null) return isShellAgentCursorPastPlaceholder(sessionId);
  try {
    const term = getXterm(sessionId);
    if (!term?.buffer?.active) return true;
    const cursorAbs = term.buffer.active.baseY + term.buffer.active.cursorY;
    return cursorAbs > floor;
  } catch {
    return false;
  }
}

/** 从执行底线扫到 buffer 末尾（不限光标）：是否已有命令回显/输出 */
function bufferHasExecEchoFromFloor(sessionId: string): boolean {
  const floor = execOutputFloor.get(sessionId);
  if (floor == null) return true;
  try {
    const term = getXterm(sessionId);
    if (!term?.buffer?.active) return false;
    const buf = term.buffer.active;
    const cmd = (getShellAgentLastCmd(sessionId)?.command ?? "").trim();
    const cmdNeedle = cmd.length > 0 ? cmd.slice(0, Math.min(cmd.length, 48)) : "";
    const end = Math.max(0, buf.length - 1);
    for (let y = floor; y <= end; y += 1) {
      const line = (buf.getLine(y)?.translateToString(true) ?? "").replace(/\s+$/u, "");
      if (!line) continue;
      if (cmdNeedle && line.includes(cmdNeedle)) return true;
      if (lineLooksLikeShellPrompt(line)) continue;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 底线以下最后一行非空内容（含光标下方的回显） */
function findLastContentLineFromFloor(sessionId: string): number | null {
  const floor = execOutputFloor.get(sessionId);
  try {
    const term = getXterm(sessionId);
    if (!term?.buffer?.active) return null;
    const buf = term.buffer.active;
    const from = floor ?? 0;
    const end = Math.max(0, buf.length - 1);
    let last: number | null = null;
    for (let y = from; y <= end; y += 1) {
      const line = (buf.getLine(y)?.translateToString(true) ?? "").replace(/\s+$/u, "");
      if (line) last = y;
    }
    return last;
  } catch {
    return null;
  }
}

/**
 * 仅本地移动 xterm 光标到目标绝对行（CSI A/B），不向 PTY 插行。
 * 用于光标卡在「已同意」占位区、而 Get-Date 回显已写在更下方的脱节场景。
 */
function syncXtermCursorToAbsLine(
  sessionId: string,
  targetAbsLine: number,
): Promise<void> {
  const term = getXterm(sessionId);
  if (!term?.buffer?.active) return Promise.resolve();
  const buf = term.buffer.active;
  const cursorAbs = buf.baseY + buf.cursorY;
  const delta = targetAbsLine - cursorAbs;
  if (delta === 0) return Promise.resolve();
  const seq = delta > 0 ? `\x1b[${delta}B\r` : `\x1b[${-delta}A\r`;
  return new Promise((resolve) => {
    try {
      term.write(seq, () => resolve());
    } catch {
      resolve();
    }
  });
}

/** 把焦点从卡片 DOM 夺回 xterm，避免 IME 锚在「已同意」卡上 */
function blurShellAgentDomFocus(): void {
  try {
    const ae = document.activeElement;
    if (
      ae instanceof HTMLElement &&
      ae.closest(
        ".term-shell-agent-card, .term-shell-agent-tool, .term-shell-agent-deco-card, .term-shell-agent-portal-host",
      )
    ) {
      ae.blur();
    }
  } catch {
    // ignore
  }
}

/**
 * PowerShell 收官：输入光标必须在「当前流内卡」之下（尤其是 final 结果卡）。
 * fit 扩高后光标常停在卡内最后一行占位上，IME 会看起来像「在结果卡后边」。
 */
async function ensurePowerShellInputCursor(sessionId: string): Promise<void> {
  const term = getXterm(sessionId);
  if (!term?.buffer?.active) return;

  /** decoration 覆盖 [anchor, anchor+rows)；可输入至少从 anchor+rows 起 */
  const cardBottom = (): number | null => {
    const geo = getShellAgentGeometry(sessionId);
    if (!geo || geo.mode !== "inline" || geo.anchorLine < 0) return null;
    return geo.anchorLine + Math.max(1, geo.rows);
  };

  /**
   * 光标必须严格在卡底之下，并再留 1 行空白。
   * fit 扩高后光标常停在「卡内最后一行」，IME 会贴在结果卡后边。
   */
  const syncBelowCard = async (): Promise<void> => {
    const bottom = cardBottom();
    if (bottom == null) return;
    // 目标：卡底下一行（bottom），再多 1 行避开 overflow / 卡边
    const target = bottom + 1;
    const buf = term.buffer.active;
    let cursorAbs = buf.baseY + buf.cursorY;
    if (cursorAbs >= target) return;

    const lastBuf = Math.max(0, buf.length - 1);
    if (cursorAbs < lastBuf) {
      await syncXtermCursorToAbsLine(sessionId, Math.min(target, lastBuf));
      cursorAbs = term.buffer.active.baseY + term.buffer.active.cursorY;
    }
    const still = target - cursorAbs;
    if (still > 0) {
      await new Promise<void>((resolve) => {
        try {
          term.write("\r\n".repeat(still), () => resolve());
        } catch {
          resolve();
        }
      });
    }
  };

  const findInputLineBelowCard = (): number => {
    const buf = term.buffer.active;
    const end = Math.max(0, buf.length - 1);
    const minY = cardBottom() ?? 0;
    for (let y = end; y >= minY; y -= 1) {
      const line = (buf.getLine(y)?.translateToString(true) ?? "").replace(/\s+$/u, "");
      if (!line) continue;
      if (lineLooksLikeShellPrompt(line) || /^>>/.test(line)) {
        return y;
      }
    }
    return Math.max(minY + 1, Math.min(end, minY + 1));
  };

  // 1) 先保证在结果卡下方（含额外空行）
  await syncBelowCard();

  // 2) 再对齐到卡下的 PS>/>>（若有）；对齐后若又回到卡内则再推下去
  await syncXtermCursorToAbsLine(sessionId, findInputLineBelowCard());
  await syncBelowCard();

  // 3) 续行只 Ctrl+C，禁止 Enter
  await abortPowerShellContinuationIfNeeded(sessionId);
  if (cursorOnPowerShellContinuation(sessionId)) {
    writeTerminalRaw(sessionId, "\x03");
    await waitForTerminalOutputIdle(sessionId, 100, 1000);
  }

  // 4) Ctrl+C / 迟到 fit 后再钉一次卡下
  await syncBelowCard();
  await syncXtermCursorToAbsLine(sessionId, findInputLineBelowCard());
  await syncBelowCard();
  blurShellAgentDomFocus();
}

function isSafeToPlaceFinalAfterExec(sessionId: string, isPs: boolean): boolean {
  if (cursorInsideActiveCard(sessionId)) return false;
  if (!cursorPastExecOutputFloor(sessionId)) return false;
  if (isPs) {
    // PS 执行后常尚未画出空 PS>（截图即停在日期行）；有回显且光标已过底线即可钉
    return bufferHasExecEchoFromFloor(sessionId);
  }
  if (!cursorOnEmptyShellPrompt(sessionId)) return false;
  return true;
}

/**
 * 命令执行后：对齐光标到回显下方，再允许钉 final。
 * 返回 false 时由调用方归还 prompt，避免 IME 永久卡在卡片里。
 */
async function settleAfterExecBeforeFinalCard(sessionId: string): Promise<boolean> {
  const isPs = isPowerShellSession(sessionId);

  const execDeadline = Date.now() + 3000;
  while (Date.now() < execDeadline) {
    if (!getEnterGateFlags(sessionId).agentExecuting) {
      const phase = useShellAgentStore.getState().get(sessionId)?.phase;
      if (phase !== "executing") break;
    }
    await sleep(40);
  }

  await waitForTerminalOutputIdle(
    sessionId,
    isPs ? 220 : 120,
    isPs ? 5000 : 2500,
  );

  if (!getXterm(sessionId)?.buffer?.active) return false;

  const placeDeadline = Date.now() + (isPs ? 8000 : 4000);
  while (Date.now() < placeDeadline) {
    if (isPs) {
      if (bufferHasExecEchoFromFloor(sessionId)) {
        const last = findLastContentLineFromFloor(sessionId);
        if (last != null) {
          // 光标挪到回显下一行，IME / final 不再落在「已同意」卡内
          await syncXtermCursorToAbsLine(sessionId, last + 1);
        }
        if (isSafeToPlaceFinalAfterExec(sessionId, true)) {
          return true;
        }
      }
    } else if (isSafeToPlaceFinalAfterExec(sessionId, false)) {
      return true;
    }
    await sleep(40);
  }
  return false;
}

function scheduleFinalCardAfterExec(
  sessionId: string,
  onReady?: () => void,
): void {
  const gen = (finalSettleGen.get(sessionId) ?? 0) + 1;
  finalSettleGen.set(sessionId, gen);
  void (async () => {
    const ready = await settleAfterExecBeforeFinalCard(sessionId);
    if (finalSettleGen.get(sessionId) !== gen) return;
    const agent = useShellAgentStore.getState().get(sessionId);
    if (!agent || agent.phase === "cancelled" || agent.phase === "idle") {
      onReady?.();
      return;
    }
    const geo = getShellAgentGeometry(sessionId);
    if (geo?.decoration && geo.cardKind === "final") {
      onReady?.();
      return;
    }

    if (!ready || !isSafeToPlaceFinalAfterExec(sessionId, isPowerShellSession(sessionId))) {
      pushShellAgentDebugEvent("finalSettle aborted", "sync/release without final");
      clearExecOutputFloor(sessionId);
      if (onReady) onReady();
      else releaseShellAgentToPrompt(sessionId);
      return;
    }

    // PS：钉卡前再对齐一次，避免 settle 与 write 之间光标被其它输出拽走
    if (isPowerShellSession(sessionId)) {
      const last = findLastContentLineFromFloor(sessionId);
      if (last != null) {
        await syncXtermCursorToAbsLine(sessionId, last + 1);
      }
    }

    reanchorShellAgentCard(sessionId, "final", () => {
      clearExecOutputFloor(sessionId);
      onReady?.();
    });
  })();
}

/**
 * PowerShell 收尾：只处理 `>>` 续行（Ctrl+C）。
 * 禁止循环发 Enter 推光标——已多次验证会制造 `>>` 洪水。
 */
async function abortPowerShellContinuationIfNeeded(sessionId: string): Promise<void> {
  if (!isPowerShellSession(sessionId)) return;
  if (!cursorOnPowerShellContinuation(sessionId)) return;
  writeTerminalRaw(sessionId, "\x03");
  await waitForTerminalOutputIdle(sessionId, 80, 800);
}

/**
 * 审批通过后的执行前序列（方案 C 纪律）：
 * 1. **不撤流内卡**（approve 不改几何；卡片切「已同意」态，继续盖住占位行）
 * 2. 仅当用户有残留输入才清行，并等回显静默
 * 3. 画 prompt 前缀 → 注入命令（PowerShell 跳过本地假前缀）
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
  await abortPowerShellContinuationIfNeeded(sessionId);
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

  // 询问刚提交、正在/即将钉思考卡：禁止误切 final
  if (pendingReanchorKind.get(sessionId) === "thinking") {
    return;
  }

  if (!wasAfterExec) return;

  // 打字中：记下待重锚 final，结束后由 flush 处理
  if (getEnterGateFlags(sessionId).userTyping) {
    pendingReanchorKind.set(sessionId, "final");
    return;
  }

  const geo = getShellAgentGeometry(sessionId);
  if (geo?.decoration && geo.cardKind === "final") return;

  // 等命令输出 + shell prompt 落定后再钉 final，避免卡插在输出与 prompt 之间
  scheduleFinalCardAfterExec(sessionId);
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
  if (kind === "final") {
    scheduleFinalCardAfterExec(sessionId);
    return;
  }
  reanchorShellAgentCard(sessionId, kind);
}

/**
 * 工具提案到达：thinking/ask 卡封存并重锚为命令卡。
 * 思考→确认统一 reanchor，避免同槽替换后 scrollback 仍留着转圈思考卡。
 */
export function notifyShellAgentApprovalPending(sessionId: string): void {
  pushShellAgentDebugEvent("approvalPending");
  // 丢弃过期「已同意」意图，避免把工具条误冻成新命令的已同意卡
  clearShellAgentConfirmFreeze(sessionId);
  useShellAgentStore.getState().setPhase(sessionId, "awaiting_approval");
  pendingReanchorKind.delete(sessionId);
  const geo = getShellAgentGeometry(sessionId);
  const past = isShellAgentCursorPastPlaceholder(sessionId);
  // ask 卡占位很高：必须 reanchor，勿同槽换肤，否则确认卡会留下大片空白
  if (
    !geo?.decoration ||
    geo.cardKind === "thinking" ||
    geo.cardKind === "ask" ||
    past
  ) {
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

/** omni_ask_user：挂起表单，流内展示询问卡 */
export function notifyShellAgentAskPending(sessionId: string, formId: string): void {
  pushShellAgentDebugEvent("askPending", formId);
  const store = useShellAgentStore.getState();
  store.setPendingAskFormId(sessionId, formId);
  store.setPhase(sessionId, "awaiting_user_input");
  pendingReanchorKind.delete(sessionId);
  const geo = getShellAgentGeometry(sessionId);
  const past = isShellAgentCursorPastPlaceholder(sessionId);
  if (!geo?.decoration || geo.cardKind === "thinking" || geo.cardKind === "cmd" || past) {
    reanchorShellAgentCard(sessionId, "ask");
  } else {
    setShellAgentCardKind(sessionId, "ask");
  }
  try {
    getXterm(sessionId)?.scrollToBottom();
  } catch {
    // ignore
  }
}

/** 询问已提交/跳过：先冻结表单，再钉思考卡（否则续轮会直接出确认卡） */
export function notifyShellAgentAskResolved(sessionId: string): void {
  pushShellAgentDebugEvent("askResolved");
  const geo = getShellAgentGeometry(sessionId);
  if (geo?.mode === "inline" && geo.cardKind === "ask" && geo.decoration) {
    archiveActiveInlineCard(sessionId);
  }
  const store = useShellAgentStore.getState();
  store.setPendingAskFormId(sessionId, null);
  const cur = store.get(sessionId);
  if (cur?.phase === "awaiting_user_input") {
    store.setPhase(sessionId, "streaming");
  }
  // 标记「即将/正在钉思考卡」，防止紧随其后的 streaming 误切 final
  pendingReanchorKind.set(sessionId, "thinking");
  if (getEnterGateFlags(sessionId).userTyping) {
    return;
  }
  reanchorShellAgentCard(sessionId, "thinking", () => {
    if (pendingReanchorKind.get(sessionId) === "thinking") {
      pendingReanchorKind.delete(sessionId);
    }
  });
}

export function notifyShellAgentExecuting(sessionId: string, executing: boolean): void {
  pushShellAgentDebugEvent("executing", String(executing));
  patchEnterGateFlags(sessionId, { agentExecuting: executing });
  useShellAgentStore.getState().setPhase(
    sessionId,
    executing ? "executing" : "observing",
  );
  // 同意后：把确认卡封成「已同意」留在 scrollback
  if (executing) {
    const geo = getShellAgentGeometry(sessionId);
    if (geo?.mode === "inline" && geo.cardKind === "cmd" && geo.decoration) {
      const live =
        geo.decoration.element?.innerHTML ??
        "";
      // 已在工具条上：禁止再次 mark+reanchor，否则会多冻一张「已同意」
      if (live.includes("term-shell-agent-tool")) {
        snapshotExecOutputFloor(sessionId);
        return;
      }
      markShellAgentConfirmFreeze(sessionId, "agreed");

      // PowerShell：确认卡阶段布局是好的；再 reanchor 写本地 \r\n 会与 PTY 脱节，
      // 导致执行回显/结果卡重叠、prompt 损坏。只冻结当前卡，命令在卡下真实 PS> 执行。
      // 底线必须在 archive 前快照（归档后 rows=0，会丢掉卡片高度）。
      if (isPowerShellSession(sessionId)) {
        snapshotExecOutputFloor(sessionId);
        archiveActiveInlineCard(sessionId);
        return;
      }

      // 其它 shell：钉矮槽给工具条（原行为）
      reanchorShellAgentCard(sessionId, "cmd", () => {
        snapshotExecOutputFloor(sessionId);
      }, 2);
      return;
    }
    snapshotExecOutputFloor(sessionId);
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

function hasPendingAskForm(sessionId: string): boolean {
  const cur = useShellAgentStore.getState().get(sessionId);
  if (!cur?.pendingAskFormId) return false;
  return cur.phase === "awaiting_user_input";
}

/** 每轮只归还 prompt 一次，避免多个 `root@host:~#` 堆叠 */
const promptReleasedForTurn = new Map<string, number>();
/** release 飞行中互斥，防止 fitStable / fallback 竞态双发 */
const releaseInFlight = new Set<string>();

/** 环结束：final 卡保留在流内 → 仅在重锚导致本地/PTY 脱节时同步一次 prompt */
function releaseShellAgentToPrompt(sessionId: string): void {
  const agent = useShellAgentStore.getState().get(sessionId);
  const turn = agent?.turn ?? 0;
  if (promptReleasedForTurn.get(sessionId) === turn || releaseInFlight.has(sessionId)) {
    useShellAgentStore.getState().setPhase(sessionId, "idle");
    patchEnterGateFlags(sessionId, { agentExecuting: false });
    return;
  }
  promptReleasedForTurn.set(sessionId, turn);
  releaseInFlight.add(sessionId);

  useShellAgentStore.getState().setPhase(sessionId, "idle");
  patchEnterGateFlags(sessionId, { agentExecuting: false });

  const finishFocus = () => {
    markShellPromptReady(sessionId);
    blurShellAgentDomFocus();
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

  // 等 PTY 可能迟到的 prompt 落盘，再决定要不要发换行，避免双 prompt
  void waitForTerminalOutputIdle(sessionId, 150, 1000)
    .then(async () => {
      if (promptReleasedForTurn.get(sessionId) !== turn) return;

      // PowerShell：禁止为拉 prompt 发 Enter（会出 >>，且 conpty 易把光标 CUP 回卡片区）
      if (isPowerShellSession(sessionId)) {
        clearReanchorPtySync(sessionId);
        await ensurePowerShellInputCursor(sessionId);
        finishFocus();
        // 结果卡 fit 可能在 release 之后仍扩高一行，延迟再推一次，避免 IME 贴在卡边
        window.setTimeout(() => {
          void ensurePowerShellInputCursor(sessionId).then(() => {
            blurShellAgentDomFocus();
            try {
              getXterm(sessionId)?.focus();
            } catch {
              // ignore
            }
          });
        }, 150);
        return;
      }

      // PowerShell 以外：若已陷入续行则由各 shell 自恢复；此处只处理 bash 等
      await abortPowerShellContinuationIfNeeded(sessionId);

      let needPtyEnter = consumeReanchorPtySync(sessionId);
      if (cursorBelowActiveCardOnEmptyPrompt(sessionId)) {
        needPtyEnter = false;
        clearReanchorPtySync(sessionId);
      } else if (
        cursorInsideActiveCard(sessionId) ||
        !bufferHasUsablePromptBelowCard(sessionId)
      ) {
        needPtyEnter = true;
      }

      if (needPtyEnter) {
        writeTerminalRaw(sessionId, "\n");
        await waitForTerminalOutputIdle(sessionId, 100, 800);
      }
      finishFocus();
    })
    .finally(() => {
      releaseInFlight.delete(sessionId);
    });
}

function clearPromptReleaseGuard(sessionId: string): void {
  promptReleasedForTurn.delete(sessionId);
  finalSettleGen.delete(sessionId);
  releaseInFlight.delete(sessionId);
  clearExecOutputFloor(sessionId);
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
  if (hasPendingAskForm(sessionId)) {
    pushShellAgentDebugEvent("turnFinished deferred", "pending ask");
    useShellAgentStore.getState().setPhase(sessionId, "awaiting_user_input");
    return;
  }

  const geo = getShellAgentGeometry(sessionId);
  const past = isShellAgentCursorPastPlaceholder(sessionId);
  const isPs = isPowerShellSession(sessionId);

  // 仍停在思考卡：封成「思考完成」并重锚 final，避免转圈残留
  if (geo?.decoration && geo.cardKind === "thinking") {
    scheduleFinalCardAfterExec(sessionId, () => scheduleTurnFinishFallback(sessionId));
    return;
  }

  // 命令输出已在卡下方，或 PowerShell：禁止原地改 final（会盖住/插在回显前）
  if (geo?.decoration && geo.cardKind === "cmd" && (past || isPs)) {
    scheduleFinalCardAfterExec(sessionId, () => scheduleTurnFinishFallback(sessionId));
    return;
  }

  // 已在 cmd 槽且未越过（非 PS）：只切 final
  if (geo?.decoration && geo.cardKind !== "final") {
    if (isPs) {
      scheduleFinalCardAfterExec(sessionId, () => scheduleTurnFinishFallback(sessionId));
      return;
    }
    setShellAgentCardKind(sessionId, "final");
    scheduleTurnFinishFallback(sessionId);
    return;
  }

  if (geo?.decoration && geo.cardKind === "final") {
    scheduleTurnFinishFallback(sessionId);
    return;
  }

  // PowerShell 同意后确认卡已 archive → 无 live decoration；勿直接 release，
  // 否则会与 scheduleFinalCardAfterExec 抢跑，结果卡落点错乱。
  if (
    isPs &&
    (cur.phase === "streaming" ||
      cur.phase === "observing" ||
      cur.phase === "executing")
  ) {
    scheduleFinalCardAfterExec(sessionId, () => scheduleTurnFinishFallback(sessionId));
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
