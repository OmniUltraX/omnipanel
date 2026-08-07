/**
 * Shell Agent 流内几何管理器（方案 C 核心纪律）：
 *
 * 1. 伪造内容只有两类且全部可见：蓝字问题行（入口负责）+ 占位空行（必须被 decoration 盖住）。
 * 2. 占位行归卡片所有：registerMarker 在占位区首行，decoration height=N 盖住 N 行占位，
 *    光标天然落在占位区下方，approve 后命令回显/输出/新 prompt 依次下流。
 * 3. approve 不改几何：dispose 卡片即可，占位行留在 scrollback 作为交互痕迹。
 * 4. decoration 不可用 → 无活跃卡（detached），仅流内 xterm decoration，**无底部浮层**。
 */
import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { getXterm } from "../xtermRegistry";

export type ShellAgentCardKind = "thinking" | "cmd" | "final";
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

/** 建卡时的最小占位行数（实际高度由 fitShellAgentCardToContent 测量） */
export function minCardRowsFor(_kind?: ShellAgentCardKind): number {
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

/** 将 portal 内容像素高度换算为 decoration 占位行数 */
export function contentHeightToCardRows(
  sessionId: string,
  contentHeightPx: number,
): number {
  const rowH = terminalRowHeightPx(sessionId);
  const rows = Math.ceil(contentHeightPx / rowH);
  return Math.min(MAX_CARD_ROWS, Math.max(MIN_CARD_ROWS, rows));
}

const geometries = new Map<string, ShellAgentGeometry>();
const listeners = new Set<(sessionId: string) => void>();

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

function injectFrozenCardSnapshot(deco: IDecoration, frozenHtml: string): void {
  try {
    const el = deco.element;
    if (!el) return;
    const snapshot = document.createElement("div");
    snapshot.className =
      "term-shell-agent-deco-card term-shell-agent-deco-card--frozen";
    snapshot.innerHTML = frozenHtml;
    snapshot.style.pointerEvents = "none";
    el.replaceChildren(snapshot);
  } catch {
    // ignore
  }
}

/**
 * 将当前流内卡冻结进 scrollback（React portal 卸载后 microtask 回填快照，避免空白）。
 * 仅 detach 活跃几何，不 dispose decoration/marker。
 */
export function archiveActiveInlineCard(sessionId: string): void {
  const prev = geometries.get(sessionId);
  if (!prev || prev.mode !== "inline" || !prev.decoration || !prev.marker) return;

  const deco = prev.decoration;
  const marker = prev.marker;
  const frozenHtml = deco.element?.innerHTML?.trim() ?? "";

  pushArchived(sessionId, { decoration: deco, marker });

  // 先 detach 活跃几何 → React 卸载 portal，再回填冻结快照
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
    afterReactPortalUnmount(() => injectFrozenCardSnapshot(deco, frozenHtml));
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
  // TEMP-DEBUG: 几何变化写 DOM dataset（隔离世界可读）
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
  emit(sessionId);
}

function disposeDecoration(geo: ShellAgentGeometry | null): void {
  const deco = geo?.decoration;
  if (!deco) return;
  try {
    deco.dispose();
  } catch {
    // ignore
  }
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

  // 占位行：本地写 \r\n 推进光标，decoration 盖在这些空行上
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

/**
 * 按目标行数调整占位区（可扩可缩 decoration 高度）。
 * 命令已回显、光标离开占位区后禁止再 write \\r\\n，避免把 prompt 顶乱。
 */
export function resizeShellAgentCard(
  sessionId: string,
  targetRows: number,
  onReady?: () => void,
): void {
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

  const target = Math.min(MAX_CARD_ROWS, Math.max(MIN_CARD_ROWS, targetRows));
  const pastPlaceholder = cursorPastPlaceholderEnd(term, prev);
  const effectiveTarget =
    pastPlaceholder && target > prev.rows ? prev.rows : target;

  if (effectiveTarget === prev.rows) {
    onReady?.();
    return;
  }

  const diff = effectiveTarget - prev.rows;
  if (diff > 0 && !pastPlaceholder) {
    term.write("\r\n".repeat(diff));
  }

  const oldDecoration = prev.decoration;
  setGeometry(sessionId, {
    ...prev,
    decoration: null,
    version: prev.version + 1,
  });

  afterReactPortalUnmount(() => {
    if (oldDecoration) {
      try {
        oldDecoration.dispose();
      } catch {
        // ignore
      }
    }
    const decoration = registerCardDecoration(
      term,
      marker,
      effectiveTarget,
      prev.promptIndentCols,
    );
    if (!decoration) {
      detachActiveShellAgentGeometry(sessionId);
      onReady?.();
      return;
    }
    setGeometry(sessionId, {
      ...prev,
      decoration,
      rows: effectiveTarget,
      version: prev.version + 2,
    });
    onReady?.();
  });
}

const fitTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 根据 portal 实测高度同步 decoration 占位行数 */
export function fitShellAgentCardToContent(
  sessionId: string,
  contentHeightPx: number,
  onStable?: () => void,
): void {
  const rows = contentHeightToCardRows(sessionId, contentHeightPx);
  const prevTimer = fitTimers.get(sessionId);
  if (prevTimer) clearTimeout(prevTimer);
  fitTimers.set(
    sessionId,
    setTimeout(() => {
      fitTimers.delete(sessionId);
      const prev = geometries.get(sessionId);
      const term = getXterm(sessionId);
      // 光标已在卡下方（通常已是 shell prompt）：禁止再本地写 \r\n / 重锚，否则双 prompt + 两次回车
      if (prev && term && cursorPastPlaceholderEnd(term, prev) && rows > prev.rows) {
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
 * 续轮重锚：归档旧卡 → 在当前行钉 marker + 占位 + decoration。
 *
 * 重要：不要先写一行 \r\n 再钉 marker。若当前已是 `root@host:~#`，先换行会把
 * 旧 prompt 留在卡片上方，收尾再 PTY 回车就会出现两个 prompt，并导致两次回车。
 * 正确做法是 marker 钉在当前行（旧 prompt 被卡片盖住），占位向下展开。
 */
export function reanchorShellAgentCard(
  sessionId: string,
  kind: ShellAgentCardKind,
  onReady?: () => void,
  rowsOverride?: number,
): void {
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

  archiveActiveInlineCard(sessionId);

  const rows = Math.min(
    MAX_CARD_ROWS,
    Math.max(MIN_CARD_ROWS, rowsOverride ?? minCardRowsFor(kind)),
  );

  let marker: IMarker | null = null;
  try {
    marker = term.registerMarker(0);
  } catch {
    marker = null;
  }
  if (!marker || marker.isDisposed) {
    detachActiveShellAgentGeometry(sessionId);
    onReady?.();
    return;
  }

  term.write("\r\n".repeat(rows), () => {
    const decoration = registerCardDecoration(term, marker!, rows, indentCols);
    if (!decoration) {
      disposeMarker({ ...freshGeometry(), marker });
      detachActiveShellAgentGeometry(sessionId);
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
      marker,
      decoration,
      rows,
      anchorLine: marker!.line,
    });
    // 本地占位后画面停在空行，PTY 仍在被盖住的旧 prompt：收尾需同步一次
    markReanchorNeedsPtySync(sessionId);
    onReady?.();
  });
}

/** 重锚后是否需要在 release 时向 PTY 发一次 \r\n 拉出新 prompt */
const reanchorPtySyncNeeded = new Set<string>();

function markReanchorNeedsPtySync(sessionId: string): void {
  reanchorPtySyncNeeded.add(sessionId);
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

/** resize 后按新 cols 重注册 decoration 宽度（marker 不动） */
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
  setGeometry(sessionId, {
    ...prev,
    decoration: null,
    version: prev.version + 1,
  });

  afterReactPortalUnmount(() => {
    if (oldDecoration) {
      try {
        oldDecoration.dispose();
      } catch {
        // ignore
      }
    }
    const decoration = registerCardDecoration(term, marker, prev.rows, prev.promptIndentCols);
    if (!decoration) {
      detachActiveShellAgentGeometry(sessionId);
      return;
    }
    setGeometry(sessionId, { ...prev, decoration, version: prev.version + 2 });
  });
}

/** 在光标行画出 prompt 前缀（绿色），供注入命令的真实 echo 紧随其后 */
export function paintShellAgentPromptPrefix(sessionId: string): void {
  const term = getXterm(sessionId);
  const prefix = geometries.get(sessionId)?.promptPrefix ?? "";
  if (!term || !prefix) return;
  term.write(`\x1b[32m${prefix}\x1b[0m`);
}

/** approve 后在光标行写灰字「已同意」行（1 行伪造，随流留存） */
export function writeShellAgentAgreedLine(sessionId: string, command: string): void {
  const term = getXterm(sessionId);
  if (!term) return;
  const oneLine = command.replace(/\s+/g, " ").trim();
  term.write(`\x1b[90m✓ 已同意 · ${oneLine}\x1b[0m\r\n`);
}

/**
 * approve 执行前的回显序列（只顺序写，不绝对定位）。
 * 流内卡仍盖住占位行；光标在占位区正下方，直接写灰字行 + prompt 前缀。
 */
export function prepareShellAgentEcho(sessionId: string, command: string): void {
  const term = getXterm(sessionId);
  if (!term) return;

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
  writeShellAgentAgreedLine(sessionId, command);
  paintShellAgentPromptPrefix(sessionId);
}
