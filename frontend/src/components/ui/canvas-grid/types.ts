/** Canvas 数据网格渲染模式 */
export type CanvasGridRenderMode = "dom" | "canvas";

export type CanvasCellKind = "text" | "null" | "empty" | "placeholder" | "rownum" | "field";

export type CanvasDirtyKind = "none" | "update" | "insert" | "delete";

export type CanvasGridColumnInfo = {
  id: string;
  /** 内容坐标系下的左边界（不含 scroll） */
  x: number;
  width: number;
  pinned: boolean;
  isRowNum: boolean;
  isFieldCol: boolean;
  isRelation: boolean;
  isRelationDisplay: boolean;
};

export type CanvasCellDrawModel = {
  kind: CanvasCellKind;
  text: string;
  dirty: boolean;
  dirtyKind: CanvasDirtyKind;
  selected: boolean;
  dragSelected: boolean;
  /** 整行选中（面板表等） */
  rowSelected?: boolean;
  /** mono / name 列强调 */
  mono?: boolean;
  canEdit: boolean;
  showValueBtn: boolean;
  fieldSortDir: "asc" | "desc" | null;
  fieldFiltered: boolean;
};

export type CanvasGridThemeTokens = {
  bg: string;
  surface: string;
  surfaceHover: string;
  fg: string;
  fg2: string;
  meta: string;
  border: string;
  accent: string;
  warn: string;
  success: string;
  danger: string;
  fontFamily: string;
  fontSize: number;
  cellPaddingX: number;
  cellPaddingY: number;
  rownumBg: string;
  rownumStripedBg: string;
  selectedBg: string;
  dragSelectedBg: string;
  /** 整行选中背景 */
  rowSelectedBg: string;
  dirtyUpdateBg: string;
  dirtyInsertBg: string;
  dirtyDeleteBg: string;
  dirtyUpdateFg: string;
  dirtyInsertFg: string;
  dirtyDeleteFg: string;
  selectedDirtyUpdateBg: string;
  selectedDirtyInsertBg: string;
  selectedDirtyDeleteBg: string;
  relationBg: string;
  relationDisplayBg: string;
  relationStripedBg: string;
  relationDisplayStripedBg: string;
  nullTagFg: string;
  nullTagBg: string;
  nullTagBorder: string;
  emptyTagFg: string;
  emptyTagBg: string;
  emptyTagBorder: string;
  dirtyNullTagFg: string;
  dirtyNullTagBg: string;
  dirtyNullTagBorder: string;
  valueBtnBg: string;
  valueBtnBorder: string;
  valueBtnFg: string;
  placeholderFg: string;
  headerHeight: number;
};

export type CanvasGridSnapshot = {
  rowCount: number;
  columnCount: number;
  columns: CanvasGridColumnInfo[];
  totalWidth: number;
  totalHeight: number;
  defaultRowHeight: number;
  getRowHeight: (rowIndex: number) => number;
  /** 行顶偏移（累计高度） */
  getRowOffset: (rowIndex: number) => number;
  getCellModel: (rowIndex: number, colIndex: number) => CanvasCellDrawModel | null;
  hoverRow: number | null;
  hoverCol: number | null;
  nullLabel: string;
  emptyLabel: string;
};

export type CanvasGridHitRegion =
  | "cell"
  | "rownum"
  | "field"
  | "valueBtn"
  | "rowResize"
  | "fieldSort"
  | "fieldFilter";

export type CanvasGridHitResult = {
  rowIndex: number;
  colIndex: number;
  region: CanvasGridHitRegion;
  /** 内容坐标系下的单元格矩形 */
  cellRect: { x: number; y: number; width: number; height: number };
};

export type CanvasCellViewportRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** 兼容旧命名 */
export type GridRenderMode = CanvasGridRenderMode;
export type GridCellKind = CanvasCellKind;
export type GridColumnDrawInfo = CanvasGridColumnInfo;
export type GridCellDrawModel = CanvasCellDrawModel;
export type GridThemeTokens = CanvasGridThemeTokens;
export type GridRenderSnapshot = CanvasGridSnapshot;
export type GridHitRegion = CanvasGridHitRegion;
export type GridHitResult = CanvasGridHitResult;
export type CellViewportRect = CanvasCellViewportRect;
