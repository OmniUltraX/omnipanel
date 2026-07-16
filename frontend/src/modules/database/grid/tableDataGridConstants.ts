export const MIN_ROW_HEIGHT = 28;
export const DEFAULT_ROW_HEIGHT = 32;
export const ROW_RESIZE_ZONE_PX = 6;
export const COLUMN_MIN_WIDTH = 52;
/** 超过该列数启用列向虚拟化 */
export const COLUMN_VIRTUALIZE_THRESHOLD = 24;
export const COLUMN_VIRTUALIZE_OVERSCAN = 3;
/**
 * 超过该行数才启用行虚拟化。
 * 分页常用 10/100 行：原生滚动更跟手；虚拟化会让整表随 scroll 重渲，反而卡。
 */
export const ROW_VIRTUALIZE_THRESHOLD = 200;
export const ROW_VIRTUALIZE_OVERSCAN = 8;
export const ROW_NUM_COL_ID = "__row_num__";
export const TRANSPOSE_FIELD_COL = "__field__";

export const transposeRowColId = (index: number) => `__row__${index}`;
