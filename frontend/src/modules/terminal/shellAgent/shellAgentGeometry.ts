import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { findTerminalPane } from "@/stores/terminalStore";
import { lineLooksLikeShellPrompt } from "../passthroughAi/screenLine";
import { getXterm } from "../xtermRegistry";
import {
  agreedCmdCopy,
  buildAgreedCmdFrozenHtml,
  buildRejectedCmdFrozenHtml,
  buildThinkingDoneFrozenHtml,
  consumeShellAgentConfirmFreeze,
  getShellAgentLastCmd,
  getShellAgentThinkingFull,
  clearShellAgentThinkingFull,
  extractThinkingFromLiveHtml,
  rememberFrozenThinking,
  collectDisplayToolIdsFromHtml,
  markArchivedDisplayToolIds,
  transformPendingConfirmToAgreedHtml,
  transformPendingConfirmToRejectedHtml,
} from "./thinkingCache";

/** 明确的 PowerShell 会话（用于禁止本地假 prompt 前缀等） */
function sessionIsPowerShell(sessionId: string): boolean {
  const pane = findTerminalPane(sessionId);
  if (!pane) return false;
  const kind = pane.shellSpec?.kind;
  if (kind === "powershell" || kind === "powershell5") return true;
  return /powershell|pwsh/i.test(pane.shellLabel ?? "");
}

export type ShellAgentCardKind = "thinking" | "cmd" | "ask" | "final";
/** inline：流内 decoration；idle：已归档、暂无活卡；detached：钉卡失败，才允许浮层兜底 */
export type ShellAgentGeometryMode = "inline" | "idle" | "detached";

export type ShellAgentGeometry = {
  mode: ShellAgentGeometryMode;
  cardKind: ShellAgentCardKind | null;
  marker: IMarker | null;
  decoration: IDecoration | null;
  /** 占位行数（= decoration height） */
  rows: number;
  /** 占位区首行的 buffer 绝对行号（marker.line 快照；命令回显锚点 = anchorLine + rows） */
  anchorLine: number;
  promptIndentCols: number;
  promptPrefix: string;
  query: string;
  /** 每次几何变化 +1，驱动 React 订阅 */
  version: number;
};

const MIN_CARD_ROWS = 1;
const MAX_CARD_ROWS = 24;
/** 询问表单可更高，但仍不超过终端可视行数，超出部分靠卡内滚动 */
const MAX_ASK_CARD_ROWS = 48;
/** 最终解读占位上限；实际还受终端可视行-1 约束，超出在卡内滚动 */
const MAX_FINAL_CARD_ROWS = 96;

/** 建卡时的最小占位行数（实际高度由 fitShellAgentCardToContent 测量） */
export function minCardRowsFor(kind?: ShellAgentCardKind): number {
  // 思考卡固定矮卡（一行预览）；占 2 行。再高冻结后缩 decoration 也清不掉 buffer，空白会累加。
  if (kind === "thinking") return 2;
  // 询问表单通常多行，预留更高占位
  if (kind === "ask") return 6;
  // 结果卡按内容 fit；从 1 行起跳，避免起步过高留下空白带
  if (kind === "final") return 1;
  // 确认卡首帧就要挡住命令行：1 行起步会在首次贴底滚动时盖住回显
  if (kind === "cmd") return 6;
  return MIN_CARD_ROWS;
}

/** @deprecated 历史固定高度；请用 fitShellAgentCardToContent */
export function cardRowsFor(_kind: ShellAgentCardKind): number {
  return MIN_CARD_ROWS;
}

function terminalRowHeightPx(sessionId: string): number {
  const term = getXterm(sessionId);
  if (!term?.element || term.rows <= 0) return 18;
  const rowsEl = term.element.querySelector(".xterm-rows");
  const viewHeight =
    rowsEl?.getBoundingClientRect().height ?? term.element.clientHeight;
  return Math.max(1, viewHeight / term.rows);
}

function maxCardRowsFor(
  sessionId: string,
  kind: ShellAgentCardKind | null | undefined,
): number {
  const term = getXterm(sessionId);
  const viewportCap = term
    ? Math.max(MIN_CARD_ROWS, (term.rows || MAX_CARD_ROWS) - 1)
    : MAX_CARD_ROWS;
  if (kind === "ask") {
    return Math.min(MAX_ASK_CARD_ROWS, viewportCap);
  }
  // final：占位最多一屏减一行，把 prompt 留在卡下。更高的解读在卡内滚动，
  // 不能靠 overflow:visible 画出 decoration——终端视口会裁掉，且 prompt
  // 已在卡下时禁止再写 \r\n 扩 buffer。
  if (kind === "final") {
    return Math.min(MAX_FINAL_CARD_ROWS, viewportCap);
  }
  return Math.min(MAX_CARD_ROWS, viewportCap);
}

/** 将 portal 内容像素高度换算为 decoration 占位行数 */
export function contentHeightToCardRows(
  sessionId: string,
  contentHeightPx: number,
  kind?: ShellAgentCardKind | null,
  opts?: { minRows?: number; padRows?: number },
): number {
  const rowH = terminalRowHeightPx(sessionId);
  const raw = contentHeightPx / rowH;
  // final 不再减 0.1：少 1px 就会被 overflow:hidden 裁掉底边框
  const rows = Math.ceil(raw);
  // ask：略留空行，避免 decoration 矮于卡片盖住下方回显。
  // final 不再 +1：footer 按钮已删，padRows=1 会留一整行空白。
  // cmd 工具条不要再 +2：会把 1 行 search 撑成大片空白，且 \r\n 写进 buffer 后缩 decoration 也清不掉。
  const pad =
    opts?.padRows ?? (kind === "ask" ? 1 : 0);
  const hardMax = maxCardRowsFor(sessionId, kind);
  const min =
    opts?.minRows ??
    (kind === "thinking"
      ? minCardRowsFor("thinking")
      : kind === "cmd"
        ? minCardRowsFor("cmd")
        : MIN_CARD_ROWS);
  return Math.min(hardMax, Math.max(min, rows + pad));
}

const geometries = new Map<string, ShellAgentGeometry>();
const listeners = new Set<(sessionId: string) => void>();

/** restoreSnapshot / dispose 窗口内禁止再写 \r\n 占位 */
const geometryWriteSuspended = new Set<string>();

export function setShellAgentGeometryWriteSuspended(
  sessionId: string,
  suspended: boolean,
): void {
  if (suspended) geometryWriteSuspended.add(sessionId);
  else geometryWriteSuspended.delete(sessionId);
}

function isGeometryWriteSuspended(sessionId: string): boolean {
  return geometryWriteSuspended.has(sessionId);
}

type ArchivedShellAgentCard = {
  decoration: IDecoration;
  marker: IMarker;
  rows: number;
  anchorLine: number;
};

/** 已冻结、留在 scrollback 的历史卡片（decoration/marker 不 dispose） */
const archivedBySession = new Map<string, ArchivedShellAgentCard[]>();

function pushArchived(sessionId: string, entry: ArchivedShellAgentCard): void {
  const list = archivedBySession.get(sessionId) ?? [];
  list.push(entry);
  archivedBySession.set(sessionId, list);
}

function markerLine(marker: IMarker | null | undefined, fallback: number): number {
  try {
    if (marker && !marker.isDisposed && typeof marker.line === "number" && marker.line >= 0) {
      return marker.line;
    }
  } catch {
    // ignore
  }
  return fallback;
}

/** 当前流内卡 + 已归档卡的占位区间 [start, end) */
export function listShellAgentCardRanges(
  sessionId: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const geo = geometries.get(sessionId);
  if (geo?.mode === "inline" && geo.anchorLine >= 0) {
    const start = markerLine(geo.marker, geo.anchorLine);
    ranges.push({ start, end: start + Math.max(1, geo.rows) });
  }
  for (const a of archivedBySession.get(sessionId) ?? []) {
    const start = markerLine(a.marker, a.anchorLine);
    ranges.push({ start, end: start + Math.max(1, a.rows) });
  }
  return ranges;
}

/** 所有卡片占位的最底下一行（不含该行，即第一行可输入行） */
export function cardsBottomLine(sessionId: string): number | null {
  const ranges = listShellAgentCardRanges(sessionId);
  if (ranges.length === 0) return null;
  return ranges.reduce((max, r) => Math.max(max, r.end), -1);
}

export function cursorInsideAnyCard(sessionId: string, cursorAbs: number): boolean {
  return listShellAgentCardRanges(sessionId).some(
    (r) => cursorAbs >= r.start && cursorAbs < r.end,
  );
}

function readCursorAbs(term: Terminal): number | null {
  try {
    const buf = term.buffer?.active;
    if (!buf) return null;
    return buf.baseY + buf.cursorY;
  } catch {
    return null;
  }
}

/**
 * 光标若还在历史/当前卡占位区内，本地换行推到卡下。
 * PowerShell 禁止为此向 PTY 发 Enter。
 */
export function ensureCursorBelowCards(sessionId: string, then?: () => void): void {
  const term = getXterm(sessionId);
  if (!term) {
    then?.();
    return;
  }
  const bottom = cardsBottomLine(sessionId);
  const cursor = readCursorAbs(term);
  if (bottom == null || cursor == null) {
    then?.();
    return;
  }
  const gap = bottom - cursor;
  if (gap <= 0) {
    then?.();
    return;
  }
  try {
    term.write("\r\n".repeat(gap), () => then?.());
  } catch {
    then?.();
  }
}

/** 等 React portal 卸载完成后再动 decoration DOM（避免 removeChild 崩溃） */
function afterReactPortalUnmount(fn: () => void): void {
  queueMicrotask(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(fn);
    });
  });
}

export const SHELL_AGENT_PORTAL_HOST_CLASS = "term-shell-agent-portal-host";

function getPortalHost(el: HTMLElement): HTMLElement | null {
  return el.querySelector(`:scope > .${SHELL_AGENT_PORTAL_HOST_CLASS}`);
}

/**
 * 等 portal host 空闲（React 已卸子树）再改 decoration DOM。
 * 仅靠 2×rAF 不够：archive 常在 React commit 之前就触发 inject。
 */
function whenDecorationPortalIdle(
  deco: IDecoration,
  fn: () => void,
  attempts = 24,
): void {
  afterReactPortalUnmount(() => {
    try {
      const el = deco.element;
      if (!el) {
        fn();
        return;
      }
      const host = getPortalHost(el);
      if (host && host.childNodes.length > 0 && attempts > 0) {
        whenDecorationPortalIdle(deco, fn, attempts - 1);
        return;
      }
      if (host && host.childNodes.length === 0) {
        try {
          host.remove();
        } catch {
          // ignore
        }
      }
      fn();
    } catch {
      if (attempts > 0) {
        whenDecorationPortalIdle(deco, fn, attempts - 1);
      } else {
        fn();
      }
    }
  });
}

function injectFrozenCardSnapshot(
  deco: IDecoration,
  frozenHtml: string,
  sessionId?: string,
): void {
  whenDecorationPortalIdle(deco, () => {
    try {
      const el = deco.element;
      if (!el) return;
      const snapshot = document.createElement("div");
      snapshot.className =
        "term-shell-agent-deco-card term-shell-agent-deco-card--frozen";
      snapshot.innerHTML = frozenHtml;
      // 冻结卡需可点「展开 / 查看」；子节点再用 CSS 精确接管
      snapshot.style.pointerEvents = "auto";
      // 同步主题变量，避免 scrollback 冻结卡在深色主题下掉回浅色默认
      const cs = getComputedStyle(document.documentElement);
      for (const key of [
        "--bg",
        "--bg-deeper",
        "--surface",
        "--surface-hover",
        "--fg",
        "--fg-2",
        "--muted",
        "--meta",
        "--border",
        "--border-soft",
        "--accent",
        "--accent-soft",
        "--success",
        "--warn",
        "--danger",
        "--danger-soft",
        "--font-mono",
        "--r-sm",
      ]) {
        const value = cs.getPropertyValue(key).trim();
        if (value) {
          el.style.setProperty(key, value);
          snapshot.style.setProperty(key, value);
        }
      }
      el.replaceChildren(snapshot);
      if (!el.dataset.shellAgentDecoDisplay) {
        el.dataset.shellAgentDecoDisplay = "block";
      }
      shieldShellAgentDecorationPointer(
        el,
        sessionId ? getXterm(sessionId) : null,
      );
    } catch {
      // ignore
    }
  });
}

/** 工具条冻结时补标记，便于 scrollback 委托展开 */
function annotateFrozenToolHtml(sessionId: string, liveHtml: string): string {
  return liveHtml.replace(
    /<div(\s+)([^>]*class="[^"]*term-shell-agent-tool[^"]*"[^>]*)>/g,
    (full, sp, attrs) => {
      if (/\bdata-shell-agent-frozen-tool=/.test(attrs)) return full;
      const sid = /\bdata-session-id=/.test(attrs)
        ? ""
        : ` data-session-id="${sessionId.replace(/"/g, "&quot;")}"`;
      return `<div${sp}${attrs} data-shell-agent-frozen-tool="1"${sid}>`;
    },
  );
}

/** 询问卡冻结：保留提交前完整表单高度/选项，并标成已回答 */
function annotateFrozenAskHtml(sessionId: string, liveHtml: string): string {
  let html = liveHtml.trim();
  if (!html) return html;
  html = html.replace(
    /\bdata-status="pending"/g,
    'data-status="answered"',
  );
  // 头部状态文案（中/英）
  html = html
    .replace(/>\s*待回答\s*</g, ">已回答<")
    .replace(/>\s*Pending\s*</gi, ">Answered<");
  // 冻结后不可再点提交/跳过
  html = html.replace(/<button\b(?![^>]*\bdisabled\b)/gi, "<button disabled");
  if (/\bdata-shell-agent-frozen-ask=/.test(html)) {
    return html;
  }
  return html.replace(
    /<div(\s+)([^>]*class="[^"]*term-shell-agent-card--ask[^"]*"[^>]*)>/,
    (full, sp, attrs) => {
      if (/\bdata-shell-agent-frozen-ask=/.test(attrs)) return full;
      const sid = /\bdata-session-id=/.test(attrs)
        ? ""
        : ` data-session-id="${sessionId.replace(/"/g, "&quot;")}"`;
      return `<div${sp}${attrs} data-shell-agent-frozen-ask="1"${sid}>`;
    },
  );
}

function resolveFrozenHtml(
  sessionId: string,
  cardKind: ShellAgentCardKind | null,
  liveHtml: string,
): string {
  if (cardKind === "thinking") {
    const full =
      getShellAgentThinkingFull(sessionId).trim() ||
      extractThinkingFromLiveHtml(liveHtml);
    clearShellAgentThinkingFull(sessionId);
    if (!full) return "";
    rememberFrozenThinking(sessionId, full);
    return buildThinkingDoneFrozenHtml({
      sessionId,
      fullText: full,
    });
  }
  if (cardKind === "ask") {
    return annotateFrozenAskHtml(sessionId, liveHtml);
  }
  if (cardKind === "cmd") {
    const last = getShellAgentLastCmd(sessionId);
    const freezeKind = consumeShellAgentConfirmFreeze(sessionId);
    // 仅在明确同意/拒绝意图下冻成终态；禁止把待确认/工具条误冻成「已同意」
    if (freezeKind === "agreed" || freezeKind === "auto-agreed") {
      const { agreedLabel, autoAgreedLabel } = agreedCmdCopy();
      const label = freezeKind === "auto-agreed" ? autoAgreedLabel : agreedLabel;
      const transformed = transformPendingConfirmToAgreedHtml(liveHtml, {
        sessionId,
        command: last?.command,
        toolId: last?.toolId,
        agreedLabel: label,
      });
      if (transformed) return transformed;
      if (last?.command) {
        return buildAgreedCmdFrozenHtml({
          sessionId,
          command: last.command,
          toolId: last.toolId,
          description: last.description,
          agreedLabel: label,
        });
      }
    }
    if (freezeKind === "rejected") {
      const transformed = transformPendingConfirmToRejectedHtml(liveHtml, {
        sessionId,
        command: last?.command,
        toolId: last?.toolId,
      });
      if (transformed) return transformed;
      if (last?.command) {
        return buildRejectedCmdFrozenHtml({
          sessionId,
          command: last.command,
          toolId: last.toolId,
          description: last.description,
        });
      }
    }
    // 工具条原样冻结
    if (liveHtml.includes("term-shell-agent-tool")) {
      return annotateFrozenToolHtml(sessionId, liveHtml);
    }
    // 待确认等其它 cmd：原样保留，绝不默认升成「已同意」
    return liveHtml;
  }
  return liveHtml;
}

/**
 * 将当前流内卡冻结进 scrollback（React portal 卸载后回填快照，避免空白）。
 * 思考卡 →「思考完成」；确认卡 →「已同意」命令卡（避免被工具条顶替后留空白高槽）。
 */
export function archiveActiveInlineCard(sessionId: string): void {
  const prev = geometries.get(sessionId);
  if (!prev || prev.mode !== "inline" || !prev.decoration || !prev.marker) return;

  const deco = prev.decoration;
  const marker = prev.marker;
  const host = deco.element ? getPortalHost(deco.element) : null;
  const liveHtml = (host?.innerHTML ?? deco.element?.innerHTML ?? "").trim();
  const frozenHtml = resolveFrozenHtml(sessionId, prev.cardKind, liveHtml);

  setGeometry(sessionId, {
    ...prev,
    mode: "idle",
    cardKind: null,
    marker: null,
    decoration: null,
    rows: 0,
    anchorLine: -1,
    version: prev.version + 1,
  });

  freezeOutgoingDecoration({
    sessionId,
    term: getXterm(sessionId),
    decoration: deco,
    marker,
    kind: prev.cardKind,
    liveHtml,
    frozenHtml,
    prevRows: prev.rows,
    indentCols: prev.promptIndentCols,
    anchorLine: prev.anchorLine,
  });
}

export function subscribeShellAgentGeometry(fn: (sessionId: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(sessionId: string): void {
  for (const fn of listeners) {
    try {
      fn(sessionId);
    } catch {
      // 订阅异常不影响几何主链路
    }
  }
}

export function getShellAgentGeometry(sessionId: string): ShellAgentGeometry | null {
  return geometries.get(sessionId) ?? null;
}

function setGeometry(sessionId: string, geo: ShellAgentGeometry): void {
  geometries.set(sessionId, geo);
  if (import.meta.env.DEV) {
    try {
      const term = getXterm(sessionId);
      document.body.dataset.shellAgentGeo = JSON.stringify({
        t: Date.now(),
        mode: geo.mode,
        cardKind: geo.cardKind,
        rows: geo.rows,
        hasDeco: Boolean(geo.decoration),
        version: geo.version,
        anchorLine: geo.anchorLine,
        markerLine: geo.marker && !geo.marker.isDisposed ? geo.marker.line : null,
        baseY: term ? term.buffer.active.baseY : null,
        cursorY: term ? term.buffer.active.cursorY + term.buffer.active.baseY : null,
      });
    } catch {
      // ignore
    }
  }
  emit(sessionId);
}

function disposeDecoration(geo: ShellAgentGeometry | null): void {
  const deco = geo?.decoration;
  if (!deco) return;
  // 延后 dispose：避免 xterm 拆掉 DOM 时 React portal 仍在卸子节点
  whenDecorationPortalIdle(deco, () => {
    try {
      deco.dispose();
    } catch {
      // ignore
    }
  });
  // 禁止 element.remove()：会与 createPortal 卸载竞态，触发 removeChild NotFoundError
}

function disposeMarker(geo: ShellAgentGeometry | null): void {
  const marker = geo?.marker;
  if (!marker || marker.isDisposed) return;
  try {
    marker.dispose();
  } catch {
    // ignore
  }
}

function freshGeometry(
  partial?: Partial<ShellAgentGeometry>,
): ShellAgentGeometry {
  return {
    mode: "inline",
    cardKind: null,
    marker: null,
    decoration: null,
    rows: 0,
    anchorLine: -1,
    promptIndentCols: 2,
    promptPrefix: "$ ",
    query: "",
    version: 0,
    ...partial,
  };
}

/**
 * 拦截 decoration 上的 mousedown，避免冒泡到 xterm SelectionService
 * （否则拖选卡片会选中底层占位空行）。不 preventDefault，保留 DOM 选中与按钮点击。
 */
export function shieldShellAgentDecorationPointer(
  el: HTMLElement,
  term?: Terminal | null,
): void {
  if (el.dataset.shellAgentPtrShield === "1") return;
  el.dataset.shellAgentPtrShield = "1";
  // 冒泡阶段拦截：先让卡片内按钮/文本选中收到事件，再阻止传到 xterm
  el.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    try {
      term?.clearSelection();
    } catch {
      // ignore
    }
  });
}

function frozenPlaceholderRows(
  kind: ShellAgentCardKind | null,
  liveHtml: string,
  fallback: number,
): number {
  if (kind === "thinking") return 2;
  if (kind === "cmd" && liveHtml.includes("term-shell-agent-tool")) {
    const n = Math.max(1, collectDisplayToolIdsFromHtml(liveHtml).length);
    return Math.max(2, n);
  }
  // 已同意/自动同意/已拒绝：与待确认卡同高，不能压成 2 行矮条。
  if (
    kind === "cmd" &&
    (!liveHtml ||
      liveHtml.includes("is-agreed") ||
      liveHtml.includes("is-rejected"))
  ) {
    return minCardRowsFor("cmd");
  }
  return Math.max(1, fallback);
}

function rememberArchivedDisplayTools(
  sessionId: string,
  kind: ShellAgentCardKind | null,
  liveHtml: string,
): void {
  if (kind !== "cmd" || !liveHtml.includes("term-shell-agent-tool")) return;
  markArchivedDisplayToolIds(sessionId, collectDisplayToolIdsFromHtml(liveHtml));
}

/** 冻结旧卡：记下已展示工具 id，并把 decoration 缩到内容高度，避免卡下空白越积越多 */
function freezeOutgoingDecoration(opts: {
  sessionId: string;
  term: Terminal | null;
  decoration: IDecoration;
  marker: IMarker | null;
  kind: ShellAgentCardKind | null;
  liveHtml: string;
  frozenHtml: string;
  prevRows: number;
  indentCols: number;
  anchorLine: number;
}): void {
  const {
    sessionId,
    term,
    decoration,
    marker,
    kind,
    liveHtml,
    frozenHtml,
    prevRows,
    indentCols,
    anchorLine,
  } = opts;
  rememberArchivedDisplayTools(sessionId, kind, liveHtml);
  if (!frozenHtml && kind === "thinking") {
    try {
      const host = decoration.element ? getPortalHost(decoration.element) : null;
      if (host) host.innerHTML = "";
      else if (decoration.element) decoration.element.innerHTML = "";
      decoration.dispose();
    } catch {
      // ignore
    }
    return;
  }
  let archivedDeco = decoration;
  let archivedRows = Math.max(1, prevRows);
  const freezeRows = frozenPlaceholderRows(kind, liveHtml, archivedRows);
  if (term && marker && freezeRows < archivedRows) {
    const slim = registerCardDecoration(term, marker, freezeRows, indentCols);
    if (slim) {
      archivedDeco = slim;
      archivedRows = freezeRows;
      try {
        decoration.dispose();
      } catch {
        // ignore
      }
    }
  }
  if (marker) {
    pushArchived(sessionId, {
      decoration: archivedDeco,
      marker,
      rows: archivedRows,
      anchorLine: markerLine(marker, anchorLine),
    });
  }
  if (frozenHtml) {
    injectFrozenCardSnapshot(archivedDeco, frozenHtml, sessionId);
  }
}

function terminalCellHeightPx(term: Terminal): number {
  const el = term.element;
  if (!el || term.rows <= 0) return 18;
  const rowsEl = el.querySelector(".xterm-rows") ?? el.querySelector(".xterm-screen");
  const viewHeight =
    rowsEl?.getBoundingClientRect().height ?? el.clientHeight;
  return Math.max(1, viewHeight / term.rows);
}

/**
 * xterm 只按 marker 起始行是否在视口决定 decoration 显隐：起始行一卷出
 * 顶部，整张多行卡会被 display:none，留下空白占位。
 * 仍与视口相交时：负 top + clip-path 裁掉已滚出的顶部，看起来像卡片在往上滑。
 */
export function clipShellAgentDecorationToViewport(opts: {
  viewportY: number;
  viewportRows: number;
  markerLine: number;
  rows: number;
  cellHeight: number;
  el: HTMLElement;
}): "hidden" | "full" | "clipped" {
  const rows = Math.max(1, opts.rows);
  const start = opts.markerLine;
  const end = start + rows;
  const viewEnd = opts.viewportY + opts.viewportRows;
  if (start < 0 || end <= opts.viewportY || start >= viewEnd) {
    opts.el.style.clipPath = "";
    return "hidden";
  }
  const line = start - opts.viewportY;
  const cellH = Math.max(1, opts.cellHeight);
  if (line < 0) {
    const hiddenPx = Math.round(-line * cellH);
    if (opts.el.style.display === "none" || !opts.el.style.display) {
      opts.el.style.display = opts.el.dataset.shellAgentDecoDisplay || "block";
    }
    opts.el.style.top = `${Math.round(line * cellH)}px`;
    opts.el.style.height = `${Math.round(rows * cellH)}px`;
    opts.el.style.clipPath = `inset(${hiddenPx}px 0 0 0)`;
    return "clipped";
  }
  opts.el.style.clipPath = "";
  return "full";
}

function bindDecorationViewportClip(
  term: Terminal,
  decoration: IDecoration,
  rows: number,
): void {
  const apply = (el: HTMLElement) => {
    try {
      const buf = term.buffer?.active;
      clipShellAgentDecorationToViewport({
        viewportY: buf?.viewportY ?? 0,
        viewportRows: term.rows || 24,
        markerLine: decoration.marker?.line ?? -1,
        rows,
        cellHeight: terminalCellHeightPx(term),
        el,
      });
    } catch {
      // ignore
    }
  };
  if (decoration.element) apply(decoration.element);
  decoration.onRender(apply);
}

function registerCardDecoration(
  term: Terminal,
  marker: IMarker,
  rows: number,
  _indentCols: number,
): IDecoration | null {
  try {
    const decoration = term.registerDecoration({
      marker,
      x: 0,
      width: term.cols,
      height: rows,
      layer: "top",
    });
    if (!decoration) return null;
    bindDecorationViewportClip(term, decoration, rows);
    return decoration;
  } catch {
    return null;
  }
}

function failToDetached(
  sessionId: string,
  kind: ShellAgentCardKind | null,
  prev?: ShellAgentGeometry | null,
): void {
  const base = prev ?? geometries.get(sessionId);
  setGeometry(sessionId, {
    ...(base ?? freshGeometry()),
    mode: "detached",
    cardKind: kind,
    marker: null,
    decoration: null,
    rows: 0,
    anchorLine: -1,
    version: (base?.version ?? 0) + 1,
  });
}

/** 撤掉活跃流内卡（归档或清空），不展示任何浮层 UI */
function detachActiveShellAgentGeometry(sessionId: string): void {
  const prev = geometries.get(sessionId);
  if (!prev) return;
  if (prev.mode === "inline" && prev.decoration) {
    archiveActiveInlineCard(sessionId);
    return;
  }
  disposeDecoration(prev);
  disposeMarker(prev);
  setGeometry(sessionId, {
    ...prev,
    mode: "idle",
    cardKind: null,
    marker: null,
    decoration: null,
    rows: 0,
    version: prev.version + 1,
  });
}

/**
 * 入口建卡：调用前光标必须已在占位区首行行首（蓝字问题行绘制完成的回调里）。
 * 失败（无 term / marker / decoration）→ detached（无 UI，由 notify* 重试建卡）。
 */
export function beginShellAgentCard(
  sessionId: string,
  opts: {
    kind: ShellAgentCardKind;
    promptIndentCols: number;
    promptPrefix: string;
    query: string;
  },
): ShellAgentGeometry {
  // 方案 C：无活 xterm 绑定或 restore 中 → 不写占位，避免弄乱快照 buffer
  if (isGeometryWriteSuspended(sessionId)) {
    const prev = geometries.get(sessionId);
    if (prev) return prev;
    return {
      ...freshGeometry({
        cardKind: opts.kind,
        promptIndentCols: Math.max(2, opts.promptIndentCols),
        promptPrefix: opts.promptPrefix,
        query: opts.query,
      }),
      mode: "detached" as const,
    };
  }
  const term = getXterm(sessionId);
  const rows = minCardRowsFor(opts.kind);
  const prev = geometries.get(sessionId);
  if (prev?.mode === "inline" && prev.decoration) {
    archiveActiveInlineCard(sessionId);
  } else {
    disposeDecoration(prev ?? null);
    disposeMarker(prev ?? null);
  }

  const base = freshGeometry({
    cardKind: opts.kind,
    promptIndentCols: Math.max(2, opts.promptIndentCols),
    promptPrefix: opts.promptPrefix,
    query: opts.query,
    version: (prev?.version ?? 0) + 1,
  });

  if (!term) {
    const detached = { ...base, mode: "detached" as const };
    setGeometry(sessionId, detached);
    return detached;
  }

  const attachAt = (
    marker: IMarker,
    usedRows: number,
  ): void => {
    const decoration = registerCardDecoration(
      term,
      marker,
      usedRows,
      base.promptIndentCols,
    );
    if (!decoration) {
      disposeMarker({ ...base, marker });
      const detached = { ...base, mode: "detached" as const };
      setGeometry(sessionId, detached);
      placed = detached;
      return;
    }
    const geo: ShellAgentGeometry = {
      ...base,
      marker,
      decoration,
      rows: usedRows,
      anchorLine: marker.line,
    };
    setGeometry(sessionId, geo);
    placed = geo;
  };

  const place = (): void => {
    const afterMarker = (): void => {
      let marker: IMarker | null = null;
      try {
        marker = term.registerMarker(0);
      } catch {
        marker = null;
      }
      if (!marker) {
        const detached = { ...base, mode: "detached" as const };
        setGeometry(sessionId, detached);
        placed = detached;
        return;
      }

      // 占位只本地 \r\n。PowerShell 向 PTY 发 Enter 会变成 `>>` 续行。
      writeThen(term, "\r\n".repeat(rows), () => {
        attachAt(marker!, rows);
      });
    };

    if (needsBlankLineBeforeMarker(term)) {
      writeThen(term, "\r\n", afterMarker);
    } else {
      afterMarker();
    }
  };

  // 续轮：光标常还停在上一张已归档卡内部，先推到卡下再钉，否则两张 decoration 重叠
  let placed: ShellAgentGeometry | null = null;
  ensureCursorBelowCards(sessionId, () => {
    place();
  });
  return placed ?? getShellAgentGeometry(sessionId) ?? { ...base, mode: "detached" as const };
}

/** 光标是否已离开占位区（命令回显/输出已写在卡下方） */
export function isShellAgentCursorPastPlaceholder(sessionId: string): boolean {
  const geo = geometries.get(sessionId);
  const term = getXterm(sessionId);
  if (!geo || !term || geo.anchorLine < 0) return false;
  try {
    const buf = term.buffer.active;
    const cursorLine = buf.baseY + buf.cursorY;
    return cursorLine > geo.anchorLine + geo.rows;
  } catch {
    return false;
  }
}

function cursorPastPlaceholderEnd(term: Terminal, geo: ShellAgentGeometry): boolean {
  if (geo.anchorLine < 0) return false;
  try {
    const buf = term.buffer.active;
    const cursorLine = buf.baseY + buf.cursorY;
    return cursorLine > geo.anchorLine + geo.rows;
  } catch {
    return false;
  }
}

/** 占位区正下方是否已是空 shell prompt（再写 \r\n 会顶开造成空白） */
function promptSittingJustBelowCard(term: Terminal, geo: ShellAgentGeometry): boolean {
  if (geo.anchorLine < 0) return false;
  try {
    const buf = term.buffer?.active;
    if (!buf) return false;
    const cursorAbs = buf.baseY + buf.cursorY;
    const from = geo.anchorLine + Math.max(1, geo.rows);
    const to = Math.min(buf.length - 1, Math.max(from, cursorAbs) + 2);
    for (let y = from; y <= to; y += 1) {
      const line = (buf.getLine(y)?.translateToString(true) ?? "").replace(/\s+$/u, "");
      if (lineLooksLikeShellPrompt(line) || /^PS\s+\S+>/.test(line)) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function cursorLineLooksLikeEmptyPrompt(term: Terminal): boolean {
  try {
    const buf = term.buffer?.active;
    if (!buf) return false;
    const line = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "";
    return lineLooksLikeShellPrompt(line);
  } catch {
    return false;
  }
}

function cursorLineText(term: Terminal): string {
  try {
    const buf = term.buffer?.active;
    if (!buf) return "";
    return (buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "").replace(
      /\s+$/u,
      "",
    );
  } catch {
    return "";
  }
}

function cursorAtViewportBottom(term: Terminal): boolean {
  try {
    const buf = term.buffer?.active;
    if (!buf) return false;
    return buf.cursorY >= Math.max(0, (term.rows || 1) - 1);
  } catch {
    return false;
  }
}

/**
 * 当前行已有输出/prompt，或光标已贴底（下一笔 \n 会开始滚动）：
 * 必须先换到空行再钉 marker，否则 decoration 会盖住那一行命令。
 * 视口未满时 \n 只是走进空白单元格，所以只有贴底第一次滚动才会暴露这个问题。
 */
export function needsBlankLineBeforeMarker(term: Terminal): boolean {
  if (cursorLineText(term).length > 0) return true;
  if (cursorLineLooksLikeEmptyPrompt(term)) return true;
  return cursorAtViewportBottom(term);
}

function writeThen(term: Terminal, data: string, then: () => void): void {
  if (!data) {
    then();
    return;
  }
  try {
    term.write(data, () => then());
  } catch {
    then();
  }
}


/**
 * 按目标行数调整占位区（可扩可缩 decoration 高度）。
 * 命令已回显、光标离开占位区后禁止再 write \\r\\n，避免把 prompt 顶乱。
 * 关键：先挂新 decoration 再卸旧的，中间不出现 decoration=null（防卡片闪没）。
 */
export function resizeShellAgentCard(
  sessionId: string,
  targetRows: number,
  onReady?: () => void,
): void {
  if (isGeometryWriteSuspended(sessionId)) {
    onReady?.();
    return;
  }
  const prev = geometries.get(sessionId);
  if (!prev || prev.mode !== "inline") {
    onReady?.();
    return;
  }
  const term = getXterm(sessionId);
  const marker = prev.marker;
  if (!term || !marker || marker.isDisposed) {
    if (prev.cardKind === "cmd" || prev.cardKind === "ask") {
      failToDetached(sessionId, prev.cardKind, prev);
    } else {
      detachActiveShellAgentGeometry(sessionId);
    }
    onReady?.();
    return;
  }

  const target = Math.min(
    maxCardRowsFor(sessionId, prev.cardKind),
    Math.max(
      MIN_CARD_ROWS,
      // 思考卡禁止扩行：多写的 \r\n 冻结后缩 decoration 也清不掉，空白会一张张累加
      prev.cardKind === "thinking"
        ? minCardRowsFor("thinking")
        : targetRows,
    ),
  );
  const pastPlaceholder = cursorPastPlaceholderEnd(term, prev);
  // ask 表单可越过光标扩高；结果卡不行——会盖住卡下刚落下的 PS>
  const allowGrowPastCursor = prev.cardKind === "ask";
  // 卡下已是空 prompt：再写 \r\n 会把 prompt 顶开，留下卡下空白带
  const promptBelow = promptSittingJustBelowCard(term, prev);
  const effectiveTarget =
    pastPlaceholder && target > prev.rows && !allowGrowPastCursor
      ? prev.rows
      : target;

  if (effectiveTarget === prev.rows) {
    onReady?.();
    return;
  }

  const diff = effectiveTarget - prev.rows;
  if (diff > 0 && promptBelow) {
    // 不扩占位，避免把已落下的 prompt 顶开 / 盖住。超出部分由结果卡内滚动。
    onReady?.();
    return;
  }

  const applyDecoration = (): void => {
    const cur = geometries.get(sessionId);
    if (!cur || cur.mode !== "inline" || cur.marker !== marker) {
      onReady?.();
      return;
    }
    const oldDecoration = cur.decoration;
    const decoration = registerCardDecoration(
      term,
      marker,
      effectiveTarget,
      cur.promptIndentCols,
    );
    if (!decoration) {
      onReady?.();
      return;
    }

    setGeometry(sessionId, {
      ...cur,
      decoration,
      rows: effectiveTarget,
      version: cur.version + 1,
    });

    if (oldDecoration && oldDecoration !== decoration) {
      whenDecorationPortalIdle(oldDecoration, () => {
        try {
          oldDecoration.dispose();
        } catch {
          // ignore
        }
      });
    }
    onReady?.();
  };

  if (diff > 0 && (!pastPlaceholder || allowGrowPastCursor)) {
    writeThen(term, "\r\n".repeat(diff), applyDecoration);
    return;
  }

  applyDecoration();
}

const fitTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 根据 portal 实测高度同步 decoration 占位行数 */
/** 将内容高度换算行数后扩缩占位。final 卡即使光标已越过也允许扩高，避免解读被裁切。 */
export function fitShellAgentCardToContent(
  sessionId: string,
  contentHeightPx: number,
  onStable?: () => void,
  opts?: { minRows?: number; padRows?: number },
): void {
  const prevKind = geometries.get(sessionId)?.cardKind ?? null;
  if (prevKind === "thinking") {
    onStable?.();
    return;
  }
  const fitted = contentHeightToCardRows(sessionId, contentHeightPx, prevKind, opts);
  const floor =
    opts?.minRows ??
    (prevKind === "cmd" ? minCardRowsFor("cmd") : MIN_CARD_ROWS);
  const rows = Math.max(floor, fitted);
  const prevTimer = fitTimers.get(sessionId);
  if (prevTimer) clearTimeout(prevTimer);
  fitTimers.set(
    sessionId,
    setTimeout(() => {
      fitTimers.delete(sessionId);
      const prev = geometries.get(sessionId);
      const term = getXterm(sessionId);
      // 光标已在卡下方：禁止再写 \r\n 加高，否则 decoration 会盖住已有回显 / 新 PS>
      if (
        prev &&
        term &&
        cursorPastPlaceholderEnd(term, prev) &&
        rows > prev.rows &&
        prev.cardKind !== "ask"
      ) {
        onStable?.();
        return;
      }
      resizeShellAgentCard(sessionId, rows, onStable);
    }, 32),
  );
}

/**
 * @deprecated 请用 setShellAgentCardKind + fitShellAgentCardToContent
 */
export function growShellAgentCard(
  sessionId: string,
  kind: ShellAgentCardKind,
  onReady?: () => void,
): void {
  setShellAgentCardKind(sessionId, kind);
  onReady?.();
}

/** 同高换肤：approve 时 cmd → 已同意态，不改几何 */
export function setShellAgentCardKind(sessionId: string, kind: ShellAgentCardKind): void {
  const prev = geometries.get(sessionId);
  if (!prev) return;
  if (prev.cardKind === kind) return;
  setGeometry(sessionId, { ...prev, cardKind: kind, version: prev.version + 1 });
}

/** 思考卡换成确认卡时先撑到确认卡最小占位，避免只露表头、盖住输出 */
export function ensureMinCardRows(sessionId: string, kind: ShellAgentCardKind): void {
  const prev = geometries.get(sessionId);
  if (!prev || prev.mode !== "inline") return;
  const min = minCardRowsFor(kind);
  if (prev.rows < min) {
    resizeShellAgentCard(sessionId, min);
  }
}

/**
 * 续轮重锚：在当前行钉新卡，再归档旧卡。
 * 关键：先 setGeometry(新卡) 再异步冻结旧卡，中间不出现 decoration=null。
 */
export function reanchorShellAgentCard(
  sessionId: string,
  kind: ShellAgentCardKind,
  onReady?: () => void,
  rowsOverride?: number,
): void {
  if (isGeometryWriteSuspended(sessionId)) {
    onReady?.();
    return;
  }
  const term = getXterm(sessionId);
  const prev = geometries.get(sessionId);
  if (!term) {
    if (prev?.mode === "inline") archiveActiveInlineCard(sessionId);
    else if (prev) detachActiveShellAgentGeometry(sessionId);
    onReady?.();
    return;
  }

  const indentCols = prev?.promptIndentCols ?? 2;
  const promptPrefix = prev?.promptPrefix ?? "$ ";
  const query = prev?.query ?? "";
  const version = prev?.version ?? 0;

  const oldDecoration = prev?.mode === "inline" ? prev.decoration : null;
  const oldMarker = prev?.mode === "inline" ? prev.marker : null;
  const oldKind = prev?.cardKind ?? null;
  const oldHost = oldDecoration?.element
    ? getPortalHost(oldDecoration.element)
    : null;
  const liveHtml = (oldHost?.innerHTML ?? oldDecoration?.element?.innerHTML ?? "").trim();
  const frozenHtml = resolveFrozenHtml(sessionId, oldKind, liveHtml);
  const outgoingRows = prev?.rows ?? 1;
  const freezeRows = frozenPlaceholderRows(oldKind, liveHtml, outgoingRows);
  // 先按冻结高度记账，再 ensureCursor。否则会按即将被缩掉的 live 行数补 \r\n，空白累加。
  if (prev?.mode === "inline" && freezeRows < outgoingRows) {
    setGeometry(sessionId, { ...prev, rows: freezeRows });
  }

  const rows = Math.min(
    maxCardRowsFor(sessionId, kind),
    Math.max(MIN_CARD_ROWS, rowsOverride ?? minCardRowsFor(kind)),
  );

  const finishAttach = (marker: IMarker, usedRows: number): void => {
    const decoration = registerCardDecoration(term, marker, usedRows, indentCols);
    if (!decoration) {
      try {
        marker.dispose();
      } catch {
        // ignore
      }
      failToDetached(sessionId, kind, prev);
      onReady?.();
      return;
    }

    setGeometry(sessionId, {
      ...freshGeometry({
        cardKind: kind,
        promptIndentCols: indentCols,
        promptPrefix,
        query,
        version: version + 1,
      }),
      mode: "inline",
      marker,
      decoration,
      rows: usedRows,
      anchorLine: marker.line,
    });
    markReanchorNeedsPtySync(sessionId);

    if (oldDecoration) {
      freezeOutgoingDecoration({
        sessionId,
        term,
        decoration: oldDecoration,
        marker: oldMarker,
        kind: oldKind,
        liveHtml,
        frozenHtml,
        prevRows: outgoingRows,
        indentCols,
        anchorLine: prev?.anchorLine ?? 0,
      });
    }
    onReady?.();
  };

  const placeCard = () => {
    const afterMarker = () => {
      let marker: IMarker | null = null;
      try {
        marker = term.registerMarker(0);
      } catch {
        marker = null;
      }
      if (!marker || marker.isDisposed || marker.line < 0) {
        failToDetached(sessionId, kind, prev);
        onReady?.();
        return;
      }

      writeThen(term, "\r\n".repeat(rows), () => {
        finishAttach(marker!, rows);
      });
    };

    // 思考完成贴结果卡会「粘」在一起；多空一行，只要一点点呼吸感
    const gapAfterThinking = oldKind === "thinking" && kind === "final";
    if (needsBlankLineBeforeMarker(term) || gapAfterThinking) {
      writeThen(term, "\r\n", afterMarker);
    } else {
      afterMarker();
    }
  };

  ensureCursorBelowCards(sessionId, placeCard);
}

/**
 * 把还在流式的思考卡挪到当前光标，不冻结、不清思考缓存。
 * 输出又涨高时用，避免 archive 把流式正文冻成「思考完成」再钉空卡。
 */
export function relocateInlineCardToCursor(
  sessionId: string,
  onReady?: () => void,
): void {
  if (isGeometryWriteSuspended(sessionId)) {
    onReady?.();
    return;
  }
  const term = getXterm(sessionId);
  const prev = geometries.get(sessionId);
  if (!term || !prev || prev.mode !== "inline" || !prev.cardKind) {
    onReady?.();
    return;
  }
  const kind = prev.cardKind;
  const oldDecoration = prev.decoration;
  const indentCols = prev.promptIndentCols;
  const promptPrefix = prev.promptPrefix;
  const query = prev.query;
  const version = prev.version;
  const rows = Math.max(MIN_CARD_ROWS, prev.rows || minCardRowsFor(kind));

  const afterMarker = () => {
    let marker: IMarker | null = null;
    try {
      marker = term.registerMarker(0);
    } catch {
      marker = null;
    }
    if (!marker || marker.isDisposed || marker.line < 0) {
      onReady?.();
      return;
    }
    writeThen(term, "\r\n".repeat(rows), () => {
      const decoration = registerCardDecoration(term, marker!, rows, indentCols);
      if (!decoration) {
        try {
          marker!.dispose();
        } catch {
          // ignore
        }
        onReady?.();
        return;
      }
      setGeometry(sessionId, {
        ...freshGeometry({
          cardKind: kind,
          promptIndentCols: indentCols,
          promptPrefix,
          query,
          version: version + 1,
        }),
        mode: "inline",
        marker,
        decoration,
        rows,
        anchorLine: marker!.line,
      });
      if (oldDecoration) {
        try {
          oldDecoration.dispose();
        } catch {
          // ignore
        }
      }
      onReady?.();
    });
  };

  ensureCursorBelowCards(sessionId, afterMarker);
}

/** 重锚后是否需要在 release 时向 PTY 发一次 \r\n 拉出新 prompt */
const reanchorPtySyncNeeded = new Set<string>();

function markReanchorNeedsPtySync(sessionId: string): void {
  reanchorPtySyncNeeded.add(sessionId);
}

/** 归档确认卡后需在 release 时拉一次新 prompt（拒绝等不走 reanchor 的路径） */
export function markShellAgentNeedsPromptSync(sessionId: string): void {
  markReanchorNeedsPtySync(sessionId);
}

export function consumeReanchorPtySync(sessionId: string): boolean {
  if (!reanchorPtySyncNeeded.has(sessionId)) return false;
  reanchorPtySyncNeeded.delete(sessionId);
  return true;
}

export function clearReanchorPtySync(sessionId: string): void {
  reanchorPtySyncNeeded.delete(sessionId);
}

/** dispose 卡片（占位行留存为空行）；续轮重锚前 / final 退场时调用 */
export function disposeShellAgentCard(sessionId: string): void {
  const prev = geometries.get(sessionId);
  if (!prev) return;
  disposeDecoration(prev);
  disposeMarker(prev);
  setGeometry(sessionId, {
    ...prev,
    mode: "idle",
    cardKind: null,
    marker: null,
    decoration: null,
    rows: 0,
    version: prev.version + 1,
  });
}

/** 彻底清理（取消 / 新会话 / 会话销毁）：含历史归档卡 */
export function clearShellAgentGeometry(sessionId: string): void {
  for (const archived of archivedBySession.get(sessionId) ?? []) {
    disposeDecoration({ decoration: archived.decoration } as ShellAgentGeometry);
    disposeMarker({ marker: archived.marker } as ShellAgentGeometry);
  }
  archivedBySession.delete(sessionId);
  clearReanchorPtySync(sessionId);

  const prev = geometries.get(sessionId);
  disposeDecoration(prev ?? null);
  disposeMarker(prev ?? null);
  geometries.delete(sessionId);
  emit(sessionId);
}

/** resize 后按新 cols 重注册 decoration 宽度（marker 不动）；先挂新再卸旧 */
export function relayoutShellAgentCard(sessionId: string): void {
  const prev = geometries.get(sessionId);
  if (!prev || prev.mode !== "inline" || !prev.cardKind) return;
  const term = getXterm(sessionId);
  const marker = prev.marker;
  if (!term || !marker || marker.isDisposed) {
    if (prev.cardKind === "cmd" || prev.cardKind === "ask") {
      failToDetached(sessionId, prev.cardKind, prev);
    } else {
      detachActiveShellAgentGeometry(sessionId);
    }
    return;
  }

  const oldDecoration = prev.decoration;
  const decoration = registerCardDecoration(term, marker, prev.rows, prev.promptIndentCols);
  if (!decoration) return;

  setGeometry(sessionId, { ...prev, decoration, version: prev.version + 1 });

  if (oldDecoration && oldDecoration !== decoration) {
    whenDecorationPortalIdle(oldDecoration, () => {
      try {
        oldDecoration.dispose();
      } catch {
        // ignore
      }
    });
  }
}

/** 在光标行画出 prompt 前缀（绿色），供注入命令的真实 echo 紧随其后 */
export function paintShellAgentPromptPrefix(sessionId: string): void {
  const term = getXterm(sessionId);
  const prefix = geometries.get(sessionId)?.promptPrefix ?? "";
  if (!term || !prefix) return;
  term.write(`\x1b[32m${prefix}\x1b[0m`);
}

/**
 * approve 执行前的回显序列（只顺序写，不绝对定位）。
 * 流内卡仍盖住占位行；光标在占位区正下方，画 prompt 前缀后由真正命令 echo 接上。
 * 不再写「✓ 已同意 · …」灰字行：确认卡已表达同意，重复输出无意义。
 */
export function prepareShellAgentEcho(sessionId: string, _command: string): void {
  const term = getXterm(sessionId);
  if (!term) return;

  // PowerShell：禁止再画本地 prompt 前缀，否则会出现 `PS> PS> Get-Date`
  if (sessionIsPowerShell(sessionId)) return;

  const geo = geometries.get(sessionId);
  const inlineCardActive = geo?.mode === "inline" && Boolean(geo.cardKind);
  if (!inlineCardActive) {
    let cursorLineHasContent = false;
    try {
      const buf = term.buffer.active;
      const line = buf.getLine(buf.cursorY + buf.baseY);
      cursorLineHasContent = Boolean(line?.translateToString(true).trim());
    } catch {
      // ignore
    }
    if (cursorLineHasContent) {
      term.write("\r\n");
    }
  }
  paintShellAgentPromptPrefix(sessionId);
}
