/**
 * 表数据网格视口测量：末列拉伸可用宽度需扣除纵向滚动条占位，
 * 否则会在 Y 滚动条出现后挤出轻微横向滚动。
 */

let cachedScrollbarSize: number | null = null;

/** 末列拉伸时额外少吃的像素，吸收边框/亚像素/滚动条测量误差（实测约 10px） */
export const GRID_FILL_EDGE_SLACK_PX = 10;

/** 测量系统经典纵向滚动条宽度；overlay 滚动条返回 0 */
export function measureScrollbarSize(): number {
  if (cachedScrollbarSize != null) return cachedScrollbarSize;
  if (typeof document === "undefined") {
    cachedScrollbarSize = 15;
    return cachedScrollbarSize;
  }
  const outer = document.createElement("div");
  outer.style.cssText =
    "position:absolute;top:-9999px;left:-9999px;visibility:hidden;overflow:scroll;width:100px;height:100px";
  document.body.appendChild(outer);
  const inner = document.createElement("div");
  inner.style.width = "100%";
  outer.appendChild(inner);
  const size = Math.max(0, outer.offsetWidth - inner.offsetWidth);
  document.body.removeChild(outer);
  cachedScrollbarSize = size;
  return size;
}

/** 仅测试用：重置滚动条宽度缓存 */
export function resetScrollbarSizeCacheForTests() {
  cachedScrollbarSize = null;
}

export type MeasureGridFillViewportOptions = {
  /** 预估内容总高度（含表头）；用于滚动条尚未占位时的预留 */
  contentHeightHint?: number;
};

/**
 * 末列「吃掉剩余宽度」时使用的视口宽。
 * - scrollbar-gutter:stable / 经典滚动条已占位：clientWidth 已扣除 gutter
 * - 内容将纵向溢出但 gutter 尚未占位：预留 scrollbar 宽度
 * - 再减 1px slack，避免边框/亚像素刚好顶满后横向微滚
 */
export function measureGridFillViewportWidth(
  el: HTMLElement,
  options?: MeasureGridFillViewportOptions,
): number {
  const clientW = el.clientWidth;
  if (clientW <= 0) return 0;

  const sb = measureScrollbarSize();
  const occupied = Math.max(0, el.offsetWidth - el.clientWidth);
  // gutter 已由 scrollbar-gutter 或经典滚动条占用
  const gutterAlreadyReserved = occupied >= Math.max(sb, 8) * 0.4;

  const contentH = options?.contentHeightHint ?? el.scrollHeight;
  const needsVScroll = contentH > el.clientHeight + 1;

  let width = clientW;
  if (needsVScroll && !gutterAlreadyReserved && sb > 0) {
    width = clientW - sb;
  }

  return Math.max(0, Math.floor(width) - GRID_FILL_EDGE_SLACK_PX);
}

/** 根据行数粗估表体+表头高度，供 fill 视口预留滚动条 */
export function estimateGridContentHeight(options: {
  rowCount: number;
  rowHeight?: number;
  headerHeight?: number;
}): number {
  const rowHeight = options.rowHeight ?? 32;
  const headerHeight = options.headerHeight ?? 28;
  return headerHeight + Math.max(0, options.rowCount) * rowHeight;
}
