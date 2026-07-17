import { detectCellEditorKind } from "../cell_editor/types";

export const MIN_ROW_HEIGHT = 28;
export const DEFAULT_ROW_HEIGHT = 32;
export const ROW_RESIZE_ZONE_PX = 2;
export const COLUMN_MIN_WIDTH = 52;
/** 普通数据列默认宽度 */
export const DEFAULT_DATA_COLUMN_WIDTH = 120;
/** datetime / timestamp 列默认宽度 */
export const DATETIME_COLUMN_WIDTH = 150;
/** 超过该列数启用列向虚拟化 */
export const COLUMN_VIRTUALIZE_THRESHOLD = 24;
export const COLUMN_VIRTUALIZE_OVERSCAN = 3;
/**
 * 超过该行数才启用行虚拟化。
 * 默认分页常见 100 行：须低于 pageSize，否则整页全量 DOM 拖垮侧栏滚动。
 */
export const ROW_VIRTUALIZE_THRESHOLD = 40;
export const ROW_VIRTUALIZE_OVERSCAN = 8;
export const ROW_NUM_COL_ID = "__row_num__";
export const TRANSPOSE_FIELD_COL = "__field__";

export const transposeRowColId = (index: number) => `__row__${index}`;

export function defaultDataColumnWidth(rawType?: string | null): number {
  if (rawType && detectCellEditorKind(rawType) === "datetime") {
    return DATETIME_COLUMN_WIDTH;
  }
  return DEFAULT_DATA_COLUMN_WIDTH;
}

/** 点击这些区域时不应清除表网格的单元格/行选中 */
export const GRID_EXTERNAL_INTERACTION_SELECTOR = [
  ".db-data-table-cell-overlay",
  ".db-query-filter-popover",
  ".context-menu-panel",
  ".detail-panel-subwindow",
  ".drawer-overlay",
  ".subwindow-overlay",
  ".subwindow-panel",
  ".db-cell-preview-subwindow",
  ".file-preview-subwindow",
  ".db-cell-editor-panel",
  ".db-table-detail-panel",
  ".db-table-preview-split .dock-panel-right",
  ".db-table-preview-split .dock-panel-bottom",
  ".db-table-preview-split .dock-handle",
  ".redis-key-detail-split .dock-panel-bottom",
  ".redis-key-detail-split .dock-handle",
].join(", ");
