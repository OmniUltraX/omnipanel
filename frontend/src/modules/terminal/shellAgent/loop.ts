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
import { collectDisplayToolCalls, isInlineTerminalToolName } from "../inlineTerminalTool";
import { getEnterGateFlags, patchEnterGateFlags } from "../passthroughAi/enterGates";
import { schedulePassthroughPromptHintSync } from "../passthroughAi/passthroughPromptHint";
import { lineLooksLikeShellPrompt, splitPromptAndBody } from "../passthroughAi/screenLine";
import { writeTerminalRaw } from "../terminalPaneSenders";
import { markShellPromptReady } from "../terminalShellRecovery";
import { getResolvedAiThread } from "../aiThreadBridge";
import { waitForTerminalOutputIdle } from "../terminalOutputTap";
import { looksLikePowerShellProgressText } from "../terminalOutputText";
import { getXterm } from "../xtermRegistry";
import { useTerminalUiStore } from "../terminalUiStore";
import {
  archiveActiveInlineCard,
  beginShellAgentCard,
  cardsBottomLine,
  clearShellAgentGeometry,
  clearReanchorPtySync,
  consumeReanchorPtySync,
  cursorInsideAnyCard,
  ensureCursorBelowCards,
  getShellAgentGeometry,
  isShellAgentCursorPastPlaceholder,
  markShellAgentNeedsPromptSync,
  prepareShellAgentEcho,
  reanchorShellAgentCard,
  setShellAgentCardKind,
  ensureMinCardRows,
  type ShellAgentCardKind,
} from "./shellAgentGeometry";
import { useShellAgentStore } from "./shellAgentStore";
import {
  clearShellAgentLastCmd,
  clearShellAgentThinkingFull,
  clearLastFrozenThinking,
  clearArchivedDisplayToolIds,
  clearShellAgentConfirmFreeze,
  collectDisplayToolIdsFromHtml,
  getArchivedDisplayToolIds,
  getShellAgentLastCmd,
  getShellAgentThinkingFull,
  getLastFrozenThinking,
  isSameAsLastFrozenThinking,
  markShellAgentConfirmFreeze,
  setShellAgentThinkingFull,
} from "./thinkingCache";
import {
  currentTurnResultText,
  currentTurnThinkingText,
  scopeThreadToQuery,
} from "./threadTurnText";

/**
 * 方案 C：直通 AI 表现层（decoration / 占位 / 内存态）随 xterm 易失；
 * 可持久时间线只走命令栏 Block（blocksStore + terminalHistorySync）。
 * remount / restore 时必须同步拆掉 UI 态，禁止用持久化 aiThread 重建流内卡。
 */
export function teardownShellAgentUi(sessionId: string): void {
  stopPowerShellIdleCursorWatch(sessionId);
  abortFinalSettle(sessionId);
  clearShellAgentGeometry(sessionId);
  useShellAgentStore.getState().clear(sessionId);
  clearShellAgentThinkingFull(sessionId);
  clearLastFrozenThinking(sessionId);
  clearArchivedDisplayToolIds(sessionId);
  clearShellAgentLastCmd(sessionId);
  clearPromptReleaseGuard(sessionId);
  pendingReanchorKind.delete(sessionId);
  pendingTurnFinish.delete(sessionId);
  suppressStripPin.delete(sessionId);
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
  // 一次写完，避免 Ctrl+A 与命令注入交错成 `date现在的时间`
  writeTerminalRaw(sessionId, "\x01\x0b\x15");
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

function bufferLooksLikePowerShellProgress(sessionId: string): boolean {
  try {
    const term = getXterm(sessionId);
    if (!term?.buffer?.active) return false;
    const buf = term.buffer.active;
    const end = Math.max(0, buf.length - 1);
    const from = Math.max(0, end - 10);
    for (let y = from; y <= end; y += 1) {
      const line = (buf.getLine(y)?.translateToString(true) ?? "").trim();
      if (looksLikePowerShellProgressText(line)) return true;
    }
  } catch {
    // ignore
  }
  return false;
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
    if (!term?.buffer?.active) return false;
    const cursorAbs = term.buffer.active.baseY + term.buffer.active.cursorY;
    return cursorInsideAnyCard(sessionId, cursorAbs);
  } catch {
    return false;
  }
}

/** 执行开始时卡片底线：final 必须钉在此行之下，避免结果卡插在 Get-Date 回显之上 */
const execOutputFloor = new Map<string, number>();
/** 内联工具已等到命令结束：settle 不必再等 SSH 空 prompt / 下一次击键 */
const execOutputReady = new Set<string>();

function snapshotExecOutputFloor(sessionId: string): void {
  try {
    const term = getXterm(sessionId);
    let floor = 0;
    if (term?.buffer?.active) {
      floor = term.buffer.active.baseY + term.buffer.active.cursorY;
    }
    const cardsBottom = cardsBottomLine(sessionId);
    if (cardsBottom != null) {
      floor = Math.max(floor, cardsBottom);
    }
    execOutputFloor.set(sessionId, floor);
  } catch {
    // ignore
  }
}

function clearExecOutputFloor(sessionId: string): void {
  execOutputFloor.delete(sessionId);
  execOutputReady.delete(sessionId);
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
 * downOnly：禁止 CSI A。用户执行 pwd 后 ConPTY CUP 回卡内时，只允许往下推到最新输出。
 */
function syncXtermCursorToAbsLine(
  sessionId: string,
  targetAbsLine: number,
  opts?: { downOnly?: boolean },
): Promise<void> {
  const term = getXterm(sessionId);
  if (!term?.buffer?.active) return Promise.resolve();
  const buf = term.buffer.active;
  const cursorAbs = buf.baseY + buf.cursorY;
  const delta = targetAbsLine - cursorAbs;
  if (delta === 0) return Promise.resolve();
  if (opts?.downOnly && delta < 0) return Promise.resolve();
  const seq = delta > 0 ? `\x1b[${delta}B\r` : `\x1b[${-delta}A\r`;
  return new Promise((resolve) => {
    try {
      term.write(seq, () => resolve());
    } catch {
      resolve();
    }
  });
}

function ensurePromptTrailingSpace(prompt: string): string {
  const trimmed = prompt.replace(/\s+$/u, "");
  if (!trimmed) return "";
  return `${trimmed} `;
}

/** 从 buffer / 几何里取出本轮真实主提示符（如 `PS C:\\Users\\chaoj> `） */
function readLastMainShellPrompt(sessionId: string): string | null {
  const fromGeo = getShellAgentGeometry(sessionId)?.promptPrefix ?? "";
  if (fromGeo.trim() && lineLooksLikeShellPrompt(fromGeo)) {
    return ensurePromptTrailingSpace(fromGeo);
  }
  try {
    const term = getXterm(sessionId);
    if (!term?.buffer?.active) return fromGeo.trim() ? ensurePromptTrailingSpace(fromGeo) : null;
    const buf = term.buffer.active;
    const end = Math.max(0, buf.length - 1);
    for (let y = end; y >= 0; y -= 1) {
      const line = (buf.getLine(y)?.translateToString(true) ?? "").replace(/\s+$/u, "");
      if (!line || /^>>/.test(line)) continue;
      if (lineLooksLikeShellPrompt(line)) return ensurePromptTrailingSpace(line);
    }
  } catch {
    // ignore
  }
  return fromGeo.trim() ? ensurePromptTrailingSpace(fromGeo) : null;
}

/**
 * 卡下空行补画本地 prompt。PTY 禁止再发 Enter（会出 >>）；
 * 本地前缀只影响画面，输入仍走已在空 PS> 上的 ConPTY。
 * 当前行若是 `PS> :22` 这类脏提示符或普通输出，先换行再画，避免卡在脏行上。
 */
function paintPowerShellPromptIfMissing(sessionId: string): Promise<void> {
  const term = getXterm(sessionId);
  if (!term?.buffer?.active) return Promise.resolve();
  const prefix = readLastMainShellPrompt(sessionId);
  if (!prefix) return Promise.resolve();

  const writeLocal = (data: string): Promise<void> =>
    new Promise((resolve) => {
      try {
        term.write(data, () => resolve());
      } catch {
        resolve();
      }
    });

  try {
    const buf = term.buffer.active;
    const line = (buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "")
      .replace(/\s+$/u, "");
    if (lineLooksLikeShellPrompt(line)) return Promise.resolve();
    const afterJunk = line.length > 0 ? writeLocal("\r\n") : Promise.resolve();
    return afterJunk.then(() => writeLocal(prefix));
  } catch {
    return Promise.resolve();
  }
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

function activeInlineCardBottom(sessionId: string): number | null {
  return cardsBottomLine(sessionId);
}

/** 卡下最后可输入行：优先空 PS>，否则内容下一行（pwd 输出之后） */
function findLastInputLineBelowCard(sessionId: string): number | null {
  const bottom = activeInlineCardBottom(sessionId);
  const term = getXterm(sessionId);
  if (bottom == null || !term?.buffer?.active) return bottom;
  const buf = term.buffer.active;
  const end = Math.max(0, buf.length - 1);
  let lastContent = bottom;
  for (let y = end; y >= bottom; y -= 1) {
    const line = (buf.getLine(y)?.translateToString(true) ?? "").replace(/\s+$/u, "");
    if (line) {
      lastContent = y;
      break;
    }
  }
  for (let y = end; y >= lastContent; y -= 1) {
    const line = (buf.getLine(y)?.translateToString(true) ?? "").replace(/\s+$/u, "");
    if (lineLooksLikeShellPrompt(line) && !/^>>/.test(line)) return y;
  }
  return Math.max(bottom, Math.min(end, lastContent + 1));
}

const psCursorSyncing = new Set<string>();

/**
 * PowerShell 输入光标：必须在结果卡之下，且不得把已在卡下的光标再 CSI A 拽回去。
 * ConPTY 在用户执行 pwd 后常 CUP 回卡内占位行，只能往下推到最新输出。
 */
async function ensurePowerShellInputCursor(sessionId: string): Promise<void> {
  if (psCursorSyncing.has(sessionId)) return;
  const term = getXterm(sessionId);
  if (!term?.buffer?.active) return;
  psCursorSyncing.add(sessionId);
  try {
    const bottom = activeInlineCardBottom(sessionId);
    const cursorAbs = () =>
      term.buffer.active.baseY + term.buffer.active.cursorY;

    // 已在卡下（pwd 输出之后）：禁止上移，但可下移到最新内容之后
    if (bottom != null && cursorAbs() >= bottom) {
      const target = findLastInputLineBelowCard(sessionId);
      if (target != null && target > cursorAbs()) {
        await syncXtermCursorToAbsLine(sessionId, target, { downOnly: true });
      }
      await paintPowerShellPromptIfMissing(sessionId);
      blurShellAgentDomFocus();
      return;
    }

    const target = findLastInputLineBelowCard(sessionId);
    if (target != null) {
      await syncXtermCursorToAbsLine(sessionId, target, { downOnly: true });
    }
    if (bottom != null && cursorAbs() < bottom) {
      const still = bottom - cursorAbs();
      if (still > 0) {
        await new Promise<void>((resolve) => {
          try {
            term.write("\r\n".repeat(still), () => resolve());
          } catch {
            resolve();
          }
        });
      }
    }
    await abortPowerShellContinuationIfNeeded(sessionId);
    await paintPowerShellPromptIfMissing(sessionId);
    blurShellAgentDomFocus();
  } finally {
    psCursorSyncing.delete(sessionId);
  }
}

type PsIdleCursorWatch = {
  dispose: () => void;
  timer: ReturnType<typeof setTimeout> | null;
};
const psIdleCursorWatch = new Map<string, PsIdleCursorWatch>();

function stopPowerShellIdleCursorWatch(sessionId: string): void {
  const w = psIdleCursorWatch.get(sessionId);
  if (!w) return;
  if (w.timer) clearTimeout(w.timer);
  w.dispose();
  psIdleCursorWatch.delete(sessionId);
}

/** cls / Clear-Host 之后 buffer 作废：拆掉流内卡，停止把光标往卡下推 */
export function notifyShellAgentScreenCleared(sessionId: string): void {
  stopPowerShellIdleCursorWatch(sessionId);
  clearShellAgentGeometry(sessionId);
}

/** 收官后持续校正：用户再执行命令时 ConPTY CUP 回卡内，把光标推回卡下最新行 */
function startPowerShellIdleCursorWatch(sessionId: string): void {
  stopPowerShellIdleCursorWatch(sessionId);
  const term = getXterm(sessionId);
  if (!term) return;

  const watch: PsIdleCursorWatch = { dispose: () => {}, timer: null };
  const schedule = () => {
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = setTimeout(() => {
      watch.timer = null;
      const agent = useShellAgentStore.getState().get(sessionId);
      if (agent && agent.phase !== "idle" && agent.phase !== "cancelled") return;
      if (getEnterGateFlags(sessionId).imeComposing) return;
      if (!cursorInsideActiveCard(sessionId)) return;
      void ensurePowerShellInputCursor(sessionId).then(() => {
        try {
          getXterm(sessionId)?.focus();
        } catch {
          // ignore
        }
      });
    }, 80);
  };

  const parsed = term.onWriteParsed(schedule);
  watch.dispose = () => {
    parsed.dispose();
    if (watch.timer) {
      clearTimeout(watch.timer);
      watch.timer = null;
    }
  };
  psIdleCursorWatch.set(sessionId, watch);
}

function isSafeToPlaceFinalAfterExec(sessionId: string, isPs: boolean): boolean {
  if (cursorInsideActiveCard(sessionId)) return false;
  if (!cursorPastExecOutputFloor(sessionId)) return false;
  if (bufferLooksLikePowerShellProgress(sessionId)) return false;
  // 与 SSH bash 一致：必须停在空主提示符上再钉卡
  if (!cursorOnEmptyShellPrompt(sessionId)) return false;
  if (isPs) {
    return bufferHasExecEchoFromFloor(sessionId);
  }
  return true;
}

function execOutputLooksIncomplete(sessionId: string): boolean {
  const last = findLastContentLineFromFloor(sessionId);
  if (last == null) return true;
  try {
    const term = getXterm(sessionId);
    const line = (
      term?.buffer.active.getLine(last)?.translateToString(true) ?? ""
    ).trim();
    if (!line) return true;
    if (/^-+$/.test(line)) return true;
    if (looksLikePowerShellProgressText(line)) return true;
    if (
      /^(CookedValue|RawValue|CounterSamples|Name|Value|Property)\s*$/i.test(line)
    ) {
      return true;
    }
    const cmd = (getShellAgentLastCmd(sessionId)?.command ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const compact = line.replace(/\s+/g, " ");
    if (
      cmd.length > 12 &&
      compact.length >= 8 &&
      cmd.startsWith(compact) &&
      compact.length < cmd.length
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 输出还在涨时禁止钉结果卡（CookedValue 标题刚出来、数值还在刷） */
async function waitForExecOutputStable(sessionId: string, isPs: boolean): Promise<boolean> {
  if (isAgentBusyExecuting(sessionId)) return false;
  // 工具链已收到命令结束：SSH 上不必再等空 prompt / 下一次击键才钉结果卡
  if (execOutputReady.has(sessionId)) {
    execOutputReady.delete(sessionId);
    return true;
  }
  const live = getShellAgentGeometry(sessionId);
  if (
    live?.cardKind === "thinking" &&
    live.decoration &&
    !livePostExecCardIsStale(sessionId)
  ) {
    return true;
  }

  await waitForTerminalOutputIdle(
    sessionId,
    isPs ? 480 : 160,
    isPs ? 6000 : 2500,
  );
  if (isAgentBusyExecuting(sessionId)) return false;

  const stableMs = isPs ? 700 : 160;
  const deadline = Date.now() + (isPs ? 5000 : 1500);
  let lastSeen = findLastContentLineFromFloor(sessionId);
  let lastChange = Date.now();

  while (Date.now() < deadline) {
    if (isAgentBusyExecuting(sessionId)) return false;
    if (bufferLooksLikePowerShellProgress(sessionId)) {
      await sleep(80);
      continue;
    }
    const now = findLastContentLineFromFloor(sessionId);
    if (now !== lastSeen) {
      lastSeen = now;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= stableMs) {
      if (lastSeen != null) {
        await syncXtermCursorToAbsLine(sessionId, lastSeen + 1);
      }
      if (cursorInsideActiveCard(sessionId)) {
        const geo = getShellAgentGeometry(sessionId);
        if (geo?.cardKind === "thinking" && geo.decoration) return true;
        await sleep(50);
        continue;
      }
      if (bufferHasExecEchoFromFloor(sessionId)) {
        if (execOutputLooksIncomplete(sessionId) && Date.now() + 400 < deadline) {
          await sleep(50);
          continue;
        }
        return true;
      }
      if (isSafeToPlaceFinalAfterExec(sessionId, isPs)) return true;
    }
    await sleep(50);
  }
  return false;
}

function abortFinalSettle(sessionId: string): void {
  const gen = (finalSettleGen.get(sessionId) ?? 0) + 1;
  finalSettleGen.set(sessionId, gen);
  finalSettleInFlight.delete(sessionId);
  settleRetryCount.delete(sessionId);
}

function isAgentBusyExecuting(sessionId: string): boolean {
  if (getEnterGateFlags(sessionId).agentExecuting) return true;
  return useShellAgentStore.getState().get(sessionId)?.phase === "executing";
}

async function settleAfterExecBeforeFinalCard(sessionId: string): Promise<boolean> {
  const isPs = isPowerShellSession(sessionId);

  const execDeadline = Date.now() + 8000;
  while (Date.now() < execDeadline) {
    if (!isAgentBusyExecuting(sessionId)) break;
    await sleep(40);
  }
  if (isAgentBusyExecuting(sessionId)) return false;

  if (!getXterm(sessionId)?.buffer?.active) return false;
  return waitForExecOutputStable(sessionId, isPs);
}

/** 下一工具已到、但命令输出还没落定：等结果卡钉完再切确认 */
const cmdAfterSettle = new Set<string>();
const finalSettleInFlight = new Set<string>();
const settleRetryCount = new Map<string, number>();
/** 续轮已在确认位钉思考卡（区别于首轮思考→确认的立刻换肤） */
const postExecThinking = new Set<string>();

/** 刚钉上思考卡：禁止同一轮立刻改回工具条，否则 Overlay 思考↔工具条对打死循环 */
const suppressStripPin = new Set<string>();

function livePostExecCardIsStale(sessionId: string): boolean {
  const geo = getShellAgentGeometry(sessionId);
  if (!geo?.decoration) return false;
  if (geo.cardKind !== "final" && geo.cardKind !== "thinking") return false;
  return isShellAgentCursorPastPlaceholder(sessionId);
}

function scopedAiThread(sessionId: string): ReturnType<typeof getResolvedAiThread> {
  const blockId = useShellAgentStore.getState().get(sessionId)?.blockId;
  if (!blockId) return [];
  const block = useBlocksStore.getState().findBlockById(blockId);
  if (!block) return [];
  return scopeThreadToQuery(
    getResolvedAiThread(block),
    getShellAgentGeometry(sessionId)?.query,
  );
}

function resolvePostExecCardKind(sessionId: string): "thinking" | "final" {
  try {
    const scoped = scopedAiThread(sessionId);
    if (scoped.length === 0) return "thinking";
    const text = currentTurnResultText(scoped).trim();
    return text ? "final" : "thinking";
  } catch {
    return "thinking";
  }
}

/** 仅「待用户确认」的下一工具；running 的当前命令不算 */
function hasPendingApprovalTool(sessionId: string): boolean {
  const blockId = useShellAgentStore.getState().get(sessionId)?.blockId;
  if (!blockId) return false;
  const block = useBlocksStore.getState().findBlockById(blockId);
  if (!block) return false;
  return getResolvedAiThread(block).some(
    (item) =>
      isAiThreadToolCall(item) &&
      isInlineTerminalToolName(item.toolName) &&
      item.status === "pending",
  );
}

function shouldSwitchToCmdCard(sessionId: string): boolean {
  return cmdAfterSettle.has(sessionId) || hasPendingApprovalTool(sessionId);
}

function pinCmdAfterPostExec(sessionId: string, onReady?: () => void): void {
  if (bufferLooksLikePowerShellProgress(sessionId)) {
    window.setTimeout(() => {
      const a = useShellAgentStore.getState().get(sessionId);
      if (!a || a.phase === "cancelled" || a.phase === "idle") {
        onReady?.();
        return;
      }
      pinCmdAfterPostExec(sessionId, onReady);
    }, 800);
    return;
  }
  cmdAfterSettle.delete(sessionId);
  postExecThinking.delete(sessionId);
  useShellAgentStore.getState().setPhase(sessionId, "awaiting_approval");

  const geo = getShellAgentGeometry(sessionId);
  const thought =
    getShellAgentThinkingFull(sessionId).trim() ||
    currentTurnThinkingText(scopedAiThread(sessionId)).trim();
  const cursorPast = isShellAgentCursorPastPlaceholder(sessionId);
  // 仅当光标还在卡上、且没有输出顶在卡下时，才同槽换确认卡。
  // 光标已过再加高 decoration，会直接盖住回显。
  if (
    geo?.mode === "inline" &&
    geo.cardKind === "thinking" &&
    geo.decoration &&
    !thought &&
    !cursorPast
  ) {
    setShellAgentCardKind(sessionId, "cmd");
    ensureMinCardRows(sessionId, "cmd");
    clearExecOutputFloor(sessionId);
    onReady?.();
    return;
  }

  reanchorShellAgentCard(sessionId, "cmd", () => {
    clearExecOutputFloor(sessionId);
    onReady?.();
  });
}

async function waitForPostExecThought(
  sessionId: string,
  gen: number,
  maxFirstTokenMs: number,
): Promise<"final" | "thinking" | "empty"> {
  const started = Date.now();
  const firstTokenDeadline = started + maxFirstTokenMs;
  const hardDeadline = started + Math.max(maxFirstTokenMs, 6000);
  let last = "";
  let lastChange = Date.now();
  let seen = false;
  const stableMs = 280;
  const holdMs = 400;
  const expectCmd = (): boolean => shouldSwitchToCmdCard(sessionId);

  while (Date.now() < hardDeadline) {
    if (finalSettleGen.get(sessionId) !== gen) return "empty";
    const text = currentTurnThinkingText(scopedAiThread(sessionId)).trim();
    if (text !== last) {
      last = text;
      lastChange = Date.now();
      if (text) seen = true;
    } else if (seen && text && Date.now() - lastChange >= stableMs + holdMs) {
      return "thinking";
    }
    if (!expectCmd() && !text && resolvePostExecCardKind(sessionId) === "final") {
      return "final";
    }
    if (!seen && Date.now() > firstTokenDeadline) {
      return expectCmd() ? "empty" : resolvePostExecCardKind(sessionId) === "final"
        ? "final"
        : "empty";
    }
    await sleep(50);
  }
  if (resolvePostExecCardKind(sessionId) === "final" && !expectCmd()) return "final";
  return seen ? "thinking" : "empty";
}

function freshPostToolThinking(sessionId: string): string {
  const text = currentTurnThinkingText(scopedAiThread(sessionId)).trim();
  if (!text) return "";
  if (isSameAsLastFrozenThinking(sessionId, text)) return "";
  return text;
}

function captureThinkingBeforeArchive(sessionId: string): void {
  const text =
    getShellAgentThinkingFull(sessionId).trim() ||
    currentTurnThinkingText(scopedAiThread(sessionId)).trim();
  if (text) setShellAgentThinkingFull(sessionId, text);
}

function placePostExecThinkingCard(sessionId: string, onReady?: () => void): void {
  if (isAgentBusyExecuting(sessionId)) return;
  if (bufferLooksLikePowerShellProgress(sessionId)) return;
  const rawThought = currentTurnThinkingText(scopedAiThread(sessionId)).trim();
  const incomingDisplay = collectDisplayToolCalls(scopedAiThread(sessionId)).filter(
    (tc) =>
      tc.status !== "rejected" &&
      !getArchivedDisplayToolIds(sessionId).has(tc.id),
  );
  // 旧思考重放、或下一条已是 search/fetch：不要再钉一张空/重复思考卡。
  if (
    (rawThought && isSameAsLastFrozenThinking(sessionId, rawThought)) ||
    (!rawThought && incomingDisplay.length > 0)
  ) {
    if (shouldSwitchToCmdCard(sessionId)) {
      pinCmdAfterPostExec(sessionId, onReady);
      return;
    }
    onReady?.();
    return;
  }
  const geo = getShellAgentGeometry(sessionId);
  if (geo?.cardKind === "thinking" && geo.decoration) {
    if (livePostExecCardIsStale(sessionId)) {
      captureThinkingBeforeArchive(sessionId);
      archiveActiveInlineCard(sessionId);
    } else {
      onReady?.();
      return;
    }
  }
  if (livePostExecCardIsStale(sessionId) || geo?.cardKind === "thinking") {
    captureThinkingBeforeArchive(sessionId);
    archiveActiveInlineCard(sessionId);
  }
  postExecThinking.add(sessionId);
  reanchorShellAgentCard(sessionId, "thinking", onReady);
}

function awaitThoughtThenMaybeCmd(
  sessionId: string,
  gen: number,
  finishFlight: () => void,
  onReady?: () => void,
): void {
  const pendingCmd = shouldSwitchToCmdCard(sessionId);
  void (async () => {
    const thought = await waitForPostExecThought(
      sessionId,
      gen,
      pendingCmd ? 4000 : execOutputFloor.has(sessionId) ? 400 : 2500,
    );
    if (finalSettleGen.get(sessionId) !== gen) return;
    if (shouldSwitchToCmdCard(sessionId)) {
      pinCmdAfterPostExec(sessionId, onReady);
      finishFlight();
      return;
    }
    if (thought === "final") {
      setShellAgentCardKind(sessionId, "final");
    }
    clearExecOutputFloor(sessionId);
    finishFlight();
    onReady?.();
  })();
}

function scheduleFinalCardAfterExec(
  sessionId: string,
  onReady?: () => void,
): void {
  if (isAgentBusyExecuting(sessionId)) return;
  if (finalSettleInFlight.has(sessionId)) return;

  const liveThinking = getShellAgentGeometry(sessionId);
  if (
    liveThinking?.cardKind === "thinking" &&
    liveThinking.decoration &&
    !livePostExecCardIsStale(sessionId)
  ) {
    const gen = (finalSettleGen.get(sessionId) ?? 0) + 1;
    finalSettleGen.set(sessionId, gen);
    finalSettleInFlight.add(sessionId);
    const finishFlight = (): void => {
      if (finalSettleGen.get(sessionId) === gen) {
        finalSettleInFlight.delete(sessionId);
      }
    };
    awaitThoughtThenMaybeCmd(sessionId, gen, finishFlight, onReady);
    return;
  }

  const gen = (finalSettleGen.get(sessionId) ?? 0) + 1;
  finalSettleGen.set(sessionId, gen);
  finalSettleInFlight.add(sessionId);
  const finishFlight = (): void => {
    if (finalSettleGen.get(sessionId) === gen) {
      finalSettleInFlight.delete(sessionId);
    }
  };
  void (async () => {
    const ready = await settleAfterExecBeforeFinalCard(sessionId);
    if (finalSettleGen.get(sessionId) !== gen) return;
    const agent = useShellAgentStore.getState().get(sessionId);
    if (!agent || agent.phase === "cancelled" || agent.phase === "idle") {
      finishFlight();
      onReady?.();
      return;
    }

    const isPs = isPowerShellSession(sessionId);
    const midTurn =
      agent.phase === "streaming" ||
      agent.phase === "observing" ||
      agent.phase === "executing" ||
      agent.phase === "awaiting_approval";

    if (!ready) {
      const liveNow = getShellAgentGeometry(sessionId);
      if (
        liveNow?.cardKind === "thinking" &&
        liveNow.decoration &&
        !livePostExecCardIsStale(sessionId)
      ) {
        settleRetryCount.delete(sessionId);
        awaitThoughtThenMaybeCmd(sessionId, gen, finishFlight, onReady);
        return;
      }
      if (isAgentBusyExecuting(sessionId)) {
        pushShellAgentDebugEvent("finalSettle wait", "still executing; defer");
        finishFlight();
        pendingReanchorKind.set(sessionId, "final");
        return;
      }
      const n = (settleRetryCount.get(sessionId) ?? 0) + 1;
      settleRetryCount.set(sessionId, n);
      const canRetry = midTurn && n < 3 && agent.phase !== "executing";
      if (canRetry) {
        pushShellAgentDebugEvent("finalSettle wait", `output not stable; retry ${n}`);
        finishFlight();
        window.setTimeout(() => {
          if (finalSettleGen.get(sessionId) !== gen) return;
          const a = useShellAgentStore.getState().get(sessionId);
          if (!a || a.phase === "cancelled" || a.phase === "idle") {
            onReady?.();
            return;
          }
          if (isAgentBusyExecuting(sessionId)) {
            pendingReanchorKind.set(sessionId, "final");
            return;
          }
          scheduleFinalCardAfterExec(sessionId, onReady);
        }, 400);
        return;
      }
      settleRetryCount.delete(sessionId);
      if (midTurn) {
        if (
          isAgentBusyExecuting(sessionId) ||
          bufferLooksLikePowerShellProgress(sessionId)
        ) {
          pushShellAgentDebugEvent("finalSettle wait", "progress/exec; defer");
          finishFlight();
          pendingReanchorKind.set(sessionId, "final");
          window.setTimeout(() => {
            if (finalSettleGen.get(sessionId) !== gen) return;
            if (isAgentBusyExecuting(sessionId)) return;
            scheduleFinalCardAfterExec(sessionId, onReady);
          }, 800);
          return;
        }
        pushShellAgentDebugEvent("finalSettle fallback", "pin after retries");
        placePostExecThinkingCard(sessionId, () => {
          awaitThoughtThenMaybeCmd(sessionId, gen, finishFlight, onReady);
        });
        return;
      }
      pushShellAgentDebugEvent("finalSettle aborted", "sync/release without final");
      clearExecOutputFloor(sessionId);
      finishFlight();
      if (onReady) onReady();
      else releaseShellAgentToPrompt(sessionId);
      return;
    }
    settleRetryCount.delete(sessionId);

    if (isPs) {
      const last = findLastContentLineFromFloor(sessionId);
      if (last != null) {
        await syncXtermCursorToAbsLine(sessionId, last + 1);
      }
    }
    if (finalSettleGen.get(sessionId) !== gen) return;
    const latest = useShellAgentStore.getState().get(sessionId);
    if (!latest || latest.phase === "cancelled" || latest.phase === "idle") {
      finishFlight();
      onReady?.();
      return;
    }

    const pendingCmd = shouldSwitchToCmdCard(sessionId);
    const want: "thinking" | "final" = pendingCmd
      ? "thinking"
      : resolvePostExecCardKind(sessionId);

    if (want === "thinking") {
      placePostExecThinkingCard(sessionId, () => {
        awaitThoughtThenMaybeCmd(sessionId, gen, finishFlight, onReady);
      });
      return;
    }

    if (livePostExecCardIsStale(sessionId)) {
      archiveActiveInlineCard(sessionId);
    }
    reanchorShellAgentCard(sessionId, want, () => {
      awaitThoughtThenMaybeCmd(sessionId, gen, finishFlight, onReady);
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
function remoteInputLineHasLeftover(sessionId: string): boolean {
  try {
    const term = getXterm(sessionId);
    if (!term?.buffer?.active) return true;
    const buf = term.buffer.active;
    const line = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "";
    const { body } = splitPromptAndBody(line);
    return body.trim().length > 0;
  } catch {
    return true;
  }
}

export async function prepareShellAgentExecution(
  sessionId: string,
  command: string,
): Promise<void> {
  const agent = useShellAgentStore.getState().get(sessionId);
  const agentActive = Boolean(agent) && agent!.phase !== "cancelled";
  if (!agentActive) {
    clearRemoteInputLineBeforeExec(sessionId);
    await waitForTerminalOutputIdle(sessionId, 50, 400);
    return;
  }
  // 路由 AI 后 userTyping 已是 false，但 PTY 上常还留着「现在的时间」。
  // 不在这里清行，注入 date 会变成 `date现在的时间`。
  const mustClear =
    !isPowerShellSession(sessionId) ||
    getEnterGateFlags(sessionId).userTyping ||
    remoteInputLineHasLeftover(sessionId);
  if (mustClear) {
    clearRemoteInputLineBeforeExec(sessionId);
    await waitForTerminalOutputIdle(sessionId, 50, 500);
    if (!isPowerShellSession(sessionId) && remoteInputLineHasLeftover(sessionId)) {
      writeTerminalRaw(sessionId, "\x03");
      await waitForTerminalOutputIdle(sessionId, 50, 400);
    }
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

  clearShellAgentThinkingFull(sessionId);
  clearLastFrozenThinking(sessionId);
  clearArchivedDisplayToolIds(sessionId);

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
  stopPowerShellIdleCursorWatch(sessionId);
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
  stopPowerShellIdleCursorWatch(sessionId);
  const cur = useShellAgentStore.getState().get(sessionId);
  if (cur?.blockId) {
    cancelInlineAiBlock(sessionId, cur.blockId);
    cancelPendingInlineTools(cur.blockId);
  }
  // 冻结当前流内卡进 scrollback；开新 thread，但保留已归档 decoration（勿 clearShellAgentGeometry）
  archiveActiveInlineCard(sessionId);
  useShellAgentStore.getState().newAgentThread(sessionId);
  clearShellAgentThinkingFull(sessionId);
  clearLastFrozenThinking(sessionId);
  clearArchivedDisplayToolIds(sessionId);
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
  pushShellAgentDebugEvent("streaming", `prev=${prev?.phase ?? "none"}`);

  // 命令还在 PTY 回显：禁止切 streaming / 钉思考卡，否则半截输出会钻到卡后面
  if (isAgentBusyExecuting(sessionId) || prev?.phase === "executing") {
    pendingReanchorKind.set(sessionId, "final");
    pushShellAgentDebugEvent("streaming deferred", "wait exec");
    return;
  }

  const wasAfterExec =
    prev?.phase === "observing" || prev?.phase === "awaiting_approval";
  store.setPhase(sessionId, "streaming");

  // 询问刚提交、正在/即将钉思考卡：禁止误切 final
  if (pendingReanchorKind.get(sessionId) === "thinking") {
    return;
  }

  // 确认位思考卡正在等正文：禁止再 schedule 把卡重钉成空的「正在理解意图」
  if (finalSettleInFlight.has(sessionId)) return;

  if (!wasAfterExec) return;

  // 打字中：记下待重锚 final，结束后由 flush 处理
  if (getEnterGateFlags(sessionId).userTyping) {
    pendingReanchorKind.set(sessionId, "final");
    return;
  }

  const geo = getShellAgentGeometry(sessionId);
  if (
    geo?.decoration &&
    (geo.cardKind === "final" || geo.cardKind === "thinking") &&
    !isShellAgentCursorPastPlaceholder(sessionId)
  ) {
    return;
  }

  // Native 工具后续无 PTY 回显：立刻钉思考/结果卡，让 token 流式进来。
  // 跑命令才走 settle（等 CookedValue 这类半截输出落定）。
  if (!execOutputFloor.has(sessionId)) {
    pinFollowupCardNow(sessionId);
    return;
  }

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
  pendingReanchorKind.delete(sessionId);

  const geoEarly = getShellAgentGeometry(sessionId);
  const phaseNow = useShellAgentStore.getState().get(sessionId)?.phase;
  const deferForThought =
    execOutputFloor.has(sessionId) ||
    finalSettleInFlight.has(sessionId) ||
    postExecThinking.has(sessionId) ||
    (geoEarly?.cardKind === "thinking" &&
      Boolean(geoEarly.decoration) &&
      (phaseNow === "observing" || phaseNow === "executing"));

  // 输出未落定 / 思考卡还在确认位：先让本轮思考流出来，再切确认卡
  if (deferForThought) {
    cmdAfterSettle.add(sessionId);
    pushShellAgentDebugEvent(
      "approvalPending deferred",
      execOutputFloor.has(sessionId) ? "wait exec output" : "wait thinking",
    );
    if (!finalSettleInFlight.has(sessionId)) {
      scheduleFinalCardAfterExec(sessionId);
    }
    return;
  }

  useShellAgentStore.getState().setPhase(sessionId, "awaiting_approval");
  const geo = getShellAgentGeometry(sessionId);
  const past = isShellAgentCursorPastPlaceholder(sessionId);
  // thinking / final / ask 必须归档后另钉确认卡，禁止同槽换肤把结果卡吃掉
  if (
    !geo?.decoration ||
    geo.cardKind === "thinking" ||
    geo.cardKind === "ask" ||
    geo.cardKind === "final" ||
    past
  ) {
    reanchorShellAgentCard(sessionId, "cmd");
  } else {
    setShellAgentCardKind(sessionId, "cmd");
  }
  ensureMinCardRows(sessionId, "cmd");
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
  if (!executing) {
    execOutputReady.add(sessionId);
    scheduleFinalCardAfterExec(sessionId);
    return;
  }

  abortFinalSettle(sessionId);
  const stray = getShellAgentGeometry(sessionId);
  // 自动同意：思考卡归档为「思考完成」，再钉与手动确认卡同款的「自动同意」卡。
  if (stray?.cardKind === "thinking" && stray.decoration) {
    pinFrozenAgreedCmdCard(sessionId);
    return;
  }

  // 同意后：把确认卡封成「已同意」留在 scrollback
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

    // 跑命令不另钉工具条：确认卡（已同意）就是调用卡。命令在卡下真实执行。
    snapshotExecOutputFloor(sessionId);
    archiveActiveInlineCard(sessionId);
    ensureCursorBelowCards(sessionId);
    return;
  }
  snapshotExecOutputFloor(sessionId);
}

/**
 * 非跑命令工具（web_search / fetch / …）开始：归档思考卡，钉工具条槽。
 * 跑命令不走这里——确认卡已替代调用卡。
 */
export function notifyShellAgentDisplayTool(sessionId: string): boolean {
  pushShellAgentDebugEvent("displayTool", "pin strip slot");
  const geo = getShellAgentGeometry(sessionId);
  if (geo?.cardKind === "ask") return true;
  if (suppressStripPin.has(sessionId) && geo?.cardKind === "thinking") {
    if (!getShellAgentThinkingFull(sessionId).trim()) {
      pushShellAgentDebugEvent("displayTool", "skip: thinking just pinned");
      return false;
    }
    suppressStripPin.delete(sessionId);
  }
  if (geo?.cardKind === "thinking" || geo?.cardKind === "final") {
    const freshThought = freshPostToolThinking(sessionId);
    // 刚钉上的思考卡：等 Overlay 把正文写入 cache，禁止立刻改回工具条对打
    if (geo.cardKind === "thinking" && !getShellAgentThinkingFull(sessionId).trim() && freshThought) {
      pushShellAgentDebugEvent("displayTool", "wait thinking paint");
      return false;
    }
    captureThinkingBeforeArchive(sessionId);
    const thinking =
      currentTurnThinkingText(scopedAiThread(sessionId)) ||
      getShellAgentThinkingFull(sessionId);
    if (thinking) setShellAgentThinkingFull(sessionId, thinking);
    // 上一张思考已冻成「思考完成」，当前空槽直接换工具条，禁止再写 \r\n 留空洞。
    // 有新思考窗口时禁止走这条：否则 afterDisplayTools 会再钉思考卡，死循环。
    if (
      geo.cardKind === "thinking" &&
      !getShellAgentThinkingFull(sessionId).trim() &&
      getLastFrozenThinking(sessionId).trim() &&
      !freshThought
    ) {
      setShellAgentCardKind(sessionId, "cmd");
      return true;
    }
    // 思考还没写上就冻卡，流里只会留下「正在理解意图」——正文等于丢了。
    // final 空占位同理：多半是新一轮被误升的结果卡，不能当工具条冻进去。
    if (
      (geo.cardKind === "thinking" || geo.cardKind === "final") &&
      !getShellAgentThinkingFull(sessionId).trim() &&
      !getLastFrozenThinking(sessionId).trim() &&
      !currentTurnResultText(scopedAiThread(sessionId)).trim()
    ) {
      return false;
    }
  }

  const incoming = collectDisplayToolCalls(scopedAiThread(sessionId)).filter(
    (tc) =>
      tc.status !== "rejected" &&
      !getArchivedDisplayToolIds(sessionId).has(tc.id),
  );

  if (geo?.mode === "inline" && geo.cardKind === "cmd" && geo.decoration) {
    if (incoming.length === 0) return true;
    const liveHtml =
      geo.decoration.element?.innerHTML ??
      "";
    const shown = collectDisplayToolIdsFromHtml(liveHtml);
    // 刚钉的空槽等 React 画上，禁止连冻空卡
    if (shown.length === 0) return true;
    // 活条已在画这些工具：不重复钉 search
    if (incoming.every((tc) => shown.includes(tc.id))) return true;
  }

  abortFinalSettle(sessionId);
  postExecThinking.delete(sessionId);
  suppressStripPin.delete(sessionId);
  reanchorShellAgentCard(sessionId, "cmd", undefined, 2);
  return true;
}

/** Native 工具后续：立刻钉思考/结果槽，禁止等 PTY idle 再倒全文 */
function pinFollowupCardNow(sessionId: string, kind?: "thinking" | "final"): void {
  const geo = getShellAgentGeometry(sessionId);
  if (geo?.cardKind === "ask") return;
  const want = kind ?? resolvePostExecCardKind(sessionId);
  if (want === "thinking") {
    const raw = currentTurnThinkingText(scopedAiThread(sessionId)).trim();
    if (raw && isSameAsLastFrozenThinking(sessionId, raw)) return;
  }
  if (
    geo?.decoration &&
    geo.cardKind === want &&
    !isShellAgentCursorPastPlaceholder(sessionId)
  ) {
    return;
  }
  if (want === "thinking") {
    postExecThinking.add(sessionId);
  } else {
    postExecThinking.delete(sessionId);
  }
  abortFinalSettle(sessionId);
  reanchorShellAgentCard(sessionId, want);
}

/**
 * Native 工具（搜索 / 抓取等）已全部完成：立刻钉思考卡让续写流式进来。
 * 禁止走 scheduleFinalCardAfterExec（那是给命令回显用的，会干等再一次性倒出全文）。
 */
export function notifyShellAgentAfterDisplayTools(sessionId: string): void {
  patchEnterGateFlags(sessionId, { agentExecuting: false });
  const store = useShellAgentStore.getState();
  if (store.get(sessionId)?.phase !== "observing") {
    store.setPhase(sessionId, "observing");
  }
  const incoming = collectDisplayToolCalls(scopedAiThread(sessionId)).filter(
    (tc) =>
      tc.status !== "rejected" &&
      !getArchivedDisplayToolIds(sessionId).has(tc.id),
  );
  const geo = getShellAgentGeometry(sessionId);
  const shown =
    geo?.mode === "inline" && geo.cardKind === "cmd" && geo.decoration
      ? collectDisplayToolIdsFromHtml(geo.decoration.element?.innerHTML ?? "")
      : [];
  // 刚钉的空槽等 React 画上。空 HTML 再钉会复制一张工具条，中间留下 \r\n 空洞。
  if (geo?.mode === "inline" && geo.cardKind === "cmd" && geo.decoration && shown.length === 0) {
    pushShellAgentDebugEvent("afterDisplayTools", "wait strip paint");
    return;
  }
  const thinking = freshPostToolThinking(sessionId);
  const result = currentTurnResultText(scopedAiThread(sessionId)).trim();
  // 先钉新思考卡，再钉下一条。旧思考不是新窗口，禁止再开一张重复卡。
  if (thinking) {
    if (geo?.cardKind === "thinking" && geo.decoration) {
      pushShellAgentDebugEvent("afterDisplayTools", "already thinking");
      return;
    }
    pushShellAgentDebugEvent("afterDisplayTools", "pin thinking now");
    abortFinalSettle(sessionId);
    suppressStripPin.add(sessionId);
    pinFollowupCardNow(sessionId, "thinking");
    return;
  }
  if (shown.length > 0 && incoming.some((tc) => !shown.includes(tc.id))) {
    pushShellAgentDebugEvent("afterDisplayTools", "pin next strip");
    notifyShellAgentDisplayTool(sessionId);
    return;
  }
  if (result) {
    pushShellAgentDebugEvent("afterDisplayTools", "pin final now");
    abortFinalSettle(sessionId);
    pinFollowupCardNow(sessionId, "final");
    return;
  }
  pushShellAgentDebugEvent("afterDisplayTools", "stay on strip");
}

/** 续写正文已到：有思考则冻成「思考完成」再另钉结果卡，禁止最后一轮被结果卡换肤吃掉 */
export function notifyShellAgentPromoteToFinal(sessionId: string): void {
  postExecThinking.delete(sessionId);
  const geo = getShellAgentGeometry(sessionId);
  if (geo?.cardKind === "thinking" && geo.decoration) {
    captureThinkingBeforeArchive(sessionId);
    if (getShellAgentThinkingFull(sessionId).trim()) {
      pushShellAgentDebugEvent("promoteToFinal", "archive thinking + pin final");
      reanchorShellAgentCard(sessionId, "final");
      return;
    }
  }
  setShellAgentCardKind(sessionId, "final");
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
  scheduleFinalCardAfterExec(sessionId);
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
  ) || collectDisplayToolCalls(block.aiThread).some(
    (item) => item.status === "pending" || item.status === "running",
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
        startPowerShellIdleCursorWatch(sessionId);
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

function pinFrozenAgreedCmdCard(sessionId: string): void {
  cmdAfterSettle.delete(sessionId);
  markShellAgentConfirmFreeze(sessionId, "auto-agreed");

  const geo = getShellAgentGeometry(sessionId);
  if (geo?.cardKind === "thinking" && geo.decoration) {
    captureThinkingBeforeArchive(sessionId);
    archiveActiveInlineCard(sessionId);
  }

  const live = getShellAgentGeometry(sessionId);
  if (live?.mode === "inline" && live.cardKind === "cmd" && live.decoration) {
    const html = live.decoration.element?.innerHTML ?? "";
    if (html.includes("term-shell-agent-tool")) {
      snapshotExecOutputFloor(sessionId);
      return;
    }
    markShellAgentConfirmFreeze(sessionId, "auto-agreed");
    archiveActiveInlineCard(sessionId);
    snapshotExecOutputFloor(sessionId);
    ensureCursorBelowCards(sessionId);
    return;
  }

  if (!getShellAgentLastCmd(sessionId)?.command) {
    snapshotExecOutputFloor(sessionId);
    return;
  }

  // 与手动确认卡同高、同布局，只把状态文案改成「自动同意」
  reanchorShellAgentCard(sessionId, "cmd", () => {
    markShellAgentConfirmFreeze(sessionId, "auto-agreed");
    archiveActiveInlineCard(sessionId);
    snapshotExecOutputFloor(sessionId);
    ensureCursorBelowCards(sessionId);
  });
}

function clearPromptReleaseGuard(sessionId: string): void {
  promptReleasedForTurn.delete(sessionId);
  finalSettleGen.delete(sessionId);
  releaseInFlight.delete(sessionId);
  clearExecOutputFloor(sessionId);
  cmdAfterSettle.delete(sessionId);
  postExecThinking.delete(sessionId);
  finalSettleInFlight.delete(sessionId);
  settleRetryCount.delete(sessionId);
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

  // 思考卡已在流内：本轮结束直接升结果 / 收官，勿再等 PTY settle（会卡住转圈）。
  if (geo?.decoration && geo.cardKind === "thinking") {
    if (isAgentBusyExecuting(sessionId)) {
      pendingReanchorKind.set(sessionId, "final");
      return;
    }
    if (resolvePostExecCardKind(sessionId) === "final") {
      notifyShellAgentPromoteToFinal(sessionId);
    }
    scheduleTurnFinishFallback(sessionId);
    return;
  }

  // Native 工具条已完成、无 PTY 回显：立刻钉结果/思考，勿走 settle 倒全文
  if (geo?.decoration && geo.cardKind === "cmd" && !execOutputFloor.has(sessionId)) {
    pinFollowupCardNow(sessionId);
    scheduleTurnFinishFallback(sessionId);
    return;
  }

  // 命令输出已在卡下方，或仍停在工具条/确认槽：禁止原地改 final（会盖住调用卡或回显）
  if (geo?.decoration && geo.cardKind === "cmd") {
    scheduleFinalCardAfterExec(sessionId, () => scheduleTurnFinishFallback(sessionId));
    return;
  }

  if (geo?.decoration && geo.cardKind === "final") {
    scheduleTurnFinishFallback(sessionId);
    return;
  }

  // 无 live decoration（确认卡已冻、SSH 等）：勿直接 release，
  // 否则会与 scheduleFinalCardAfterExec 抢跑，结果卡要等用户再敲一条才出现。
  if (
    cur.phase === "streaming" ||
    cur.phase === "observing" ||
    cur.phase === "executing"
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
