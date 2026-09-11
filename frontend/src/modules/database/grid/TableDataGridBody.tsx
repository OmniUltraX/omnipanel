import type { MouseEvent as ReactMouseEvent } from "react";
import type { CellOverlayAnchor } from "./tableCellPreview";

/** Canvas body 命中后回传给 TableDataGrid 的单元格上下文 */
export type GridBodyCellInteractionContext = {
  rowIndex: number;
  colIndex: number;
  columnId: string;
  row: Record<string, unknown>;
  isFieldCol: boolean;
  fieldName: string;
  rawValue: unknown;
  canEdit: boolean;
  columnType?: string;
};

/** Canvas body 交互回调；由 TableDataGrid 注入 */
export type TableDataGridBodyActions = {
  beginRowResize: (rowIndex: number, clientY: number) => void;
  handleRowBandSelect: (rowIndex: number, event: ReactMouseEvent) => void;
  /** 双击行号/字段列：选中整行并打开记录面板 */
  handleRowBandDoubleClick?: (rowIndex: number) => void;
  handleDataCellMouseDown: (ctx: GridBodyCellInteractionContext, event: ReactMouseEvent) => void;
  handleDataCellDoubleClick: (
    ctx: GridBodyCellInteractionContext,
    anchor: CellOverlayAnchor,
  ) => void;
  handleDataCellContextMenu: (ctx: GridBodyCellInteractionContext, event: ReactMouseEvent) => void;
  /** 选中单元格并打开值面板（详情图标单击） */
  handleOpenValuePanel?: (ctx: GridBodyCellInteractionContext) => void;
};
