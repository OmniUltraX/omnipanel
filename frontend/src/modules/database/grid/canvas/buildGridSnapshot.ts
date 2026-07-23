import type { DbColumnMeta } from "../../api";
import {
  resolvePreviewRowChangeKind,
  resolvePreviewRowKey,
  type PreviewRowChangeKind,
} from "../../workspace/dbWorkspaceState";
import { formatCellDisplayText, isEmptyCellValue, isNullCellValue } from "../tableDataGridFormat";
import { ROW_NUM_COL_ID, TRANSPOSE_FIELD_COL } from "../tableDataGridConstants";
import { isRelationDisplayColumn } from "../tableColumnRelation";
import {
  isCellSelected,
  type CellRange,
} from "../tableDataGridSelection";
import { isPinnedGridColumn } from "../tableDataGridColumnVirtualization";
import type {
  GridCellDrawModel,
  GridColumnDrawInfo,
  GridRenderSnapshot,
} from "./gridRenderTypes";
import { buildColumnOffsets, buildRowOffsets } from "./gridGeometry";

const EMPTY_DELETED = new Set<string>();

export type BuildGridSnapshotInput = {
  leafColumns: Array<{ id: string; getSize: () => number }>;
  tableRows: Array<{ index: number; original: Record<string, unknown> }>;
  resolveColumnWidth: (columnId: string, baseSize: number) => number;
  rowHeights: Record<number, number>;
  defaultRowHeight: number;
  /** 列宽拖拽进行中时覆盖 */
  dragColumnWidth?: { columnId: string; width: number } | null;
  /** 行高拖拽进行中时覆盖 */
  dragRowHeight?: { rowIndex: number; height: number } | null;
  /** 表头实测列宽（与 DOM 布局对齐；优先于逻辑宽度） */
  measuredColumnWidths?: number[] | null;
  /** 表头实测几何（含 offsetLeft，优先于 measuredColumnWidths） */
  measuredColumnGeometry?: Array<{ x: number; width: number }> | null;
  /** 与表头 table.offsetWidth 对齐的内容总宽 */
  measuredTotalWidth?: number | null;
  transposed: boolean;
  columnMetaMap: Record<string, DbColumnMeta> | null;
  pkCols: { name: string }[];
  displayCellOverrides?: Record<string, Record<string, unknown>> | null;
  displayDirtyRowKeys?: ReadonlySet<string> | null;
  deletedRowKeys?: ReadonlySet<string> | null;
  cellRange: CellRange | null;
  dragRange: CellRange | null;
  selectedRows: ReadonlySet<number>;
  hoverRow: number | null;
  hoverCol: number | null;
  page: number;
  pageSize: number;
  hasCellEdit: boolean;
  enableValuePanelAffordance: boolean;
  relationHighlightColumnIds: ReadonlySet<string>;
  enableSort: boolean;
  sortColumn: string | null;
  sortDirection: "asc" | "desc" | null;
  canFilter: boolean;
  filterColumnNames: ReadonlySet<string>;
  autoIncrementPlaceholder: string;
  nullLabel: string;
  emptyLabel: string;
};

export type GridSnapshotBundle = {
  snapshot: GridRenderSnapshot;
  rowOffsets: number[];
};

export function buildGridSnapshotBundle(input: BuildGridSnapshotInput): GridSnapshotBundle {
  const measuredGeometry = input.measuredColumnGeometry;
  const useGeometry =
    Array.isArray(measuredGeometry) && measuredGeometry.length === input.leafColumns.length;
  const measured = input.measuredColumnWidths;
  const useMeasured =
    !useGeometry && Array.isArray(measured) && measured.length === input.leafColumns.length;

  const widths = input.leafColumns.map((col, index) => {
    if (useGeometry) {
      return measuredGeometry[index]!.width;
    }
    if (useMeasured) {
      return measured[index]!;
    }
    if (input.dragColumnWidth && input.dragColumnWidth.columnId === col.id) {
      return input.dragColumnWidth.width;
    }
    return input.resolveColumnWidth(col.id, col.getSize());
  });
  const { columns: offsetCols, totalWidth: offsetsTotal } = buildColumnOffsets(widths);
  const totalWidth =
    input.measuredTotalWidth != null && input.measuredTotalWidth > 0
      ? input.measuredTotalWidth
      : offsetsTotal;

  const columns: GridColumnDrawInfo[] = input.leafColumns.map((col, index) => {
    const offset = offsetCols[index]!;
    const geometry = useGeometry ? measuredGeometry[index]! : null;
    const pinned = isPinnedGridColumn(col.id, input.transposed);
    const isRowNum = col.id === ROW_NUM_COL_ID;
    const isFieldCol = input.transposed && col.id === TRANSPOSE_FIELD_COL;
    return {
      id: col.id,
      // 固定列始终用逻辑偏移，避免 sticky 表头测量污染命中检测
      x: pinned || isRowNum || isFieldCol ? offset.x : (geometry?.x ?? offset.x),
      width: geometry?.width ?? offset.width,
      pinned,
      isRowNum,
      isFieldCol,
      isRelation:
        !input.transposed &&
        input.relationHighlightColumnIds.has(col.id) &&
        !isRelationDisplayColumn(col.id),
      isRelationDisplay: !input.transposed && isRelationDisplayColumn(col.id),
    };
  });

  const getRowHeight = (rowIndex: number) => {
    if (input.dragRowHeight && input.dragRowHeight.rowIndex === rowIndex) {
      return input.dragRowHeight.height;
    }
    const row = input.tableRows[rowIndex];
    if (!row) return input.defaultRowHeight;
    return input.rowHeights[row.index] ?? input.defaultRowHeight;
  };

  const { offsets: rowOffsets, totalHeight } = buildRowOffsets(
    input.tableRows.length,
    getRowHeight,
  );

  const getRowOffset = (rowIndex: number) => rowOffsets[rowIndex] ?? 0;

  const getCellModel = (rowIndex: number, colIndex: number): GridCellDrawModel | null => {
    const tableRow = input.tableRows[rowIndex];
    const col = columns[colIndex];
    const leaf = input.leafColumns[colIndex];
    if (!tableRow || !col || !leaf) return null;

    if (col.isRowNum) {
      const displayNum = input.page * input.pageSize + rowIndex + 1;
      const rowKey = resolvePreviewRowKey(tableRow.original, input.pkCols);
      const dirtyKind: PreviewRowChangeKind = resolvePreviewRowChangeKind(
        rowKey,
        input.deletedRowKeys ?? EMPTY_DELETED,
        input.displayDirtyRowKeys ?? undefined,
      );
      return {
        kind: "rownum",
        text: String(displayNum),
        dirty: dirtyKind !== "none",
        dirtyKind,
        selected: false,
        dragSelected: false,
        canEdit: false,
        showValueBtn: false,
        fieldSortDir: null,
        fieldFiltered: false,
      };
    }

    const transposedFieldName = input.transposed
      ? String(tableRow.original[TRANSPOSE_FIELD_COL] ?? "")
      : "";

    if (col.isFieldCol) {
      const fieldSortActive =
        input.enableSort && input.sortColumn === transposedFieldName;
      return {
        kind: "field",
        text: transposedFieldName,
        dirty: false,
        dirtyKind: "none",
        selected: false,
        dragSelected: false,
        canEdit: false,
        showValueBtn: false,
        fieldSortDir: fieldSortActive ? input.sortDirection : null,
        fieldFiltered:
          input.canFilter && input.filterColumnNames.has(transposedFieldName),
      };
    }

    const rowKey = input.transposed
      ? transposedFieldName
      : resolvePreviewRowKey(tableRow.original, input.pkCols);
    const overrideForRow = rowKey ? input.displayCellOverrides?.[rowKey] : undefined;
    const overrideValue = overrideForRow?.[leaf.id];
    const rawValue =
      overrideValue !== undefined ? overrideValue : tableRow.original[leaf.id];

    const colMeta = input.transposed
      ? input.columnMetaMap?.[transposedFieldName]
      : input.columnMetaMap?.[leaf.id];

    const dirtyKind: PreviewRowChangeKind = input.transposed
      ? rowKey && input.displayDirtyRowKeys?.has(rowKey)
        ? "update"
        : "none"
      : resolvePreviewRowChangeKind(
          rowKey,
          input.deletedRowKeys ?? EMPTY_DELETED,
          input.displayDirtyRowKeys ?? undefined,
        );

    const cellDirty =
      dirtyKind === "insert" ||
      dirtyKind === "delete" ||
      (overrideValue !== undefined && dirtyKind !== "none");

    const displayText = formatCellDisplayText(rawValue, {
      row: tableRow.original,
      columnId: leaf.id,
      colMeta,
      overrideForRow,
      pkCount: input.pkCols.length,
      autoIncrementPlaceholder: input.autoIncrementPlaceholder,
    });

    const isPlaceholder = displayText === input.autoIncrementPlaceholder;
    let kind: GridCellDrawModel["kind"] = "text";
    if (isPlaceholder) kind = "placeholder";
    else if (isNullCellValue(rawValue)) kind = "null";
    else if (isEmptyCellValue(rawValue)) kind = "empty";

    const selected = isCellSelected(
      tableRow.index,
      colIndex,
      input.cellRange,
      input.selectedRows,
      columns.length,
    );
    const dragSelected =
      !selected &&
      isCellSelected(tableRow.index, colIndex, input.dragRange, new Set(), columns.length);

    return {
      kind,
      text: kind === "null" || kind === "empty" ? "" : displayText,
      dirty: cellDirty,
      dirtyKind,
      selected,
      dragSelected,
      canEdit: input.hasCellEdit && Boolean(colMeta),
      showValueBtn:
        input.enableValuePanelAffordance && !col.isRelationDisplay,
      fieldSortDir: null,
      fieldFiltered: false,
    };
  };

  const snapshot: GridRenderSnapshot = {
    rowCount: input.tableRows.length,
    columnCount: columns.length,
    columns,
    totalWidth,
    totalHeight,
    defaultRowHeight: input.defaultRowHeight,
    getRowHeight,
    getRowOffset,
    getCellModel,
    hoverRow: input.hoverRow,
    hoverCol: input.hoverCol,
    nullLabel: input.nullLabel,
    emptyLabel: input.emptyLabel,
  };

  return { snapshot, rowOffsets };
}
