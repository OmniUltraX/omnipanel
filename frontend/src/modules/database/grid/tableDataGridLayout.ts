import type { CSSProperties } from "react";
import { ROW_RESIZE_ZONE_PX } from "./tableDataGridConstants";

/** 行高拖拽热区宽度（对齐行号列默认宽度） */
export const ROW_RESIZE_HANDLE_WIDTH_PX = 36;

export function isNearRowBottom(target: HTMLElement, clientY: number): boolean {
  const rect = target.getBoundingClientRect();
  return clientY >= rect.bottom - ROW_RESIZE_ZONE_PX;
}

/** 仅最左侧（行号 / 转置字段列区域）可开始拖行高 */
export function isInRowResizeHandle(target: HTMLElement, clientX: number, clientY: number): boolean {
  const rect = target.getBoundingClientRect();
  return (
    clientY >= rect.bottom - ROW_RESIZE_ZONE_PX &&
    clientX >= rect.left &&
    clientX <= rect.left + ROW_RESIZE_HANDLE_WIDTH_PX
  );
}

export function buildColumnCellStyle(
  columnId: string,
  baseSize: number,
  lastColumnId: string,
  fillDelta: number,
): CSSProperties {
  const stretchLast = fillDelta > 0 && columnId === lastColumnId;
  const width = stretchLast ? baseSize + fillDelta : baseSize;
  return stretchLast
    ? { width, minWidth: baseSize }
    : { width, minWidth: baseSize, maxWidth: baseSize };
}

export function applyColumnWidthDom(wrap: HTMLElement, columnId: string, width: number) {
  const px = `${width}px`;
  wrap.querySelectorAll<HTMLElement>(`[data-col-id="${CSS.escape(columnId)}"]`).forEach((el) => {
    el.style.width = px;
  });
  wrap
    .querySelector<HTMLElement>(`col[data-col-id="${CSS.escape(columnId)}"]`)
    ?.style.setProperty("width", px);
}

export function scrollElementToCenter(container: HTMLElement, element: HTMLElement) {
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const deltaX =
    elementRect.left + elementRect.width / 2 - (containerRect.left + containerRect.width / 2);
  const deltaY =
    elementRect.top + elementRect.height / 2 - (containerRect.top + containerRect.height / 2);
  container.scrollBy({ left: deltaX, top: deltaY, behavior: "smooth" });
}

/** 清除 WebView 在 DOM 更新后粘住的 :hover 伪类 */
export function resetStuckPointerHover(container: HTMLElement | null) {
  if (!container) return;
  container.style.pointerEvents = "none";
  void container.offsetHeight;
  container.style.pointerEvents = "";
}
