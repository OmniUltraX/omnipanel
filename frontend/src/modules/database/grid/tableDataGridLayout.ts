import type { CSSProperties } from "react";
import { ROW_RESIZE_ZONE_PX } from "./tableDataGridConstants";

/** 行高拖拽热区宽度（对齐行号列默认宽度） */
export const ROW_RESIZE_HANDLE_WIDTH_PX = 36;

export function isNearRowBottom(target: HTMLElement, clientY: number): boolean {
  const rect = target.getBoundingClientRect();
  return clientY >= rect.bottom - ROW_RESIZE_ZONE_PX;
}

/** 仅最左侧（行号 / 转置字段列区域）可开始拖行高；优先用 sticky 首列，避免横向滚动后热区错位 */
export function isInRowResizeHandle(target: HTMLElement, clientX: number, clientY: number): boolean {
  const stickyCell =
    target.querySelector<HTMLElement>("td.db-data-table-cell--rownum") ??
    target.querySelector<HTMLElement>("td.db-data-table-cell--field") ??
    null;
  const rect = (stickyCell ?? target).getBoundingClientRect();
  if (stickyCell) {
    return (
      clientY >= rect.bottom - ROW_RESIZE_ZONE_PX &&
      clientX >= rect.left &&
      clientX <= rect.right
    );
  }
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
  // maxWidth 必须与 width 一致，否则列宽拖拽时仅改 width 会被旧 maxWidth 卡住，
  // Canvas 已按新宽度绘制而表头不跟，造成严重错位。
  return stretchLast
    ? { width, minWidth: baseSize, maxWidth: width }
    : { width, minWidth: width, maxWidth: width };
}

export function applyColumnWidthDom(wrap: HTMLElement, columnId: string, width: number) {
  const px = `${width}px`;
  wrap.querySelectorAll<HTMLElement>(`[data-col-id="${CSS.escape(columnId)}"]`).forEach((el) => {
    el.style.width = px;
    el.style.minWidth = px;
    el.style.maxWidth = px;
  });
  wrap
    .querySelector<HTMLElement>(`col[data-col-id="${CSS.escape(columnId)}"]`)
    ?.style.setProperty("width", px);
}

/**
 * 读取表头布局几何（offsetLeft/offsetWidth，不受 sticky/滚动视觉影响）。
 * 任一列缺失（列虚拟化未挂载）时返回 null，由调用方回退逻辑宽度。
 */
export type MeasuredHeaderColumn = { x: number; width: number };

export function measureHeaderColumnGeometry(
  wrap: HTMLElement,
  columnIds: readonly string[],
): { columns: MeasuredHeaderColumn[]; totalWidth: number } | null {
  if (columnIds.length === 0) return null;
  // 一次性查全部 th，避免 N 次 querySelector（每次都有 DOM 遍历开销）
  const ths = wrap.querySelectorAll<HTMLTableCellElement>("th[data-col-id]");
  const map = new Map<string, HTMLTableCellElement>();
  for (const th of ths) {
    const id = th.dataset.colId;
    if (id) map.set(id, th);
  }
  const columns: MeasuredHeaderColumn[] = [];
  for (const columnId of columnIds) {
    const th = map.get(columnId);
    if (!th) return null;
    const width = th.offsetWidth;
    if (!(width > 0)) return null;
    columns.push({ x: th.offsetLeft, width });
  }
  const table = wrap.querySelector<HTMLElement>("table.db-data-table");
  const last = columns[columns.length - 1]!;
  const totalWidth = Math.max(
    table?.offsetWidth ?? 0,
    last.x + last.width,
  );
  return { columns, totalWidth };
}

/** @deprecated 使用 measureHeaderColumnGeometry */
export function measureHeaderColumnWidths(
  wrap: HTMLElement,
  columnIds: readonly string[],
): number[] | null {
  const geometry = measureHeaderColumnGeometry(wrap, columnIds);
  return geometry ? geometry.columns.map((col) => col.width) : null;
}

/** Canvas / DOM 共用的视口锚点矩形 */
export type GridCellViewportRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function scrollElementToCenter(container: HTMLElement, element: HTMLElement) {
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const deltaX =
    elementRect.left + elementRect.width / 2 - (containerRect.left + containerRect.width / 2);
  const deltaY =
    elementRect.top + elementRect.height / 2 - (containerRect.top + containerRect.height / 2);
  container.scrollBy({ left: deltaX, top: deltaY, behavior: "smooth" });
}

/**
 * 按列几何把目标列滚到视口中央。
 * 不依赖 DOM 表头节点，兼容列虚拟化（远列没有 th）与 Canvas body。
 */
export function scrollColumnToCenter(
  container: HTMLElement,
  options: {
    columnOffset: number;
    columnWidth: number;
    totalWidth: number;
    pinned?: boolean;
    behavior?: ScrollBehavior;
  },
) {
  if (options.pinned) return;
  const viewportWidth = container.clientWidth;
  if (viewportWidth <= 0) return;
  const targetLeft = options.columnOffset + options.columnWidth / 2 - viewportWidth / 2;
  const maxLeft = Math.max(0, options.totalWidth - viewportWidth);
  const nextLeft = Math.max(0, Math.min(targetLeft, maxLeft));
  container.scrollTo({ left: nextLeft, behavior: options.behavior ?? "smooth" });
}

/** 清除 WebView 在 DOM 更新后粘住的 :hover 伪类 */
export function resetStuckPointerHover(container: HTMLElement | null) {
  if (!container) return;
  container.style.pointerEvents = "none";
  void container.offsetHeight;
  container.style.pointerEvents = "";
}
