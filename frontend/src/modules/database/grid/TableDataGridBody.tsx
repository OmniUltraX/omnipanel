import {
  memo,
  useCallback,
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { flexRender, type Cell, type Row } from "@tanstack/react-table";
import type { DbColumnMeta } from "../api";
import {
  getCellOverlayAnchor,
  type CellOverlayAnchor,
} from "./tableCellPreview";
import {
  ROW_NUM_COL_ID,
  TRANSPOSE_FIELD_COL,
} from "./tableDataGridConstants";
import { isRelationDisplayColumn } from "./tableColumnRelation";
import { buildColumnCellStyle, isNearRowBottom } from "./tableDataGridLayout";
import {
  isCellSelected,
  rowSelectionStateEqual,
  type CellRange,
} from "./tableDataGridSelection";

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

export type TableDataGridBodyActions = {
  beginRowResize: (rowIndex: number, clientY: number) => void;
  handleRowBandSelect: (rowIndex: number, event: ReactMouseEvent) => void;
  handleDataCellMouseDown: (ctx: GridBodyCellInteractionContext, event: ReactMouseEvent) => void;
  handleDataCellDoubleClick: (
    ctx: GridBodyCellInteractionContext,
    anchor: CellOverlayAnchor,
  ) => void;
  handleDataCellContextMenu: (ctx: GridBodyCellInteractionContext, event: ReactMouseEvent) => void;
};

type GridBodyCellProps = {
  colIndex: number;
  columnId: string;
  isRowNum: boolean;
  isFieldCol: boolean;
  isSelected: boolean;
  isDirty: boolean;
  canEdit: boolean;
  fieldSortClass: string;
  fieldFiltered: boolean;
  isCustomHeight: boolean;
  columnSized: boolean;
  baseSize: number;
  lastColumnId: string;
  fillDelta: number;
  cellContentKey: string;
  cell: Cell<Record<string, unknown>, unknown>;
  isRelationHighlight: boolean;
  isRelationDisplayCol: boolean;
};

const GridBodyCell = memo(
  function GridBodyCell({
    colIndex,
    columnId,
    isRowNum,
    isFieldCol,
    isSelected,
    isDirty,
    canEdit,
    fieldSortClass,
    fieldFiltered,
    isCustomHeight,
    columnSized,
    baseSize,
    lastColumnId,
    fillDelta,
    cellContentKey: _cellContentKey,
    cell,
    isRelationHighlight,
    isRelationDisplayCol,
  }: GridBodyCellProps) {
    const relationClass = isRelationDisplayCol
      ? " db-data-table-cell--relation-display"
      : isRelationHighlight
        ? " db-data-table-cell--relation"
        : "";
    return (
      <td
        data-col-id={columnId}
        data-col-index={colIndex}
        style={buildColumnCellStyle(columnId, baseSize, lastColumnId, fillDelta)}
        className={`db-data-table-cell${isCustomHeight ? " db-data-table-cell--custom-h" : ""}${columnSized ? " db-data-table-cell--sized" : ""}${canEdit ? " db-cell--editable" : ""}${isDirty ? " db-data-table-cell--dirty" : ""}${isRowNum ? " db-data-table-cell--rownum" : ""}${isFieldCol ? " db-data-table-cell--field db-data-table-cell--row-select" : ""}${fieldFiltered ? " db-data-table-cell--filtered" : ""}${fieldSortClass}${isSelected ? " db-data-table-cell--selected" : ""}${relationClass}`}
      >
        {flexRender(cell.column.columnDef.cell, cell.getContext())}
      </td>
    );
  },
  (prev, next) =>
    prev.isSelected === next.isSelected &&
    prev.isDirty === next.isDirty &&
    prev.canEdit === next.canEdit &&
    prev.fieldSortClass === next.fieldSortClass &&
    prev.fieldFiltered === next.fieldFiltered &&
    prev.isCustomHeight === next.isCustomHeight &&
    prev.columnSized === next.columnSized &&
    prev.baseSize === next.baseSize &&
    prev.lastColumnId === next.lastColumnId &&
    prev.fillDelta === next.fillDelta &&
    prev.cellContentKey === next.cellContentKey &&
    prev.columnId === next.columnId &&
    prev.isRowNum === next.isRowNum &&
    prev.isFieldCol === next.isFieldCol &&
    prev.isRelationHighlight === next.isRelationHighlight &&
    prev.isRelationDisplayCol === next.isRelationDisplayCol &&
    prev.cell === next.cell,
);

export type GridBodyStaticConfig = {
  transposed: boolean;
  columnMetaMap: Record<string, DbColumnMeta> | null;
  canFilter: boolean;
  filterColumnNames: ReadonlySet<string>;
  enableSort: boolean;
  sortColumn: string | null;
  sortDirection: "asc" | "desc" | null;
  hasCellEdit: boolean;
  lastColumnId: string;
  fillDelta: number;
  leafColumnCount: number;
  columnSizedIds: ReadonlySet<string>;
  relationHighlightColumnIds: ReadonlySet<string>;
};

export type GridBodyRowProps = {
  row: Row<Record<string, unknown>>;
  rowDirty: boolean;
  overrideForRow: Record<string, unknown> | undefined;
  rowHeight: number | undefined;
  cellRange: CellRange | null;
  selectedRows: ReadonlySet<number>;
  staticConfig: GridBodyStaticConfig;
};

function renderBodyCell(
  cellIdx: number,
  cells: Cell<Record<string, unknown>, unknown>[],
  row: Row<Record<string, unknown>>,
  staticConfig: GridBodyStaticConfig,
  overrideForRow: Record<string, unknown> | undefined,
  rowDirty: boolean,
  cellRange: CellRange | null,
  selectedRows: ReadonlySet<number>,
  transposedFieldName: string,
  isCustomHeight: boolean,
) {
  const cell = cells[cellIdx];
  if (!cell) return null;

  const {
    transposed,
    columnMetaMap,
    canFilter,
    filterColumnNames,
    enableSort,
    sortColumn,
    sortDirection,
    hasCellEdit,
    lastColumnId,
    fillDelta,
    leafColumnCount,
    columnSizedIds,
    relationHighlightColumnIds,
  } = staticConfig;

  const isRowNum = cell.column.id === ROW_NUM_COL_ID;
  const isFieldCol = transposed && cell.column.id === TRANSPOSE_FIELD_COL;
  const fieldName = transposedFieldName;
  const fieldFiltered = isFieldCol && canFilter && filterColumnNames.has(fieldName);
  const isRowSelector = isRowNum || isFieldCol;
  const colMeta =
    isRowNum || isFieldCol
      ? undefined
      : transposed
        ? columnMetaMap?.[transposedFieldName]
        : columnMetaMap?.[cell.column.id];
  const canEdit = !isRowSelector && hasCellEdit && Boolean(colMeta);
  const overrideValue = isRowSelector ? undefined : overrideForRow?.[cell.column.id];
  const cellDirty = !isRowSelector && overrideValue !== undefined && rowDirty;
  const fieldSortActive = isFieldCol && enableSort && sortColumn === fieldName;
  const fieldSortClass = fieldSortActive
    ? sortDirection === "asc"
      ? " db-data-table-cell--sort-asc"
      : " db-data-table-cell--sort-desc"
    : "";
  const isSelected =
    !isRowSelector &&
    isCellSelected(row.index, cellIdx, cellRange, selectedRows, leafColumnCount);
  const isRelationHighlight =
    !isRowSelector && relationHighlightColumnIds.has(cell.column.id);
  const isRelationDisplayCol =
    !isRowSelector && !transposed && isRelationDisplayColumn(cell.column.id);
  const baseSize = cell.column.getSize();
  const columnSized = columnSizedIds.has(cell.column.id);
  const cellContentKey = isRowSelector
    ? ""
    : `${overrideValue ?? cell.getValue()}:${cellDirty}:${canEdit}`;

  return (
    <GridBodyCell
      key={cell.id}
      colIndex={cellIdx}
      columnId={cell.column.id}
      isRowNum={isRowNum}
      isFieldCol={isFieldCol}
      isSelected={isSelected}
      isDirty={cellDirty}
      canEdit={canEdit}
      fieldSortClass={fieldSortClass}
      fieldFiltered={fieldFiltered}
      isCustomHeight={isCustomHeight}
      columnSized={columnSized}
      baseSize={baseSize}
      lastColumnId={lastColumnId}
      fillDelta={fillDelta}
      cellContentKey={cellContentKey}
      cell={cell}
      isRelationHighlight={isRelationHighlight}
      isRelationDisplayCol={isRelationDisplayCol}
    />
  );
}

const GridBodyRow = memo(
  function GridBodyRow({
    row,
    rowDirty,
    overrideForRow,
    rowHeight,
    cellRange,
    selectedRows,
    staticConfig,
  }: GridBodyRowProps) {
    const isCustomHeight = rowHeight !== undefined;
    const transposedFieldName = staticConfig.transposed
      ? String(row.original[TRANSPOSE_FIELD_COL] ?? "")
      : "";
    const cells = row.getVisibleCells();

    return (
      <tr
        data-row-index={row.index}
        className={`db-data-table-row${Math.floor(row.index / 2) % 2 === 1 ? " db-data-table-row--striped" : ""}${isCustomHeight ? " db-data-table-row--custom-h" : ""}${rowDirty ? " db-data-table-row--dirty" : ""}`}
        style={isCustomHeight ? { height: rowHeight } : undefined}
      >
        {cells.map((_, cellIdx) =>
          renderBodyCell(
            cellIdx,
            cells,
            row,
            staticConfig,
            overrideForRow,
            rowDirty,
            cellRange,
            selectedRows,
            transposedFieldName,
            isCustomHeight,
          ),
        )}
      </tr>
    );
  },
  (prev, next) => {
    if (prev.row !== next.row) return false;
    if (prev.rowDirty !== next.rowDirty) return false;
    if (prev.overrideForRow !== next.overrideForRow) return false;
    if (prev.rowHeight !== next.rowHeight) return false;
    if (prev.staticConfig !== next.staticConfig) return false;
    return rowSelectionStateEqual(
      prev.row.index,
      prev.cellRange,
      prev.selectedRows,
      next.cellRange,
      next.selectedRows,
      prev.staticConfig.leafColumnCount,
    );
  },
);

function resolveCellFromTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  const td = target.closest("td");
  if (!(td instanceof HTMLTableCellElement)) return null;
  const tr = td.closest("tr");
  if (!(tr instanceof HTMLTableRowElement)) return null;
  const rowIndex = Number(tr.dataset.rowIndex);
  const colIndex = Number(td.dataset.colIndex);
  if (Number.isNaN(rowIndex) || Number.isNaN(colIndex)) return null;
  return { td, tr, rowIndex, colIndex };
}

export type TableDataGridBodyProps = {
  tableRows: Row<Record<string, unknown>>[];
  buildRowProps: (rowIndex: number) => Omit<GridBodyRowProps, "row"> | null;
  bodyActionsRef: MutableRefObject<TableDataGridBodyActions | null>;
  resolveCellContext: (
    rowIndex: number,
    colIndex: number,
  ) => GridBodyCellInteractionContext | null;
};

export function TableDataGridBody({
  tableRows,
  buildRowProps,
  bodyActionsRef,
  resolveCellContext,
}: TableDataGridBodyProps) {
  const handleMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLTableSectionElement>) => {
      const actions = bodyActionsRef.current;
      if (!actions || event.button !== 0) return;

      const resolved = resolveCellFromTarget(event.target);
      if (!resolved) {
        const tr = event.target instanceof Element ? event.target.closest("tr") : null;
        if (tr instanceof HTMLTableRowElement && tr.dataset.rowIndex != null) {
          if (isNearRowBottom(tr, event.clientY)) {
            event.preventDefault();
            actions.beginRowResize(Number(tr.dataset.rowIndex), event.clientY);
          }
        }
        return;
      }

      const { tr, rowIndex, colIndex } = resolved;
      const ctx = resolveCellContext(rowIndex, colIndex);
      if (!ctx) return;

      const isRowSelector =
        ctx.columnId === ROW_NUM_COL_ID || ctx.columnId === TRANSPOSE_FIELD_COL;

      if (isRowSelector) {
        if (isNearRowBottom(tr, event.clientY)) {
          event.preventDefault();
          event.stopPropagation();
          actions.beginRowResize(rowIndex, event.clientY);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        actions.handleRowBandSelect(rowIndex, event);
        return;
      }

      if (event.detail >= 2) return;

      if (isNearRowBottom(tr, event.clientY)) {
        event.preventDefault();
        event.stopPropagation();
        actions.beginRowResize(rowIndex, event.clientY);
        return;
      }

      actions.handleDataCellMouseDown(ctx, event);
    },
    [bodyActionsRef, resolveCellContext],
  );

  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLTableSectionElement>) => {
      const actions = bodyActionsRef.current;
      if (!actions) return;
      const resolved = resolveCellFromTarget(event.target);
      if (!resolved) return;
      const ctx = resolveCellContext(resolved.rowIndex, resolved.colIndex);
      if (!ctx || !ctx.canEdit) return;
      event.preventDefault();
      event.stopPropagation();
      actions.handleDataCellDoubleClick(ctx, getCellOverlayAnchor(resolved.td));
    },
    [bodyActionsRef, resolveCellContext],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLTableSectionElement>) => {
      const actions = bodyActionsRef.current;
      if (!actions) return;
      const resolved = resolveCellFromTarget(event.target);
      if (!resolved) return;
      const ctx = resolveCellContext(resolved.rowIndex, resolved.colIndex);
      if (!ctx || ctx.columnId === ROW_NUM_COL_ID) return;
      event.preventDefault();
      event.stopPropagation();
      actions.handleDataCellContextMenu(ctx, event);
    },
    [bodyActionsRef, resolveCellContext],
  );

  return (
    <tbody
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      {tableRows.map((tableRow, rowIndex) => {
        const rowProps = buildRowProps(rowIndex);
        if (!rowProps) return null;
        return <GridBodyRow key={tableRow.id} row={tableRow} {...rowProps} />;
      })}
    </tbody>
  );
}
