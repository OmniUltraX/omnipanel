import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { findTerminalPane } from "@/stores/terminalStore";
import { lineLooksLikeShellPrompt } from "../passthroughAi/screenLine";
import { getXterm } from "../xtermRegistry";
import {
  buildAgreedCmdFrozenHtml,
  buildRejectedCmdFrozenHtml,
  buildThinkingDoneFrozenHtml,
  consumeShellAgentConfirmFreeze,
  getShellAgentLastCmd,
  getShellAgentThinkingFull,
  transformPendingConfirmToAgreedHtml,
  transformPendingConfirmToRejectedHtml,
} from "./thinkingCache";

/** 明确的 PowerShell 会话（仅用于禁止本地假 prompt；占位绝不走 PTY Enter） */
function sessionIsPowerShell(sessionId: string): boolean {
  const pane = findTerminalPane(sessionId);
  if (!pane) return false;
  const kind = pane.shellSpec?.kind;
  if (kind === "powershell" || kind === "powershell5") return true;
  return /powershell|pwsh/i.test(pane.shellLabel ?? "");
}

export type ShellAgentCardKind = "thinking" | "cmd" | "ask" | "final";
export type ShellAgentGeometryMode = "inline" | "detached";

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
/** 最终解读可写入更多 scrollback 行，避免长报告被裁切 */
const MAX_FINAL_CARD_ROWS = 96;

/** 建卡时的最小占位行数（实际高度由 fitShellAgentCardToContent 测量） */
export function minCardRowsFor(kind?: ShellAgentCardKind): number {
  // 思考卡固定矮卡约 2 行内容，占位至少 3 行以免被 decoration 裁切看不见
  if (kind === "thinking") return 3;
  // 询问表单通常多行，预留更高占位
  if (kind === "ask") return 6;
  // 结果卡按内容 fit；从 1 行起跳，避免起步过高留下空白带
  if (kind === "final") return 1;
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
  // final：允许超过一屏，写入 scrollback，避免长解读被 24 行天花板裁死
  if (kind === "final") {
    return Math.min(
      MAX_FINAL_CARD_ROWS,
      Math.max(viewportCap, term?.rows ? term.rows * 2 : MAX_FINAL_CARD_ROWS),
    );
  }
  return Math.min(MAX_CARD_ROWS, viewportCap);
}

/** 将 portal 内容像素高度换算为 decoration 占位行数 */
export function contentHeightToCardRows(
  sessionId: string,
  contentHeightPx: number,
  kind?: ShellAgentCardKind | null,
): number {
  const rowH = terminalRowHeightPx(sessionId);
  const raw = contentHeightPx / rowH;
  // final：略减再 ceil，抵消测高偏大/亚像素，少占空行（多占的行缩 decoration 也清不掉 buffer）
  // 不可减太多：overflow:visible 时内容会盖住下方命令/prompt → 卡片「重叠」
  const rows =
    kind === "final"
      ? Math.ceil(Math.max(0, raw - 0.1))
      : Math.ceil(raw);
  // ask / final：多留 1 行防底边裁切与盖住下一行 prompt
  const pad = kind === "ask" || kind === "final" ? 1 : 0;
  const hardMax = maxCardRowsFor(sessionId, kind);
  return Math.min(hardMax, Math.max(MIN_CARD_ROWS, rows + pad));
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
};

/** 已冻结、留在 scrollback 的历史卡片（decoration/marker 不 dispose） */
const archivedBySession = new Map<string, ArchivedShellAgentCard[]>();

function pushArchived(sessionId: string, entry: ArchivedShellAgentCard): void {
  const list = archivedBySession.get(sessionId) ?? [];
  list.push(entry);
  archivedBySession.set(sessionId, list);
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
    return buildThinkingDoneFrozenHtml({
      sessionId,
      fullText: getShellAgentThinkingFull(sessionId),
    });
  }
  if (cardKind === "ask") {
    return annotateFrozenAskHtml(sessionId, liveHtml);
  }
  if (cardKind === "cmd") {
    const last = getShellAgentLastCmd(sessionId);
    const freezeKind = consumeShellAgentConfirmFreeze(sessionId);
    // 仅在明确同意/拒绝意图下冻成终态；禁止把待确认/工具条误冻成「已同意」
    if (freezeKind === "agreed") {
      const transformed = transformPendingConfirmToAgreedHtml(liveHtml, {
        sessionId,
        command: last?.command,
        toolId: last?.toolId,
      });
      if (transformed) return transformed;
      if (last?.command) {
        return buildAgreedCmdFrozenHtml({
          sessionId,
          command: last.command,
          toolId: last.toolId,
          description: last.description,
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

  pushArchived(sessionId, { decoration: deco, marker });

  setGeometry(sessionId, {
    ...prev,
    mode: "detached",
    cardKind: null,
    marker: null,
    decoration: null,
    rows: 0,
    version: prev.version + 1,
  });

  if (frozenHtml) {
    injectFrozenCardSnapshot(deco, frozenHtml, sessionId);
  }
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

function registerCardDecoration(
  term: Terminal,
  marker: IMarker,
  rows: number,
  _indentCols: number,
): IDecoration | null {
  try {
    return (
      term.registerDecoration({
        marker,
        x: 0,
        width: term.cols,
        height: rows,
        layer: "top",
      }) ?? null
    );
  } catch {
    return null;
  }
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
    mode: "detached",
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

  let marker: IMarker | null = null;
  try {
    marker = term.registerMarker(0);
  } catch {
    marker = null;
  }
  if (!marker) {
    const detached = { ...base, mode: "detached" as const };
    setGeometry(sessionId, detached);
    return detached;
  }

  // 占位只本地 \r\n。PowerShell 向 PTY 发 Enter 会变成 `>>` 续行，已验证不可用。
  term.write("\r\n".repeat(rows));
  const decoration = registerCardDecoration(term, marker, rows, base.promptIndentCols);
  if (!decoration) {
    disposeMarker({ ...base, marker });
    const detached = { ...base, mode: "detached" as const };
    setGeometry(sessionId, detached);
    return detached;
  }

  const geo: ShellAgentGeometry = {
    ...base,
    marker,
    decoration,
    rows,
    anchorLine: marker.line,
  };
  setGeometry(sessionId, geo);
  return geo;
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
      const line = buf.getLine(y)?.translateToString(true) ?? "";
      if (lineLooksLikeShellPrompt(line)) return true;
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
    detachActiveShellAgentGeometry(sessionId);
    onReady?.();
    return;
  }

  const target = Math.min(
    maxCardRowsFor(sessionId, prev.cardKind),
    Math.max(MIN_CARD_ROWS, targetRows),
  );
  const pastPlaceholder = cursorPastPlaceholderEnd(term, prev);
  // ask / final：允许越过光标限制继续扩高（表单/解读不能卡死在矮占位）
  const allowGrowPastCursor =
    prev.cardKind === "ask" || prev.cardKind === "final";
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
    // 不扩占位，避免顶开下方 prompt；内容略高时由 portal overflow 可见
    onReady?.();
    return;
  }
  if (diff > 0 && (!pastPlaceholder || allowGrowPastCursor)) {
    term.write("\r\n".repeat(diff));
  }

  const oldDecoration = prev.decoration;
  const decoration = registerCardDecoration(
    term,
    marker,
    effectiveTarget,
    prev.promptIndentCols,
  );
  if (!decoration) {
    onReady?.();
    return;
  }

  setGeometry(sessionId, {
    ...prev,
    decoration,
    rows: effectiveTarget,
    version: prev.version + 1,
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
}

const fitTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 根据 portal 实测高度同步 decoration 占位行数 */
/** 将内容高度换算行数后扩缩占位。final 卡即使光标已越过也允许扩高，避免解读被裁切。 */
export function fitShellAgentCardToContent(
  sessionId: string,
  contentHeightPx: number,
  onStable?: () => void,
): void {
  const prevKind = geometries.get(sessionId)?.cardKind ?? null;
  const rows = contentHeightToCardRows(sessionId, contentHeightPx, prevKind);
  const prevTimer = fitTimers.get(sessionId);
  if (prevTimer) clearTimeout(prevTimer);
  fitTimers.set(
    sessionId,
    setTimeout(() => {
      fitTimers.delete(sessionId);
      const prev = geometries.get(sessionId);
      const term = getXterm(sessionId);
      // 光标已在卡下方：非 final/ask 禁止再写 \r\n（双 prompt）；ask/final 必须能撑开
      if (
        prev &&
        term &&
        cursorPastPlaceholderEnd(term, prev) &&
        rows > prev.rows &&
        prev.cardKind !== "final" &&
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

  const rows = Math.min(
    maxCardRowsFor(sessionId, kind),
    Math.max(MIN_CARD_ROWS, rowsOverride ?? minCardRowsFor(kind)),
  );

  const placeCard = () => {
    let marker: IMarker | null = null;
    try {
      marker = term.registerMarker(0);
    } catch {
      marker = null;
    }
    if (!marker || marker.isDisposed) {
      onReady?.();
      return;
    }

    term.write("\r\n".repeat(rows), () => {
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
      markReanchorNeedsPtySync(sessionId);

      if (oldDecoration) {
        if (oldMarker) {
          pushArchived(sessionId, { decoration: oldDecoration, marker: oldMarker });
        }
        if (frozenHtml) {
          injectFrozenCardSnapshot(oldDecoration, frozenHtml, sessionId);
        }
      }
      onReady?.();
    });
  };

  // final：空 prompt 上先本地换行再钉卡，避免盖住可输入行
  if (kind === "final" && cursorLineLooksLikeEmptyPrompt(term)) {
    term.write("\r\n", () => placeCard());
    return;
  }
  placeCard();
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
    mode: "detached",
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
    detachActiveShellAgentGeometry(sessionId);
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
