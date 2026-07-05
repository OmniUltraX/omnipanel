export const MIN_ROW_HEIGHT = 28;
export const DEFAULT_ROW_HEIGHT = 32;
export const ROW_RESIZE_ZONE_PX = 6;
export const COLUMN_MIN_WIDTH = 52;
/** 超过该列数启用列向虚拟化 */
export const COLUMN_VIRTUALIZE_THRESHOLD = 24;
export const COLUMN_VIRTUALIZE_OVERSCAN = 3;
export const ROW_VIRTUALIZE_OVERSCAN = 8;
export const ROW_NUM_COL_ID = "__row_num__";
export const TRANSPOSE_FIELD_COL = "__field__";

export const transposeRowColId = (index: number) => `__row__${index}`;
