import { detectCellEditorKind, parseColumnCharLength } from "../cell_editor/types";

export const MIN_ROW_HEIGHT = 28;
export const DEFAULT_ROW_HEIGHT = 32;
export const ROW_RESIZE_ZONE_PX = 2;
export const COLUMN_MIN_WIDTH = 52;
/** 普通数据列默认宽度 */
export const DEFAULT_DATA_COLUMN_WIDTH = 120;
/** datetime / timestamp 列默认宽度 */
export const DATETIME_COLUMN_WIDTH = 150;
/** 长文本 / 大字段默认宽度 */
export const LONG_TEXT_COLUMN_WIDTH = 280;
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

/**
 * 按字段类型 / 声明长度给初始列宽（末列仍可由 fillDelta 吃掉剩余）。
 * length 优先用 schema 反射；否则从 type 串 varchar(N) 解析。
 */
export function defaultDataColumnWidth(
  rawType?: string | null,
  length?: number | null,
  columnName?: string | null,
): number {
  const type = rawType?.trim() || "";
  const kind = type ? detectCellEditorKind(type) : "text";
  const charLen =
    length != null && length > 0
      ? length
      : type
        ? parseColumnCharLength(type)
        : null;
  const name = columnName?.trim() || "";

  switch (kind) {
    case "boolean":
      return 72;
    case "number": {
      const lower = type.toLowerCase();
      if (lower.includes("bigint") || /(?:^|_)id$/i.test(name) || /^id$/i.test(name)) {
        return 110;
      }
      if (lower.includes("decimal") || lower.includes("numeric")) {
        return 120;
      }
      return 88;
    }
    case "date":
      return 118;
    case "time":
      return 100;
    case "datetime":
      return DATETIME_COLUMN_WIDTH;
    case "json":
    case "binary":
      return 160;
    case "text":
    default: {
      const lower = type.toLowerCase();
      if (lower.includes("uuid") || lower.includes("guid")) {
        return 280;
      }
      if (
        lower.includes("text") ||
        lower.includes("clob") ||
        (charLen != null && charLen > 512)
      ) {
        return LONG_TEXT_COLUMN_WIDTH;
      }
      if (charLen != null && charLen > 0) {
        if (charLen <= 8) return Math.max(COLUMN_MIN_WIDTH, 52 + charLen * 8);
        if (charLen <= 32) return Math.min(180, 64 + charLen * 5);
        if (charLen <= 64) return 200;
        if (charLen <= 128) return 240;
        if (charLen <= 255) return 260;
        return LONG_TEXT_COLUMN_WIDTH;
      }
      return DEFAULT_DATA_COLUMN_WIDTH;
    }
  }
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
  // 顶栏删除/提交等：mousedown 在 click 之前，若清选区会导致「删除选中的 N 行」点了却无选中
  ".db-table-topbar",
  ".db-delete-selected-rows-wrap",
  ".db-pagination",
  ".db-table-preview-split .dock-panel-right",
  ".db-table-preview-split .dock-panel-bottom",
  ".db-table-preview-split .dock-handle",
  ".redis-key-detail-split .dock-panel-bottom",
  ".redis-key-detail-split .dock-handle",
].join(", ");
