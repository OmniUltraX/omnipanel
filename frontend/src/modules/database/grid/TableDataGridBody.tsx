import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  type MutableRefObject,
  type RefObject,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { flexRender, type Cell, type Row } from "@tanstack/react-table";
import type { DbColumnMeta } from "../api";
import {
  getCellOverlayAnchor,
  type CellOverlayAnchor,
} from "./tableCellPreview";
import {
  ROW_NUM_COL_ID,
  ROW_VIRTUALIZE_OVERSCAN,
  TRANSPOSE_FIELD_COL,
} from "./tableDataGridConstants";
import { isRelationDisplayColumn } from "./tableColumnRelation";
import type { ColumnVirtualizationLayout } from "./tableDataGridColumnVirtualization";
import { buildColumnCellStyle, isInRowResizeHandle, isNearRowBottom } from "./tableDataGridLayout";
import {
  isCellSelected,
  rowSelectionStateEqual,
  type CellRange,
} from "./tableDataGridSelection";
import type { PreviewRowChangeKind } from "../workspace/dbWorkspaceState";

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

type GridBodyCellProps = {
  colIndex: number;
  columnId: string;
  isRowNum: boolean;
  isFieldCol: boolean;
  isSelected: boolean;
  isDirty: boolean;
  dirtyKind: PreviewRowChangeKind;
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
  showValuePanelAffordance: boolean;
  valuePanelAffordanceTitle: string;
};

function dirtyCellClass(isDirty: boolean, dirtyKind: PreviewRowChangeKind): string {
  if (!isDirty) return "";
  if (dirtyKind === "insert") return " db-data-table-cell--dirty db-data-table-cell--dirty-insert";
  if (dirtyKind === "delete") return " db-data-table-cell--dirty db-data-table-cell--dirty-delete";
  return " db-data-table-cell--dirty";
}

const GridBodyCell = memo(
  function GridBodyCell({
    colIndex,
    columnId,
    isRowNum,
    isFieldCol,
    isSelected,
    isDirty,
    dirtyKind,
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
    showValuePanelAffordance,
    valuePanelAffordanceTitle,
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
        className={`db-data-table-cell${isCustomHeight ? " db-data-table-cell--custom-h" : ""}${columnSized ? " db-data-table-cell--sized" : ""}${canEdit ? " db-cell--editable" : ""}${dirtyCellClass(isDirty, dirtyKind)}${isRowNum ? " db-data-table-cell--rownum" : ""}${isFieldCol ? " db-data-table-cell--field db-data-table-cell--row-select" : ""}${fieldFiltered ? " db-data-table-cell--filtered" : ""}${fieldSortClass}${isSelected ? " db-data-table-cell--selected" : ""}${relationClass}${showValuePanelAffordance ? " db-data-table-cell--has-value-btn" : ""}`}
      >
        {flexRender(cell.column.columnDef.cell, cell.getContext())}
        {showValuePanelAffordance ? (
          <button
            type="button"
            className="db-data-table-cell-value-btn"
            tabIndex={-1}
            title={valuePanelAffordanceTitle}
            aria-label={valuePanelAffordanceTitle}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
              <circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path
                d="M8 7.25v3.5M8 5.35h.01"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        ) : null}
      </td>
    );
  },
  (prev, next) =>
    prev.isSelected === next.isSelected &&
    prev.isDirty === next.isDirty &&
    prev.dirtyKind === next.dirtyKind &&
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
    prev.showValuePanelAffordance === next.showValuePanelAffordance &&
    prev.valuePanelAffordanceTitle === next.valuePanelAffordanceTitle &&
    prev.cell === next.cell,
);

function ColumnSpacerCell({ width }: { width: number }) {
  return (
    <td
      className="db-data-table-spacer-col"
      aria-hidden
      style={{ width, minWidth: width, maxWidth: width, padding: 0, border: "none" }}
    />
  );
}

export type GridBodyStaticConfig = {
  transposed: boolean;
  columnMetaMap: Record<string, DbColumnMeta> | null;
  canFilter: boolean;
  filterColumnNames: ReadonlySet<string>;
  enableSort: boolean;
  sortColumn: string | null;
  sortDirection: "asc" | "desc" | null;
  hasCellEdit: boolean;
  enableValuePanelAffordance: boolean;
  valuePanelAffordanceTitle: string;
  lastColumnId: string;
  fillDelta: number;
  leafColumnCount: number;
  columnSizedIds: ReadonlySet<string>;
  columnLayout: ColumnVirtualizationLayout;
  relationHighlightColumnIds: ReadonlySet<string>;
};

export type GridBodyRowProps = {
  row: Row<Record<string, unknown>>;
  rowDirty: boolean;
  rowChangeKind: PreviewRowChangeKind;
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
  rowChangeKind: PreviewRowChangeKind,
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
    enableValuePanelAffordance,
    valuePanelAffordanceTitle,
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
  const cellDirty =
    !isRowSelector &&
    (rowChangeKind === "insert" ||
      rowChangeKind === "delete" ||
      (overrideValue !== undefined && rowDirty));
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
  const showValuePanelAffordance =
    enableValuePanelAffordance && !isRowSelector && !isRelationDisplayCol;
  const baseSize = cell.column.getSize();
  const columnSized = columnSizedIds.has(cell.column.id);
  const cellContentKey = isRowSelector
    ? ""
    : `${overrideValue ?? cell.getValue()}:${cellDirty}:${rowChangeKind}:${canEdit}`;

  return (
    <GridBodyCell
      key={cell.id}
      colIndex={cellIdx}
      columnId={cell.column.id}
      isRowNum={isRowNum}
      isFieldCol={isFieldCol}
      isSelected={isSelected}
      isDirty={cellDirty}
      dirtyKind={rowChangeKind}
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
      showValuePanelAffordance={showValuePanelAffordance}
      valuePanelAffordanceTitle={valuePanelAffordanceTitle}
    />
  );
}

const GridBodyRow = memo(
  function GridBodyRow({
    row,
    rowDirty,
    rowChangeKind,
    overrideForRow,
    rowHeight,
    cellRange,
    selectedRows,
    staticConfig,
  }: GridBodyRowProps) {
    const { columnLayout } = staticConfig;
    const isCustomHeight = rowHeight !== undefined;
    const transposedFieldName = staticConfig.transposed
      ? String(row.original[TRANSPOSE_FIELD_COL] ?? "")
      : "";
    const cells = row.getVisibleCells();
    const changeClass =
      rowChangeKind === "insert"
        ? " db-data-table-row--dirty db-data-table-row--dirty-insert"
        : rowChangeKind === "delete"
          ? " db-data-table-row--dirty db-data-table-row--dirty-delete"
          : rowDirty
            ? " db-data-table-row--dirty db-data-table-row--dirty-update"
            : "";

    return (
      <tr
        data-row-index={row.index}
        className={`db-data-table-row${Math.floor(row.index / 2) % 2 === 1 ? " db-data-table-row--striped" : ""}${isCustomHeight ? " db-data-table-row--custom-h" : ""}${changeClass}`}
        style={isCustomHeight ? { height: rowHeight } : undefined}
      >
        {columnLayout.enabled ? (
          <>
            {columnLayout.pinnedIndices.map((cellIdx) =>
              renderBodyCell(
                cellIdx,
                cells,
                row,
                staticConfig,
                overrideForRow,
                rowDirty,
                rowChangeKind,
                cellRange,
                selectedRows,
                transposedFieldName,
                isCustomHeight,
              ),
            )}
            {columnLayout.paddingLeft > 0 ? (
              <ColumnSpacerCell width={columnLayout.paddingLeft} />
            ) : null}
            {columnLayout.virtualIndices.map((cellIdx) =>
              renderBodyCell(
                cellIdx,
                cells,
                row,
                staticConfig,
                overrideForRow,
                rowDirty,
                rowChangeKind,
                cellRange,
                selectedRows,
                transposedFieldName,
                isCustomHeight,
              ),
            )}
            {columnLayout.paddingRight > 0 ? (
              <ColumnSpacerCell width={columnLayout.paddingRight} />
            ) : null}
          </>
        ) : (
          cells.map((_, cellIdx) =>
            renderBodyCell(
              cellIdx,
              cells,
              row,
              staticConfig,
              overrideForRow,
              rowDirty,
              rowChangeKind,
              cellRange,
              selectedRows,
              transposedFieldName,
              isCustomHeight,
            ),
          )
        )}
      </tr>
    );
  },
  (prev, next) => {
    if (prev.row !== next.row) return false;
    if (prev.rowDirty !== next.rowDirty) return false;
    if (prev.rowChangeKind !== next.rowChangeKind) return false;
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

function handleValuePanelAffordanceMouseDown(
  event: ReactMouseEvent<HTMLTableSectionElement>,
  bodyActionsRef: MutableRefObject<TableDataGridBodyActions | null>,
  resolveCellContext: (
    rowIndex: number,
    colIndex: number,
  ) => GridBodyCellInteractionContext | null,
): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (!target.closest(".db-data-table-cell-value-btn")) return false;
  const actions = bodyActionsRef.current;
  if (!actions?.handleOpenValuePanel) return false;
  const resolved = resolveCellFromTarget(target);
  if (!resolved) return false;
  const ctx = resolveCellContext(resolved.rowIndex, resolved.colIndex);
  if (!ctx || ctx.columnId === ROW_NUM_COL_ID || ctx.columnId === TRANSPOSE_FIELD_COL) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  actions.handleOpenValuePanel(ctx);
  return true;
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

      if (handleValuePanelAffordanceMouseDown(event, bodyActionsRef, resolveCellContext)) {
        return;
      }

      const resolved = resolveCellFromTarget(event.target);
      if (!resolved) {
        const tr = event.target instanceof Element ? event.target.closest("tr") : null;
        if (tr instanceof HTMLTableRowElement && tr.dataset.rowIndex != null) {
          if (isInRowResizeHandle(tr, event.clientX, event.clientY)) {
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
        if (isNearRowBottom(resolved.td, event.clientY)) {
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
      if (!ctx) return;
      const isRowSelector =
        ctx.columnId === ROW_NUM_COL_ID || ctx.columnId === TRANSPOSE_FIELD_COL;
      if (isRowSelector) {
        if (actions.handleRowBandDoubleClick) {
          event.preventDefault();
          event.stopPropagation();
          actions.handleRowBandDoubleClick(resolved.rowIndex);
        }
        return;
      }
      if (!ctx.canEdit) return;
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
      if (!ctx) return;
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

export type TableDataGridVirtualBodyProps = {
  scrollElementRef: RefObject<HTMLElement | null>;
  tableRows: Row<Record<string, unknown>>[];
  getRowHeight: (index: number) => number;
  /** 行高变化时触发 measure（传入 rowHeights 引用即可） */
  rowHeights: Record<number, number>;
  visibleCellCount: number;
  buildRowProps: (rowIndex: number) => Omit<GridBodyRowProps, "row"> | null;
  bodyActionsRef: MutableRefObject<TableDataGridBodyActions | null>;
  resolveCellContext: (
    rowIndex: number,
    colIndex: number,
  ) => GridBodyCellInteractionContext | null;
};

export type TableDataGridVirtualBodyHandle = {
  scrollToIndex: (
    index: number,
    options?: { align?: "start" | "center" | "end" | "auto"; behavior?: "auto" | "smooth" },
  ) => void;
};

/** 行虚拟化挂在 tbody 内，避免滚动时整表（表头/分页）跟着重渲 */
export const TableDataGridVirtualBody = forwardRef<
  TableDataGridVirtualBodyHandle,
  TableDataGridVirtualBodyProps
>(function TableDataGridVirtualBody(
  {
    scrollElementRef,
    tableRows,
    getRowHeight,
    rowHeights,
    visibleCellCount,
    buildRowProps,
    bodyActionsRef,
    resolveCellContext,
  },
  ref,
) {
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: getRowHeight,
    overscan: ROW_VIRTUALIZE_OVERSCAN,
    getItemKey: (index) => tableRows[index]?.id ?? String(index),
    useFlushSync: false,
  });

  useLayoutEffect(() => {
    rowVirtualizer.measure();
  }, [rowHeights, tableRows.length, rowVirtualizer]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (index, options) => {
        rowVirtualizer.scrollToIndex(index, options);
      },
    }),
    [rowVirtualizer],
  );

  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualPaddingTop = virtualRows.length > 0 ? virtualRows[0]!.start : 0;
  const virtualPaddingBottom =
    virtualRows.length > 0
      ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1]!.end
      : 0;

  const handleMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLTableSectionElement>) => {
      const actions = bodyActionsRef.current;
      if (!actions || event.button !== 0) return;

      if (handleValuePanelAffordanceMouseDown(event, bodyActionsRef, resolveCellContext)) {
        return;
      }

      const resolved = resolveCellFromTarget(event.target);
      if (!resolved) {
        const tr = event.target instanceof Element ? event.target.closest("tr") : null;
        if (tr instanceof HTMLTableRowElement && tr.dataset.rowIndex != null) {
          if (isInRowResizeHandle(tr, event.clientX, event.clientY)) {
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
        if (isNearRowBottom(resolved.td, event.clientY)) {
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
      if (!ctx) return;
      const isRowSelector =
        ctx.columnId === ROW_NUM_COL_ID || ctx.columnId === TRANSPOSE_FIELD_COL;
      if (isRowSelector) {
        if (actions.handleRowBandDoubleClick) {
          event.preventDefault();
          event.stopPropagation();
          actions.handleRowBandDoubleClick(resolved.rowIndex);
        }
        return;
      }
      if (!ctx.canEdit) return;
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
      if (!ctx) return;
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
      {virtualPaddingTop > 0 ? (
        <tr className="db-data-table-spacer-row" aria-hidden>
          <td colSpan={visibleCellCount} style={{ height: virtualPaddingTop }} />
        </tr>
      ) : null}
      {virtualRows.map((virtualRow) => {
        const tableRow = tableRows[virtualRow.index];
        const rowProps = buildRowProps(virtualRow.index);
        if (!tableRow || !rowProps) return null;
        return <GridBodyRow key={tableRow.id} row={tableRow} {...rowProps} />;
      })}
      {virtualPaddingBottom > 0 ? (
        <tr className="db-data-table-spacer-row" aria-hidden>
          <td colSpan={visibleCellCount} style={{ height: virtualPaddingBottom }} />
        </tr>
      ) : null}
    </tbody>
  );
});
