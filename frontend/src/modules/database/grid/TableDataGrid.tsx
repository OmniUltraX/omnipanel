import { memo } from "react";
import { flexRender } from "@tanstack/react-table";
import { Button } from "../../../components/ui/Button";
import { WarnAlert } from "../../../components/ui/overlay/WarnAlert";
import { TableDataGridFilterPopover } from "./TableDataGridOverlays";
import { TableDataGridCellOverlay } from "./TableDataGridCellOverlay";
import { TableColumnRelationDialog } from "./TableColumnRelationDialog";
import { TableCellPreviewSubWindow } from "./TableCellPreviewSubWindow";
import {
  ColumnFilterButton,
  ColumnRelationButton,
  ColumnRelationDisplayActions,
  ColumnSortIndicator,
  ColumnVisibilitySidebar,
  TableDataGridCellContextMenu,
} from "./TableDataGridChrome";
import { TableDataGridCanvasBody } from "./canvas/TableDataGridCanvasBody";
import {
  ROW_NUM_COL_ID,
  TRANSPOSE_FIELD_COL,
} from "./tableDataGridConstants";
import {
  formatColumnRelationLabel,
  buildRelationDisplayColumnLabel,
  isRelationDisplayColumn,
  relationSourceColumn,
} from "./tableColumnRelation";
import { buildColumnHeaderTooltip, formatColumnHeaderName } from "./tableDataGridFormat";
import { applyAllColumnWidthsDom, buildColumnCellStyle } from "./tableDataGridLayout";
import { isHeaderInColumnSelection } from "./tableDataGridSelection";
import { SqlNewQueryIcon } from "../sql/SqlNewQueryIcon";
import type { TableDataGridProps } from "./tableDataGridTypes";
import { useTableDataGridModel } from "./useTableDataGridModel";

export type {
  TableDataGridActiveCell,
  TableDataGridProps,
  TableDataGridActions,
  TableDataGridClipboardFormat,
} from "./tableDataGridTypes";

/**
 * 表数据网格组装壳：主 JSX（sidebar / thead / CanvasBody / chrome / overlays）。
 * 逻辑见 useTableDataGridModel 与显式 deps hooks。
 */
export const TableDataGrid = memo(function TableDataGrid(props: TableDataGridProps) {
  const model = useTableDataGridModel(props);
  if (!model) return null;
  const {
    allColumnsHidden,
    bodyActionsRef,
    buildCellContextMenuItems,
    canConfigureRelation,
    canCopyPreviewSql,
    canCreateTableQuery,
    canFilter,
    canOpenTableDesign,
    cancelCellOverlayEdit,
    canvasBodyRef,
    canvasPaintRowsRef,
    canvasSnapshotInput,
    cellEditorCollapsed,
    cellMenuOpenRef,
    cellOverlay,
    cellPreviewState,
    cellRange,
    chromePlacement,
    closeCellPreview,
    colResizeRef,
    colSidebarCollapsed,
    columnLayout,
    columnMeta,
    columnMetaMap,
    columnRelations,
    commitCellOverlayEdit,
    containerWidth,
    copySqlHint,
    dragColumnWidthsRef,
    dragRowHeightRef,
    enableTranspose,
    fillDelta,
    filter,
    filterAnchorRect,
    filterColumnNames,
    filterLockedField,
    filterOpen,
    footerExtra,
    gridContentWidth,
    handleCellOverlayEditChange,
    handleColumnBandSelect,
    handleColumnNavigate,
    handleColumnSortClick,
    handleCopyPreviewSql,
    handleDeleteSelectedRows,
    handleHeaderClick,
    handlePageChange,
    handleRelationConfirm,
    handleRelationDeleteConfirm,
    handleSelectAll,
    handleTransposeRowHeaderDoubleClick,
    hasSelectedRows,
    hiddenColumns,
    hideTotalRowCount,
    isPaging,
    isSidebarColumnVisible,
    lastColumnId,
    leafColumns,
    leafColumnsRef,
    loading,
    navigatedColumnId,
    onCellEditorCollapsedChange,
    onCreateTableQuery,
    onDeleteSelectedRows,
    onFilterChange,
    onOpenTableDesign,
    openFilterPopover,
    openRelationDialog,
    page,
    pendingDragRangeRef,
    previewSql,
    primarySort,
    relationDeleteSourceColumn,
    relationDialogColumn,
    relationTables,
    resolveBodyCellContext,
    resolveColumnWidth,
    selectedRowIndices,
    setColSidebarCollapsed,
    setFilterOpen,
    setHiddenColumns,
    setRelationDeleteSourceColumn,
    setRelationDialogColumn,
    setTransposed,
    showingFrom,
    showingTo,
    sidebarColumnItemClassName,
    sidebarColumnLabels,
    sidebarColumns,
    t,
    table,
    tableRows,
    toolbar,
    enableSort,
    totalPages,
    totalRows,
    totalTableWidth,
    transposed,
    wrapRef,
  } = model;

  return (
    <div className="db-data-table-panel">
    <div className="db-data-table-body">
      {!colSidebarCollapsed ? (
        <ColumnVisibilitySidebar
          columns={sidebarColumns}
          columnMetaMap={columnMetaMap}
          hiddenColumns={hiddenColumns}
          onChange={setHiddenColumns}
          activeColumn={navigatedColumnId}
          onColumnNavigate={handleColumnNavigate}
          columnLabels={sidebarColumnLabels}
          isColumnVisible={isSidebarColumnVisible}
          columnItemClassName={sidebarColumnItemClassName}
        />
      ) : null}
      <div className={`db-data-table-main${isPaging ? " db-data-table-main--paging" : ""}`}>
    {allColumnsHidden ? (
      <div className="db-data-table-all-hidden">
        {t("database.results.columnVisibilityAllHidden")}
      </div>
    ) : (
    <div
      ref={wrapRef}
      className={`db-data-table-wrap db-data-table-wrap--canvas${transposed ? " db-data-table-wrap--transposed" : ""}${loading ? " db-data-table-wrap--loading" : ""}${isPaging ? " db-data-table-wrap--paging" : ""}`}
    >
      <table
        className="db-data-table db-data-table--canvas-chrome"
        style={
          containerWidth > 0
            ? {
                width: gridContentWidth,
                minWidth: gridContentWidth,
                maxWidth: gridContentWidth,
              }
            : {
                width: fillDelta > 0 ? "100%" : totalTableWidth,
                minWidth: "100%",
              }
        }
      >
        <colgroup>
          {columnLayout.enabled ? (
            <>
              {columnLayout.pinnedIndices.map((colIndex) => {
                const column = leafColumns[colIndex];
                if (!column) return null;
                return (
                  <col
                    key={column.id}
                    data-col-id={column.id}
                    style={{ width: resolveColumnWidth(column.id, column.getSize()) }}
                  />
                );
              })}
              {columnLayout.paddingLeft > 0 ? (
                <col key="__col_pad_l" style={{ width: columnLayout.paddingLeft }} />
              ) : null}
              {columnLayout.virtualIndices.map((colIndex) => {
                const column = leafColumns[colIndex];
                if (!column) return null;
                return (
                  <col
                    key={column.id}
                    data-col-id={column.id}
                    style={{ width: resolveColumnWidth(column.id, column.getSize()) }}
                  />
                );
              })}
              {columnLayout.paddingRight > 0 ? (
                <col key="__col_pad_r" style={{ width: columnLayout.paddingRight }} />
              ) : null}
            </>
          ) : (
            leafColumns.map((column) => (
              <col
                key={column.id}
                data-col-id={column.id}
                style={{ width: resolveColumnWidth(column.id, column.getSize()) }}
              />
            ))
          )}
        </colgroup>
        <thead>
                {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {(columnLayout.enabled
                ? [
                    ...columnLayout.pinnedIndices.map((i) => ({ kind: "col" as const, i })),
                    ...(columnLayout.paddingLeft > 0
                      ? [{ kind: "pad" as const, key: "l", width: columnLayout.paddingLeft }]
                      : []),
                    ...columnLayout.virtualIndices.map((i) => ({ kind: "col" as const, i })),
                    ...(columnLayout.paddingRight > 0
                      ? [{ kind: "pad" as const, key: "r", width: columnLayout.paddingRight }]
                      : []),
                  ]
                : headerGroup.headers.map((_, i) => ({ kind: "col" as const, i }))
              ).map((item) => {
                if (item.kind === "pad") {
                  return (
                    <th
                      key={`__th_pad_${item.key}`}
                      aria-hidden
                      style={{
                        width: item.width,
                        minWidth: item.width,
                        padding: 0,
                        border: "none",
                      }}
                    />
                  );
                }
                const headerColIdx = item.i;
                const header = headerGroup.headers[headerColIdx];
                if (!header) return null;
                const baseSize = header.getSize();
                const colId = header.column.id;
                const isFieldCol = transposed && colId === TRANSPOSE_FIELD_COL;
                const isRelationDisplayCol = !transposed && isRelationDisplayColumn(colId);
                const isSelectAllHeader = colId === ROW_NUM_COL_ID || isFieldCol;
                const canSort =
                  enableSort && !transposed && colId !== ROW_NUM_COL_ID;
                const sortActive = canSort && primarySort?.column === colId;
                const sortDirection = sortActive ? primarySort!.direction : null;
                const sortClass = sortActive
                  ? sortDirection === "asc"
                    ? " db-data-table-th--sort-asc"
                    : " db-data-table-th--sort-desc"
                  : "";
                const filterClass =
                  canFilter && !transposed && colId !== ROW_NUM_COL_ID && filterColumnNames.has(colId)
                    ? " db-data-table-th--filtered"
                    : "";
                const relationSourceCol = isRelationDisplayCol ? relationSourceColumn(colId) : colId;
                const relation =
                  !transposed && colId !== ROW_NUM_COL_ID && !isFieldCol && !isRelationDisplayCol
                    ? columnRelations[colId]
                    : undefined;
                const relatedTableForRelation = relation
                  ? relationTables?.find((table) => table.name === relation.tableName)
                  : undefined;
                const relationActive = Boolean(relation);
                const relationLabel = formatColumnRelationLabel(relation, relatedTableForRelation);
                const thSelected = isHeaderInColumnSelection(headerColIdx, cellRange, tableRows.length);
                const colMeta =
                  !transposed && !isFieldCol && colId !== ROW_NUM_COL_ID && !isRelationDisplayCol
                    ? columnMetaMap?.[colId]
                    : undefined;
                const relationDisplayHeader =
                  isRelationDisplayCol && relationSourceCol
                    ? (() => {
                        const sourceRelation = columnRelations[relationSourceCol];
                        if (!sourceRelation) return colId;
                        const relatedTable = relationTables?.find(
                          (table) => table.name === sourceRelation.tableName,
                        );
                        return buildRelationDisplayColumnLabel(sourceRelation, relatedTable);
                      })()
                    : null;
                const headerTitle = isSelectAllHeader
                  ? t("database.results.selectAll")
                  : colMeta
                    ? buildColumnHeaderTooltip(colMeta, colId, t)
                    : relationDisplayHeader
                      ? formatColumnHeaderName(relationDisplayHeader)
                      : colId !== ROW_NUM_COL_ID
                        ? formatColumnHeaderName(colId)
                        : undefined;
                return (
                <th
                  key={header.id}
                  data-col-id={colId}
                  data-col-index={headerColIdx}
                  style={buildColumnCellStyle(colId, baseSize, lastColumnId, fillDelta)}
                  className={`${table.getState().columnSizingInfo?.isResizingColumn === colId ? "db-data-table-th-resizing" : ""}${canSort ? " db-data-table-th--sortable" : ""}${isSelectAllHeader || colId !== ROW_NUM_COL_ID ? " db-data-table-th--selectable" : ""}${isSelectAllHeader ? " db-data-table-th--select-all" : ""}${thSelected ? " db-data-table-th--selected" : ""}${sortClass}${filterClass}${relationActive ? " db-data-table-th--relation" : ""}${isRelationDisplayCol ? " db-data-table-th--relation-display" : ""}`}
                  onClick={isSelectAllHeader ? handleSelectAll : undefined}
                  onMouseDown={
                    isSelectAllHeader
                      ? undefined
                      : (event) => {
                          handleColumnBandSelect(colId, event);
                        }
                  }
                  onDoubleClick={(e) => handleTransposeRowHeaderDoubleClick(colId, e)}
                  title={headerTitle}
                >
                  {header.isPlaceholder ? null : (
                    <span className="db-data-table-th-inner">
                      <span className="db-data-table-th-label">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </span>
                      {(canSort || (canFilter && colId !== ROW_NUM_COL_ID && !transposed && !isRelationDisplayCol)) && (
                        <span className="db-data-table-th-actions">
                          {canSort && (
                            <ColumnSortIndicator
                              active={sortActive}
                              direction={sortActive ? sortDirection : null}
                              title={t("database.results.sortHint")}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleHeaderClick(colId);
                              }}
                            />
                          )}
                          {canFilter &&
                            colId !== ROW_NUM_COL_ID &&
                            !transposed &&
                            !isRelationDisplayCol && (
                            <ColumnFilterButton
                              columnName={colId}
                              active={filterColumnNames.has(colId)}
                              onOpen={openFilterPopover}
                            />
                          )}
                        </span>
                      )}
                      {canConfigureRelation &&
                      colId !== ROW_NUM_COL_ID &&
                      !transposed &&
                      !isFieldCol &&
                      !isRelationDisplayCol ? (
                        <span className="db-data-table-th-relation">
                          <ColumnRelationButton
                            columnName={colId}
                            active={relationActive}
                            relationLabel={relationLabel}
                            onOpen={openRelationDialog}
                          />
                        </span>
                      ) : null}
                      {isRelationDisplayCol && relationSourceCol ? (
                        <span className="db-data-table-th-relation-display-actions-wrap">
                          {canSort && (
                            <ColumnSortIndicator
                              active={sortActive}
                              direction={sortActive ? sortDirection : null}
                              title={t("database.results.sortHint")}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleHeaderClick(colId);
                              }}
                            />
                          )}
                          {canFilter && (
                            <ColumnFilterButton
                              columnName={colId}
                              active={filterColumnNames.has(colId)}
                              onOpen={openFilterPopover}
                            />
                          )}
                          <ColumnRelationDisplayActions
                            onEdit={() => openRelationDialog(relationSourceCol)}
                            onDelete={() => setRelationDeleteSourceColumn(relationSourceCol)}
                          />
                        </span>
                      ) : null}
                    </span>
                  )}
                  {header.column.getCanResize() && (
                    <div
                      className="db-col-resize-handle"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        // 冻结当前全列渲染宽（含末列 fillDelta），拖动中只改目标列，table 宽=列宽之和
                        const widthsById: Record<string, number> = {};
                        for (const column of leafColumnsRef.current) {
                          widthsById[column.id] = resolveColumnWidth(
                            column.id,
                            column.getSize(),
                          );
                        }
                        const startWidth = widthsById[colId] ?? header.getSize();
                        widthsById[colId] = startWidth;
                        colResizeRef.current = {
                          columnId: colId,
                          startX: e.clientX,
                          startWidth,
                          lastWidth: startWidth,
                          widthsById,
                        };
                        dragColumnWidthsRef.current = { ...widthsById };
                        const wrap = wrapRef.current;
                        wrap?.classList.add("db-data-table-wrap--col-resizing");
                        wrap
                          ?.querySelector(`th[data-col-id="${CSS.escape(colId)}"]`)
                          ?.classList.add("db-data-table-th-resizing");
                        if (wrap) {
                          applyAllColumnWidthsDom(
                            wrap,
                            widthsById,
                            leafColumnsRef.current.map((column) => column.id),
                          );
                        }
                      }}
                      onDoubleClick={() => header.column.resetSize()}
                      title="Drag to resize"
                    />
                  )}
                </th>
              );
            })}
            </tr>
          ))}
        </thead>
      </table>
      <TableDataGridCanvasBody
        ref={canvasBodyRef}
        scrollElementRef={wrapRef}
        snapshotInput={canvasSnapshotInput}
        tableRowsRef={canvasPaintRowsRef}
        dragRangeRef={pendingDragRangeRef}
        dragRowHeightRef={dragRowHeightRef}
        dragColumnWidthsRef={dragColumnWidthsRef}
        bodyActionsRef={bodyActionsRef}
        resolveCellContext={resolveBodyCellContext}
        onFieldSortClick={handleColumnSortClick}
        onFieldFilterOpen={openFilterPopover}
      />
      <TableDataGridCellOverlay
        overlay={cellOverlay}
        onEditChange={handleCellOverlayEditChange}
        onEditCommit={commitCellOverlayEdit}
        onEditCancel={cancelCellOverlayEdit}
      />
    </div>
    )}
    {isPaging && !allColumnsHidden ? (
      <div
        className="db-data-table-paging-overlay"
        aria-busy="true"
        aria-live="polite"
      >
        <div className="db-data-table-paging-overlay__inner">
          <span className="db-data-table-paging-overlay__spinner" aria-hidden />
          <span className="db-data-table-paging-overlay__text">{t("common.loading")}</span>
        </div>
      </div>
    ) : null}
    {!allColumnsHidden && (
      <TableDataGridCellContextMenu
        menuOpenRef={cellMenuOpenRef}
        buildItems={buildCellContextMenuItems}
      />
    )}
    </div>
    </div>
    {chromePlacement === "bottom" ? (
    <div className="db-pagination">
      <Button
        variant={!colSidebarCollapsed ? "default" : "ghost"}
        size="sm"
        className="db-col-sidebar-footer-toggle"
        title={
          colSidebarCollapsed
            ? t("database.results.columnVisibilityExpand")
            : t("database.results.columnVisibilityCollapse")
        }
        aria-label={
          colSidebarCollapsed
            ? t("database.results.columnVisibilityExpand")
            : t("database.results.columnVisibilityCollapse")
        }
        aria-expanded={!colSidebarCollapsed}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setColSidebarCollapsed((prev) => !prev)}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          width="14"
          height="14"
          aria-hidden
          className={colSidebarCollapsed ? undefined : "db-col-sidebar-footer-toggle-icon--expanded"}
        >
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
          <path d="M5 2.5v11M9.5 2.5v11" />
        </svg>
      </Button>
      <div className="db-pagination-left">
        {onDeleteSelectedRows ? (
          <div className="db-delete-selected-rows-wrap">
            <Button
              variant="ghost"
              size="icon-sm"
              className="db-delete-selected-rows"
              disabled={!hasSelectedRows || loading}
              title={
                hasSelectedRows
                  ? t("database.results.deleteSelectedRows", { count: selectedRowIndices.length })
                  : t("database.results.deleteSelectedRowsDisabled")
              }
              aria-label={
                hasSelectedRows
                  ? t("database.results.deleteSelectedRows", { count: selectedRowIndices.length })
                  : t("database.results.deleteSelectedRowsDisabled")
              }
              onClick={handleDeleteSelectedRows}
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                width="14"
                height="14"
                aria-hidden
              >
                <path d="M3 4.5h10M6 4.5V3.25A1.25 1.25 0 0 1 7.25 2h1.5A1.25 1.25 0 0 1 10 3.25V4.5M6.25 7v4.5M9.75 7v4.5M4.25 4.5l.5 8.25A1.25 1.25 0 0 0 5.75 14h4.5a1.25 1.25 0 0 0 1.25-1.25l.5-8.25" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Button>
            {hasSelectedRows ? (
              <span className="db-delete-selected-rows-badge">{selectedRowIndices.length}</span>
            ) : null}
          </div>
        ) : null}
        {toolbar ? <div className="db-pagination-toolbar">{toolbar}</div> : null}
        <div className="db-pagination-info">
        {enableTranspose && (
          <Button
            variant={transposed ? "default" : "ghost"}
            size="sm"
            className="db-transpose-toggle"
            title={transposed ? t("database.results.transposeOff") : t("database.results.transposeOn")}
            aria-label={transposed ? t("database.results.transposeOff") : t("database.results.transposeOn")}
            aria-pressed={transposed}
            onClick={() => setTransposed((prev) => !prev)}
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              width="14"
              height="14"
              aria-hidden
            >
              <rect x="1.5" y="1.5" width="5" height="5" rx="0.75" />
              <rect x="9.5" y="9.5" width="5" height="5" rx="0.75" />
              <path d="M6.5 4h3M4 6.5v3M12 9.5v3M9.5 12h3" strokeLinecap="round" />
            </svg>
          </Button>
        )}
        {canCopyPreviewSql && (
          <Button
            variant={copySqlHint ? "default" : "ghost"}
            size="sm"
            className="db-copy-preview-sql"
            type="button"
            title={copySqlHint ? t("database.results.copyPreviewSqlDone") : previewSql}
            aria-label={t("database.results.copyPreviewSql")}
            onClick={() => void handleCopyPreviewSql()}
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              width="14"
              height="14"
              aria-hidden
            >
              <rect x="5" y="5" width="8" height="9" rx="1" />
              <path d="M4 11V3.5A1.5 1.5 0 0 1 5.5 2H11" strokeLinecap="round" />
            </svg>
          </Button>
        )}
        {loading && !isPaging ? (
          <span>{t("common.loading")}</span>
        ) : totalRows > 0 ? (
          <span className={isPaging ? "db-pagination-info--paging" : undefined}>
            {hideTotalRowCount
              ? `${showingFrom.toLocaleString()}–${showingTo.toLocaleString()}`
              : `${showingFrom.toLocaleString()}–${showingTo.toLocaleString()} of ${totalRows.toLocaleString()} rows`}
            {isPaging ? ` · ${t("common.loading")}` : ""}
          </span>
        ) : (
          <span>0 rows</span>
        )}
        </div>
      </div>
      {footerExtra ? <div className="db-pagination-extra">{footerExtra}</div> : null}
      {onCellEditorCollapsedChange ? (
        <Button
          variant={!cellEditorCollapsed ? "default" : "ghost"}
          size="sm"
          className="db-cell-editor-footer-toggle"
          title={
            cellEditorCollapsed
              ? t("database.results.cellEditorExpand")
              : t("database.results.cellEditorCollapse")
          }
          aria-label={
            cellEditorCollapsed
              ? t("database.results.cellEditorExpand")
              : t("database.results.cellEditorCollapse")
          }
          aria-expanded={!cellEditorCollapsed}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onCellEditorCollapsedChange}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            width="14"
            height="14"
            aria-hidden
            className={cellEditorCollapsed ? undefined : "db-cell-editor-footer-toggle-icon--expanded"}
          >
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
            <path d="M2 9h12" />
            <path
              d={cellEditorCollapsed ? "M8 10.5V6M6 8.5l2-2 2 2" : "M8 7.5v4.5M6 9.5l2 2 2-2"}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Button>
      ) : null}
      {(onOpenTableDesign || onCreateTableQuery) ? (
        <div className="db-pagination-quick-actions">
          {onOpenTableDesign ? (
            <Button
              variant="icon"
              size="icon-sm"
              disabled={!canOpenTableDesign || loading}
              title={t("database.contextMenu.designTable")}
              aria-label={t("database.contextMenu.designTable")}
              onClick={onOpenTableDesign}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="14" height="14" aria-hidden>
                <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
                <path d="M5 8h6M8 5v6" />
              </svg>
            </Button>
          ) : null}
          {onCreateTableQuery ? (
            <Button
              variant="icon"
              size="icon-sm"
              disabled={!canCreateTableQuery || loading}
              title={t("database.workspace.newQuery")}
              aria-label={t("database.workspace.newQuery")}
              onClick={onCreateTableQuery}
            >
              <SqlNewQueryIcon size={14} />
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="db-pagination-controls">
        <Button
          variant="ghost"
          size="sm"
          disabled={page <= 0 || loading}
          onClick={() => handlePageChange(0)}
          title={t("database.results.paginationFirst")}
          aria-label={t("database.results.paginationFirst")}
        >
          «
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={page <= 0 || loading}
          onClick={() => handlePageChange(page - 1)}
          title={t("database.results.paginationPrev")}
          aria-label={t("database.results.paginationPrev")}
        >
          ‹
        </Button>
        {totalPages > 0 && (
          <span className="db-pagination-pages">
            {page + 1} / {totalPages}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={page >= totalPages - 1 || loading}
          onClick={() => handlePageChange(page + 1)}
          title={t("database.results.paginationNext")}
          aria-label={t("database.results.paginationNext")}
        >
          ›
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={page >= totalPages - 1 || loading}
          onClick={() => handlePageChange(totalPages - 1)}
          title={t("database.results.paginationLast")}
          aria-label={t("database.results.paginationLast")}
        >
          »
        </Button>
      </div>
    </div>
    ) : null}
    {filterOpen && filterAnchorRect && filterLockedField && columnMeta && onFilterChange && (
      <TableDataGridFilterPopover
        anchorRect={filterAnchorRect}
        columnMeta={columnMeta}
        columnRelations={columnRelations}
        relationTables={relationTables}
        initialQuery={filter}
        lockedField={filterLockedField}
        onApply={onFilterChange}
        onClose={() => setFilterOpen(false)}
      />
    )}
    {relationDialogColumn && relationTables && relationTables.length > 0 ? (
      <TableColumnRelationDialog
        open
        onClose={() => setRelationDialogColumn(null)}
        columnName={relationDialogColumn}
        tables={relationTables}
        initial={columnRelations[relationDialogColumn] ?? null}
        onConfirm={handleRelationConfirm}
      />
    ) : null}
    <WarnAlert
      open={relationDeleteSourceColumn != null}
      title={t("database.results.relationDeleteTitle")}
      message={t("database.results.relationDeleteMessage", {
        column: relationDeleteSourceColumn ?? "",
      })}
      confirmLabel={t("common.delete")}
      cancelLabel={t("common.cancel")}
      onConfirm={handleRelationDeleteConfirm}
      onClose={() => setRelationDeleteSourceColumn(null)}
    />
    <TableCellPreviewSubWindow
      open={cellPreviewState != null}
      preview={cellPreviewState}
      onClose={closeCellPreview}
    />
    </div>
  );
});
