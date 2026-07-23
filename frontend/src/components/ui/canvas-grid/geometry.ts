import type {
  CellViewportRect,
  GridColumnDrawInfo,
  GridHitRegion,
  GridHitResult,
  GridRenderSnapshot,
} from "./types";

/** 行高拖拽热区高度（px） */
export const ROW_RESIZE_ZONE_PX = 2;

export const VALUE_BTN_SIZE = 16;
export const VALUE_BTN_RIGHT = 3;
export const FIELD_ACTION_BTN_SIZE = 16;

export function buildColumnOffsets(
  widths: number[],
): { columns: Array<{ x: number; width: number }>; totalWidth: number } {
  const columns: Array<{ x: number; width: number }> = [];
  let x = 0;
  for (const width of widths) {
    columns.push({ x, width });
    x += width;
  }
  return { columns, totalWidth: x };
}

export function buildRowOffsets(
  rowCount: number,
  getRowHeight: (rowIndex: number) => number,
): { offsets: number[]; totalHeight: number } {
  const offsets = new Array<number>(rowCount + 1);
  offsets[0] = 0;
  for (let i = 0; i < rowCount; i += 1) {
    offsets[i + 1] = offsets[i]! + getRowHeight(i);
  }
  return { offsets, totalHeight: offsets[rowCount] ?? 0 };
}

/** 在内容坐标系中定位行（含任意行高） */
export function findRowAtOffset(offsets: number[], y: number): number {
  if (offsets.length <= 1) return -1;
  let lo = 0;
  let hi = offsets.length - 2;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const top = offsets[mid]!;
    const bottom = offsets[mid + 1]!;
    if (y < top) {
      hi = mid - 1;
    } else if (y >= bottom) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

export function findColumnAtX(
  columns: GridColumnDrawInfo[],
  contentX: number,
  _scrollLeft: number,
  pinnedWidth: number,
): number {
  // 固定列：按绘制顺序从 0 累加宽度命中，避免 sticky/测量导致 col.x 漂移后点不中行号
  if (pinnedWidth > 0 && contentX < pinnedWidth) {
    let pinnedX = 0;
    for (let i = 0; i < columns.length; i += 1) {
      const col = columns[i]!;
      if (!isPinnedDrawColumn(col)) continue;
      if (contentX >= pinnedX && contentX < pinnedX + col.width) {
        return i;
      }
      pinnedX += col.width;
    }
  }

  for (let i = 0; i < columns.length; i += 1) {
    const col = columns[i]!;
    if (isPinnedDrawColumn(col)) continue;
    if (contentX >= col.x && contentX < col.x + col.width) {
      return i;
    }
  }
  return -1;
}

export function isPinnedDrawColumn(col: {
  pinned: boolean;
  isRowNum: boolean;
  isFieldCol: boolean;
}): boolean {
  return col.pinned || col.isRowNum || col.isFieldCol;
}

export function getPinnedWidth(columns: GridColumnDrawInfo[]): number {
  let width = 0;
  for (const col of columns) {
    if (isPinnedDrawColumn(col)) width += col.width;
  }
  return width;
}

export function cellContentRect(
  snapshot: GridRenderSnapshot,
  rowOffsets: number[],
  rowIndex: number,
  colIndex: number,
): { x: number; y: number; width: number; height: number } | null {
  const col = snapshot.columns[colIndex];
  if (!col || rowIndex < 0 || rowIndex >= snapshot.rowCount) return null;
  const y = rowOffsets[rowIndex] ?? snapshot.getRowOffset(rowIndex);
  const height = snapshot.getRowHeight(rowIndex);
  return { x: col.x, y, width: col.width, height };
}

/**
 * 将内容坐标单元格转为视口矩形（相对视口/client）。
 * wrapRect: wrap.getBoundingClientRect()
 */
export function cellViewportRect(
  snapshot: GridRenderSnapshot,
  rowOffsets: number[],
  rowIndex: number,
  colIndex: number,
  scrollLeft: number,
  scrollTop: number,
  wrapRect: DOMRect,
  headerHeight: number,
): CellViewportRect | null {
  const rect = cellContentRect(snapshot, rowOffsets, rowIndex, colIndex);
  if (!rect) return null;
  const col = snapshot.columns[colIndex]!;
  const screenX = isPinnedDrawColumn(col) ? rect.x : rect.x - scrollLeft;
  const screenY = rect.y - scrollTop + headerHeight;
  return {
    left: wrapRect.left + screenX,
    top: wrapRect.top + screenY,
    width: rect.width,
    height: rect.height,
  };
}

export function valueBtnRect(cell: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } {
  return {
    x: cell.x + cell.width - VALUE_BTN_RIGHT - VALUE_BTN_SIZE,
    y: cell.y + (cell.height - VALUE_BTN_SIZE) / 2,
    width: VALUE_BTN_SIZE,
    height: VALUE_BTN_SIZE,
  };
}

export function pointInRect(
  x: number,
  y: number,
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/**
 * 将视口指针映射为内容坐标。
 * canvas 贴在 sticky 视口：viewportX/Y 相对 canvas 左上角。
 */
export function viewportToContent(
  viewportX: number,
  viewportY: number,
  scrollLeft: number,
  scrollTop: number,
  pinnedWidth: number,
): { contentX: number; contentY: number } {
  const contentY = scrollTop + viewportY;
  const contentX = viewportX < pinnedWidth ? viewportX : viewportX + scrollLeft;
  return { contentX, contentY };
}

export function hitTestGrid(
  snapshot: GridRenderSnapshot,
  rowOffsets: number[],
  viewportX: number,
  viewportY: number,
  scrollLeft: number,
  scrollTop: number,
): GridHitResult | null {
  const pinnedWidth = getPinnedWidth(snapshot.columns);
  const { contentX, contentY } = viewportToContent(
    viewportX,
    viewportY,
    scrollLeft,
    scrollTop,
    pinnedWidth,
  );

  const rowIndex = findRowAtOffset(rowOffsets, contentY);
  if (rowIndex < 0) return null;

  const colIndex = findColumnAtX(snapshot.columns, contentX, scrollLeft, pinnedWidth);
  if (colIndex < 0) return null;

  const cellRect = cellContentRect(snapshot, rowOffsets, rowIndex, colIndex);
  if (!cellRect) return null;

  const col = snapshot.columns[colIndex]!;
  const model = snapshot.getCellModel(rowIndex, colIndex);
  let region: GridHitRegion = "cell";

  if (col.isRowNum) {
    region = "rownum";
    if (contentY >= cellRect.y + cellRect.height - ROW_RESIZE_ZONE_PX) {
      region = "rowResize";
    }
  } else if (col.isFieldCol) {
    region = "field";
    if (contentY >= cellRect.y + cellRect.height - ROW_RESIZE_ZONE_PX) {
      region = "rowResize";
    } else if (model) {
      // 右侧动作按钮：filter 在最右，sort 在其左
      const filterX = cellRect.x + cellRect.width - FIELD_ACTION_BTN_SIZE - 4;
      const sortX = filterX - FIELD_ACTION_BTN_SIZE - 2;
      const btnY = cellRect.y + (cellRect.height - FIELD_ACTION_BTN_SIZE) / 2;
      if (
        contentX >= filterX &&
        contentX < filterX + FIELD_ACTION_BTN_SIZE &&
        contentY >= btnY &&
        contentY < btnY + FIELD_ACTION_BTN_SIZE
      ) {
        region = "fieldFilter";
      } else if (
        contentX >= sortX &&
        contentX < sortX + FIELD_ACTION_BTN_SIZE &&
        contentY >= btnY &&
        contentY < btnY + FIELD_ACTION_BTN_SIZE
      ) {
        region = "fieldSort";
      }
    }
  } else if (model?.showValueBtn && snapshot.hoverRow === rowIndex && snapshot.hoverCol === colIndex) {
    const btn = valueBtnRect(cellRect);
    if (pointInRect(contentX, contentY, btn)) {
      region = "valueBtn";
    }
  }

  return { rowIndex, colIndex, region, cellRect };
}
