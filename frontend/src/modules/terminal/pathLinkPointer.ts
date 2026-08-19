import type { IBufferLine, Terminal } from "@xterm/xterm";
import {
  classifyLinePathLinks,
  isTypicalDirectoryColor,
  isXtermMouseTrackingOn,
  type ClassifiedPathLink,
} from "./terminalFileLinks";
import { getCwdPathListing } from "./cwdPathListing";

/** 预览窗 / 对话框盖在终端上时，点击不应穿透成路径动作 */
export const PATH_LINK_POINTER_IGNORE_SELECTOR = [
  ".subwindow-overlay",
  ".subwindow-panel",
  ".subwindow-minimized-stack",
  "[role='dialog']",
].join(",");

interface XtermCoreMouse {
  screenElement?: HTMLElement;
  _mouseService?: {
    getCoords(
      event: { clientX: number; clientY: number },
      element: HTMLElement,
      colCount: number,
      rowCount: number,
    ): [number, number] | undefined;
  };
  _renderService?: {
    dimensions?: { css?: { cell?: { width: number; height: number } } };
  };
}

export function getXtermScreen(term: Terminal): HTMLElement | null {
  const core = (term as unknown as { _core?: XtermCoreMouse })._core;
  return (
    core?.screenElement ??
    (term.element?.querySelector(".xterm-screen") as HTMLElement | null) ??
    term.element ??
    null
  );
}

/**
 * 指针 → buffer 行（1-based，与 ILinkProvider 行号一致）+ 列（1-based）。
 * 在 screen 外返回 null，不按 xterm getCoords 那样夹到边缘格子。
 */
export function bufferCellFromPointer(
  term: Terminal,
  clientX: number,
  clientY: number,
): { line: number; col: number } | null {
  const screen = getXtermScreen(term);
  if (!screen) return null;
  const rect = screen.getBoundingClientRect();
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  ) {
    return null;
  }

  const core = (term as unknown as { _core?: XtermCoreMouse })._core;
  const coords = core?._mouseService?.getCoords(
    { clientX, clientY },
    screen,
    term.cols,
    term.rows,
  );
  if (coords) {
    return { col: coords[0], line: term.buffer.active.viewportY + coords[1] };
  }

  const cellW =
    core?._renderService?.dimensions?.css?.cell?.width ||
    rect.width / Math.max(term.cols, 1);
  const cellH =
    core?._renderService?.dimensions?.css?.cell?.height ||
    rect.height / Math.max(term.rows, 1);
  if (cellW <= 0 || cellH <= 0) return null;
  const col = Math.min(term.cols, Math.max(1, Math.ceil((clientX - rect.left) / cellW)));
  const row = Math.min(term.rows, Math.max(1, Math.ceil((clientY - rect.top) / cellH)));
  return { col, line: term.buffer.active.viewportY + row };
}

export function shouldHandlePathLinkPointer(
  term: Terminal,
  event: { button: number; target: EventTarget | null },
): boolean {
  if (event.button !== 0) return false;
  if (isXtermMouseTrackingOn(term)) return false;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (target.closest(PATH_LINK_POINTER_IGNORE_SELECTOR)) return false;
  return Boolean(term.element?.contains(target));
}

function lineSpanIsDirectoryColor(line: IBufferLine, start: number, end: number): boolean {
  let total = 0;
  let dirish = 0;
  const last = Math.min(end, line.length);
  for (let x = start; x < last; x += 1) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    total += 1;
    if (isTypicalDirectoryColor(cell.getFgColor(), cell.isFgPalette())) dirish += 1;
  }
  return total > 0 && dirish === total;
}

export function classifiedPathLinkAtPointer(params: {
  term: Terminal;
  clientX: number;
  clientY: number;
  cwd: string;
  sessionType: "local" | "remote";
  remoteHome: string | null;
  resourceId: string | null;
}): ClassifiedPathLink | null {
  const pos = bufferCellFromPointer(params.term, params.clientX, params.clientY);
  if (!pos) return null;
  const line = params.term.buffer.active.getLine(pos.line - 1);
  if (!line) return null;
  const text = line.translateToString(true);
  const listing = getCwdPathListing(params.sessionType, params.resourceId, params.cwd);
  const classified = classifyLinePathLinks({
    line: text,
    cwd: params.cwd || "/",
    sessionType: params.sessionType,
    remoteHome: params.remoteHome,
    listing,
    isDirectoryColor: (start, end) => lineSpanIsDirectoryColor(line, start, end),
  });
  return (
    classified.find((item) => item.start + 1 <= pos.col && pos.col <= item.end) ?? null
  );
}
