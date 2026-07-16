import { useMemo, memo, useCallback, useRef, useState, useEffect, useLayoutEffect } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  useDbWorkspace,
  useDbTabWorkspaceSliceOrMirror,
} from "../../../contexts/DbWorkspaceContext";
import type { TablePreviewWorkspaceTab } from "./workspaceTabs";
import { DockHandle, DockLayout, DockPanel } from "../../../components/dock";
import {
  TableDataGrid,
  type TableDataGridActions,
  type TableDataGridActiveCell,
} from "../grid/TableDataGrid";
import { selectionTargetKey, selectionTargetsKey } from "../grid/tableDataGridSelection";
import { type CellEditorPanelHandle } from "../cell_editor";
import { detectCellEditorKind, parseCellValue } from "../cell_editor/types";
import { useI18n } from "../../../i18n";
import {
  NEW_ROW_KEY_PREFIX,
  PENDING_INSERT_ROW_KEY,
  DELETED_ROW_KEY_PREFIX,
  isDeletedRowDirtyKey,
  resolvePreviewRowKey,
  type SortState,
  type TableColumnRelationConfig,
} from "./dbWorkspaceState";
import type { RuleGroupType } from "react-querybuilder";
import { connectionHasTableSchemaChildren } from "../api";
import { supportsTableDesign } from "../tableDesigner/resolveTableDesignerDriver";
import { useTreeChartDatabaseSchema } from "../treeChart/useTreeChartDatabaseSchema";
import {
  useSettingsStore,
  type DatabaseTableDetailPosition,
} from "../../../stores/settingsStore";
import {
  TableDetailPanel,
  type TableDetailTab,
} from "../tableDetail/TableDetailPanel";
import { TablePreviewTopBar } from "../tableDetail/TablePreviewTopBar";
import { TablePreviewQueryBar } from "../tableDetail/TablePreviewQueryBar";
import {
  buildTablePreviewSql,
  buildTablePreviewSqlWithRelations,
} from "../grid/tablePreviewFilter";
import {
  isRelationDisplayColumn,
  relationSourceColumn,
} from "../grid/tableColumnRelation";
import { showToast } from "../../../stores/toastStore";

interface DbTablePreviewSurfaceProps {
  tab: TablePreviewWorkspaceTab;
}

function selectionTargetCount(key: string | undefined): number {
  if (!key) return 0;
  return key.split("|").filter(Boolean).length;
}

export const DbTablePreviewSurface = memo(function DbTablePreviewSurface({
  tab,
}: DbTablePreviewSurfaceProps) {
  const { t } = useI18n();
  const ws = useDbWorkspace();
  const cellEditorRef = useRef<CellEditorPanelHandle>(null);
  const detailPanelRef = useRef<PanelImperativeHandle | null>(null);
  const gridActionsRef = useRef<TableDataGridActions | null>(null);
  const [detailCollapsed, setDetailCollapsed] = useState(true);
  const [colSidebarCollapsed, setColSidebarCollapsed] = useState(false);
  const [selectedRowCount, setSelectedRowCount] = useState(0);
  const [detailTab, setDetailTab] = useState<TableDetailTab>("record");
  const [activeCell, setActiveCell] = useState<TableDataGridActiveCell | null>(null);
  const [selectedCells, setSelectedCells] = useState<TableDataGridActiveCell[]>([]);
  const [copySqlHint, setCopySqlHint] = useState(false);
  const copySqlHintTimerRef = useRef<number | null>(null);

  const detailPosition = useSettingsStore((s) => s.databaseTableDetailPosition);
  const setDatabaseSettings = useSettingsStore((s) => s.setDatabaseSettings);

  const {
    tablePreview: preview,
    tableColumnMeta: colMeta,
    tabDirtyRows: tabDirtyRowsForTab,
    isCommitting,
  } = useDbTabWorkspaceSliceOrMirror(tab.id);

  const canRefresh = tab.connId && tab.dbName && tab.tableName;

  const statusBarInfo = useMemo(() => {
    if (!tab.dbName || !tab.tableName) return null;
    const tableLabel = `${tab.dbName}.${tab.tableName}`;
    const rowCount = preview?.totalRows;
    return (
      <>
        <span className="statusbar-item statusbar-item--truncate" title={tableLabel}>
          {tableLabel}
        </span>
        {rowCount != null ? (
          <span className="statusbar-item">
            {rowCount.toLocaleString()} {t("common.rows")}
          </span>
        ) : null}
      </>
    );
  }, [preview?.totalRows, tab.dbName, tab.tableName, t]);

  const previewConnection = tab.connId ? ws.resolveConnection(tab.connId) : null;
  const databaseSchema = useTreeChartDatabaseSchema(previewConnection, tab.dbName ?? "");
  const relationTables = useMemo(
    () => databaseSchema?.tables.filter((table) => table.kind !== "view") ?? [],
    [databaseSchema],
  );
  const canInsertRow = !!(
    canRefresh &&
    preview?.data &&
    colMeta?.length &&
    previewConnection &&
    connectionHasTableSchemaChildren(previewConnection)
  );

  const canDeleteRow = !!(canInsertRow && previewConnection.db_type !== "redis");

  const pkCols = useMemo(() => colMeta?.filter((col) => col.isPk) ?? [], [colMeta]);

  const deletedRowKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const key of Object.keys(tabDirtyRowsForTab)) {
      if (isDeletedRowDirtyKey(key)) {
        keys.add(key.slice(DELETED_ROW_KEY_PREFIX.length));
      }
    }
    return keys;
  }, [tabDirtyRowsForTab]);

  const previewDisplayRows = useMemo(() => {
    if (!preview?.data || !colMeta) return preview?.data?.rows ?? [];
    const dirty = tabDirtyRowsForTab;
    const pendingRows = Object.entries(dirty)
      .filter(([key]) => key.startsWith(NEW_ROW_KEY_PREFIX))
      .map(([key, changes]) => {
        const row: Record<string, unknown> = { [PENDING_INSERT_ROW_KEY]: key };
        for (const column of colMeta) {
          row[column.name] = changes[column.name] ?? null;
        }
        return row;
      });
    const existingRows = preview.data.rows.filter((row) => {
      const rowKey = resolvePreviewRowKey(row, pkCols);
      return !deletedRowKeys.has(rowKey);
    });
    return [...existingRows, ...pendingRows];
  }, [preview?.data, colMeta, tabDirtyRowsForTab, pkCols, deletedRowKeys]);

  const previewColumns = useMemo(() => {
    const fromData = preview?.data?.columns ?? [];
    if (fromData.length > 0) {
      return fromData;
    }
    return colMeta?.map((col) => col.name) ?? [];
  }, [preview?.data?.columns, colMeta]);

  const previewDirtyRowKeys = useMemo(
    () => new Set(Object.keys(tabDirtyRowsForTab)),
    [tabDirtyRowsForTab],
  );
  const previewCellOverrides = tabDirtyRowsForTab;

  const canExport = Boolean(preview?.data && previewConnection);

  const activeCellKey = useMemo(() => {
    if (activeCell) {
      const rowKey = resolvePreviewRowKey(activeCell.row, pkCols);
      return `${rowKey}:${activeCell.column}`;
    }
    if (selectedCells.length > 1) {
      return `multi:${selectedCells.length}`;
    }
    return null;
  }, [activeCell, pkCols, selectedCells.length]);

  const editorColumnName = activeCell?.column ?? selectedCells[0]?.column ?? null;
  const editorSelectionCount = selectedCells.length;

  const activeColumnMeta = useMemo(
    () => (editorColumnName ? colMeta?.find((col) => col.name === editorColumnName) : undefined),
    [editorColumnName, colMeta],
  );

  const activeCellValue = useMemo(() => {
    if (!activeCell) return undefined;
    const rowKey = resolvePreviewRowKey(activeCell.row, pkCols);
    const override = rowKey ? previewCellOverrides[rowKey]?.[activeCell.column] : undefined;
    return override !== undefined ? override : activeCell.row[activeCell.column];
  }, [activeCell, pkCols, previewCellOverrides]);

  const activeRow = useMemo(() => {
    const cell = activeCell ?? selectedCells[0] ?? null;
    return cell?.row ?? null;
  }, [activeCell, selectedCells]);

  const activeRowOverrides = useMemo(() => {
    if (!activeRow) return undefined;
    const rowKey = resolvePreviewRowKey(activeRow, pkCols);
    return rowKey ? previewCellOverrides[rowKey] : undefined;
  }, [activeRow, pkCols, previewCellOverrides]);

  const activeCellRef = useRef<TableDataGridActiveCell | null>(null);
  const selectedCellsKeyRef = useRef<string | undefined>(undefined);

  const handleActiveCellChange = useCallback((cell: TableDataGridActiveCell | null) => {
    const prevKey = selectionTargetKey(activeCellRef.current);
    const nextKey = selectionTargetKey(cell);
    if (prevKey === nextKey) return;
    if (prevKey != null && nextKey != null) {
      cellEditorRef.current?.commitIfDirty();
    }
    activeCellRef.current = cell;
    setActiveCell(cell);
  }, []);

  const handleSelectedCellsChange = useCallback((cells: TableDataGridActiveCell[]) => {
    const nextKey = selectionTargetsKey(cells);
    if (nextKey === selectedCellsKeyRef.current) return;
    const prevKey = selectedCellsKeyRef.current;
    const prevCount = selectionTargetCount(prevKey);
    const nextCount = selectionTargetCount(nextKey);

    if (nextKey === "") {
      cellEditorRef.current?.commitIfDirty();
    } else if (prevCount > 1 && nextCount < prevCount) {
      cellEditorRef.current?.commitIfDirty();
    }

    selectedCellsKeyRef.current = nextKey;
    setSelectedCells(cells);
  }, []);

  const handlePreviewCellCommit = useCallback(
    (
      cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> },
      value: unknown,
    ) => {
      ws.handleCellCommit(tab.id, cellInfo, value);
    },
    [ws.handleCellCommit, tab.id],
  );
  const handlePreviewCellSetNull = useCallback(
    (cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> }) => {
      ws.handleCellSetNull(tab.id, cellInfo);
    },
    [ws.handleCellSetNull, tab.id],
  );
  const handlePreviewCellApply = useCallback(
    ({ rawText, parsed }: { rawText: string; parsed: unknown }) => {
      const multi = selectedCells.length > 1;
      if (multi && detailCollapsed) return;

      const targets = multi
        ? selectedCells
        : activeCell
          ? [activeCell]
          : selectedCells.length === 1
            ? selectedCells
            : [];
      if (targets.length === 0) return;

      for (const cell of targets) {
        const columnMeta = colMeta?.find((col) => col.name === cell.column);
        const kind = detectCellEditorKind(columnMeta?.type ?? "text");
        const value = targets.length === 1 ? parsed : parseCellValue(kind, rawText);
        ws.handleCellCommit(tab.id, cell, value);
      }
    },
    [activeCell, detailCollapsed, colMeta, selectedCells, ws.handleCellCommit, tab.id],
  );
  const handlePreviewCellSetNullActive = useCallback(() => {
    if (!activeCell) return;
    ws.handleCellSetNull(tab.id, activeCell);
  }, [activeCell, ws.handleCellSetNull, tab.id]);

  const handleRecordFieldApply = useCallback(
    (column: string, payload: { rawText: string; parsed: unknown }) => {
      if (!activeRow) return;
      ws.handleCellCommit(
        tab.id,
        { rowIndex: 0, column, row: activeRow },
        payload.parsed,
      );
    },
    [activeRow, ws.handleCellCommit, tab.id],
  );

  const handleRecordFieldSetNull = useCallback(
    (column: string) => {
      if (!activeRow) return;
      ws.handleCellSetNull(tab.id, { rowIndex: 0, column, row: activeRow });
    },
    [activeRow, ws.handleCellSetNull, tab.id],
  );

  const handlePreviewRowPaste = useCallback(
    (payload: { values: Record<string, unknown> }) => {
      ws.handleRowPaste(tab.id, payload);
    },
    [ws.handleRowPaste, tab.id],
  );
  const handlePreviewRowsDelete = useCallback(
    (rows: Array<{ rowIndex: number; row: Record<string, unknown> }>) => {
      ws.handleRowsDelete(tab.id, rows);
    },
    [ws.handleRowsDelete, tab.id],
  );
  const handlePreviewPageChange = useCallback(
    (page: number) => {
      ws.requestTabAction({ kind: "page", tabId: tab.id, page });
    },
    [ws.requestTabAction, tab.id],
  );
  const handlePreviewSortChange = useCallback(
    (sort: SortState | null) => {
      ws.requestTabAction({ kind: "sort", tabId: tab.id, sort });
    },
    [ws.requestTabAction, tab.id],
  );
  const handlePreviewFilterChange = useCallback(
    (nextFilter: RuleGroupType | null) => {
      ws.requestTabAction({ kind: "filter", tabId: tab.id, filter: nextFilter });
    },
    [ws.requestTabAction, tab.id],
  );
  const handleHiddenColumnsChange = useCallback(
    (hiddenColumns: string[]) => {
      ws.setTableGridView(tab.id, { hiddenColumns });
    },
    [ws.setTableGridView, tab.id],
  );
  const handleTransposedChange = useCallback(
    (transposed: boolean) => {
      ws.setTableGridView(tab.id, { transposed });
    },
    [ws.setTableGridView, tab.id],
  );
  const handleColumnRelationsChange = useCallback(
    (columnRelations: Record<string, TableColumnRelationConfig>) => {
      ws.setTableGridView(tab.id, { columnRelations });
    },
    [ws.setTableGridView, tab.id],
  );

  const handleDetailCollapsedChange = useCallback(() => {
    const handle = detailPanelRef.current;
    if (!handle) {
      setDetailCollapsed((prev) => !prev);
      return;
    }
    if (handle.isCollapsed()) {
      handle.expand();
      setDetailCollapsed(false);
    } else {
      cellEditorRef.current?.commitIfDirty();
      handle.collapse();
      setDetailCollapsed(true);
    }
  }, []);

  const handleCellEditorFocusRequest = useCallback(() => {
    setDetailTab("value");
    if (detailCollapsed) {
      detailPanelRef.current?.expand();
      setDetailCollapsed(false);
    }
    cellEditorRef.current?.focusEditor();
  }, [detailCollapsed]);

  const handleDetailPanelResize = useCallback(() => {
    const collapsed = detailPanelRef.current?.isCollapsed() ?? false;
    setDetailCollapsed(collapsed);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(".db-cell-preview-subwindow.subwindow-panel")) {
        return;
      }

      const grid = gridActionsRef.current;
      if (grid?.hasInlineEdit()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        grid.cancelInlineEdit();
        return;
      }

      if (!detailCollapsed) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cellEditorRef.current?.commitIfDirty();
        const handle = detailPanelRef.current;
        if (handle && !handle.isCollapsed()) {
          handle.collapse();
        }
        setDetailCollapsed(true);
        return;
      }

      if (grid?.hasSelection()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        grid.clearSelection();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [detailCollapsed, gridActionsRef]);

  const handlePositionChange = useCallback(
    (position: DatabaseTableDetailPosition) => {
      setDatabaseSettings({ databaseTableDetailPosition: position });
    },
    [setDatabaseSettings],
  );

  const handleCreateTableQuery = useCallback(() => {
    if (!previewConnection || !canRefresh) {
      return;
    }
    ws.openTableQuery({
      connId: tab.connId,
      dbName: tab.dbName,
      tableName: tab.tableName,
      connection: previewConnection,
    });
  }, [canRefresh, previewConnection, tab.connId, tab.dbName, tab.tableName, ws]);

  const handleOpenTableDesign = useCallback(() => {
    if (!previewConnection || !canRefresh) {
      return;
    }
    ws.openTableDesigner({
      connId: tab.connId,
      dbName: tab.dbName,
      tableName: tab.tableName,
      connection: previewConnection,
    });
  }, [canRefresh, previewConnection, tab.connId, tab.dbName, tab.tableName, ws]);

  const canDesignTable = Boolean(previewConnection && supportsTableDesign(previewConnection));

  const showPreviewGrid = Boolean(preview?.data && canRefresh && !preview.error);

  // 详情面板默认收起（切换右/底布局 remount 后同样收起）
  useLayoutEffect(() => {
    if (!showPreviewGrid) return;
    detailPanelRef.current?.collapse();
    setDetailCollapsed(true);
  }, [detailPosition, showPreviewGrid]);

  const previewSql = useMemo(() => {
    if (!previewConnection || !tab.tableName || !preview) return "";
    const dbType = previewConnection.db_type;
    const visible = previewColumns.filter(
      (column) => !isRelationDisplayColumn(column) || preview.columnRelations[relationSourceColumn(column) ?? ""],
    );
    const hasRelation = visible.some((column) => isRelationDisplayColumn(column));
    if (hasRelation) {
      return buildTablePreviewSqlWithRelations({
        dbType,
        tableName: tab.tableName,
        filter: preview.filter,
        sort: preview.sort,
        page: preview.page,
        pageSize: preview.pageSize,
        columnRelations: preview.columnRelations,
        relationTables,
        visibleGridColumns: visible,
        columnMeta: colMeta ?? undefined,
      });
    }
    return buildTablePreviewSql({
      dbType,
      tableName: tab.tableName,
      filter: preview.filter,
      sort: preview.sort,
      page: preview.page,
      pageSize: preview.pageSize,
      columnMeta: colMeta ?? undefined,
    });
  }, [previewConnection, tab.tableName, preview, previewColumns, relationTables, colMeta]);

  const handleCopyPreviewSql = useCallback(async () => {
    if (gridActionsRef.current) {
      gridActionsRef.current.copyPreviewSql();
      return;
    }
    if (!previewSql) return;
    try {
      await navigator.clipboard.writeText(previewSql);
      setCopySqlHint(true);
      if (copySqlHintTimerRef.current != null) {
        window.clearTimeout(copySqlHintTimerRef.current);
      }
      copySqlHintTimerRef.current = window.setTimeout(() => {
        setCopySqlHint(false);
        copySqlHintTimerRef.current = null;
      }, 2000);
    } catch {
      showToast("复制失败");
    }
  }, [previewSql, t]);

  useEffect(() => {
    return () => {
      if (copySqlHintTimerRef.current != null) {
        window.clearTimeout(copySqlHintTimerRef.current);
      }
    };
  }, []);

  const dirtyCount = Object.keys(tabDirtyRowsForTab).length;
  const totalPages = preview
    ? Math.max(1, Math.ceil(preview.totalRows / preview.pageSize))
    : 1;

  const enableFilter = Boolean(previewConnection && previewConnection.db_type !== "redis");

  const detailPanel = (
    <TableDetailPanel
      activeTab={detailTab}
      onActiveTabChange={setDetailTab}
      position={detailPosition}
      onPositionChange={handlePositionChange}
      collapsed={detailCollapsed}
      onToggleCollapsed={handleDetailCollapsedChange}
      columns={previewColumns}
      columnMeta={colMeta}
      activeRow={activeRow}
      cellOverrides={activeRowOverrides}
      onRecordFieldApply={handleRecordFieldApply}
      onRecordFieldSetNull={canInsertRow ? handleRecordFieldSetNull : undefined}
      cellEditorRef={cellEditorRef}
      cellKey={activeCellKey}
      columnName={editorColumnName}
      columnType={editorSelectionCount > 1 ? "text" : (activeColumnMeta?.type ?? "text")}
      currentValue={editorSelectionCount > 1 ? "" : activeCellValue}
      selectionCount={editorSelectionCount}
      editorOpen={!detailCollapsed}
      onValueApply={handlePreviewCellApply}
      onValueSetNull={activeCell ? handlePreviewCellSetNullActive : undefined}
    />
  );

  const previewGrid = preview?.data && canRefresh && showPreviewGrid ? (
    <TableDataGrid
      columns={previewColumns}
      rows={previewDisplayRows}
      totalRows={preview.totalRows + (previewDisplayRows.length - preview.data.rows.length)}
      page={preview.page}
      pageSize={preview.pageSize}
      loading={preview.loading}
      columnMeta={colMeta}
      chromePlacement="none"
      gridActionsRef={gridActionsRef}
      onSelectedRowCountChange={setSelectedRowCount}
      enableTranspose
      enableSort
      sort={preview.sort ?? null}
      onSortChange={handlePreviewSortChange}
      enableFilter={enableFilter}
      filter={preview.filter ?? null}
      onFilterChange={handlePreviewFilterChange}
      onCellCommit={handlePreviewCellCommit}
      onActiveCellChange={handleActiveCellChange}
      onSelectedCellsChange={handleSelectedCellsChange}
      onCellSetNull={handlePreviewCellSetNull}
      onRowPaste={canInsertRow ? handlePreviewRowPaste : undefined}
      onDeleteSelectedRows={canDeleteRow ? handlePreviewRowsDelete : undefined}
      dirtyRowKeys={previewDirtyRowKeys}
      cellOverrides={previewCellOverrides}
      onPageChange={handlePreviewPageChange}
      dbType={previewConnection?.db_type}
      tableName={tab.tableName}
      hiddenColumns={preview.hiddenColumns}
      onHiddenColumnsChange={handleHiddenColumnsChange}
      transposed={preview.transposed}
      onTransposedChange={handleTransposedChange}
      cellEditorCollapsed={detailCollapsed}
      reserveSelectionOnEscape
      onCellEditorFocusRequest={handleCellEditorFocusRequest}
      relationTables={relationTables}
      relationConnection={previewConnection ?? undefined}
      relationDatabase={tab.dbName ?? undefined}
      columnRelations={preview.columnRelations}
      onColumnRelationsChange={handleColumnRelationsChange}
      statusBarActionPanelId={tab.id}
      statusBarInfo={statusBarInfo}
    />
  ) : null;

  const splitDirection = detailPosition === "right" ? "horizontal" : "vertical";
  const detailDefaultSize =
    detailPosition === "right" ? "250px" : "260px";
  const detailMinSize = detailPosition === "right" ? 200 : 160;

  return (
    <div className="db-workspace-pane db-workspace-pane--data">
      {preview?.error ? (
        <div
          className="empty-state compact text-danger"
          style={{ padding: "var(--sp-4)", whiteSpace: "pre-wrap" }}
        >
          {preview.error}
        </div>
      ) : !preview?.data && preview?.loading ? (
        <div className="empty-state compact" style={{ flex: 1, padding: "var(--sp-4)" }}>
          {t("common.loading")}
        </div>
      ) : previewGrid && preview ? (
        <div className="db-table-preview-shell">
          <TablePreviewTopBar
            loading={preview.loading}
            page={preview.page}
            pageSize={preview.pageSize}
            totalRows={preview.totalRows + (previewDisplayRows.length - preview.data!.rows.length)}
            totalPages={totalPages}
            dirtyCount={dirtyCount}
            isCommitting={isCommitting}
            canInsertRow={canInsertRow}
            canDeleteRow={canDeleteRow}
            hasSelectedRows={selectedRowCount > 0}
            selectedRowCount={selectedRowCount}
            canExport={canExport}
            canDesignTable={canDesignTable}
            canCreateTableQuery={Boolean(canRefresh && previewConnection)}
            transposed={preview.transposed}
            detailCollapsed={detailCollapsed}
            colSidebarCollapsed={colSidebarCollapsed}
            onPageChange={handlePreviewPageChange}
            onRefresh={() => ws.requestTabAction({ kind: "refresh", tabId: tab.id })}
            onInsertRow={() => ws.handleRowNew(tab.id)}
            onDeleteSelectedRows={() => gridActionsRef.current?.deleteSelectedRows()}
            onCommit={() => {
              ws.commitTabDirty(tab.id).catch(() => {});
            }}
            onExport={(x, y) => ws.openExportMenu(x, y, tab.id)}
            onTransposeToggle={() => handleTransposedChange(!preview.transposed)}
            onToggleColSidebar={() => {
              gridActionsRef.current?.toggleColSidebar();
              setColSidebarCollapsed((prev) => !prev);
            }}
            onToggleDetail={handleDetailCollapsedChange}
            onOpenTableDesign={handleOpenTableDesign}
            onCreateTableQuery={handleCreateTableQuery}
            onCopyPreviewSql={() => void handleCopyPreviewSql()}
            copySqlHint={copySqlHint}
            previewSqlTitle={previewSql}
          />
          <TablePreviewQueryBar
            dbType={previewConnection?.db_type ?? "mysql"}
            columnMeta={colMeta}
            filter={preview.filter}
            sort={preview.sort}
            onFilterChange={handlePreviewFilterChange}
            onSortChange={handlePreviewSortChange}
            activeDetailTab={detailTab}
            onDetailTabChange={setDetailTab}
            enableFilter={enableFilter}
          />
          <DockLayout
            key={detailPosition}
            direction={splitDirection}
            className={`db-table-preview-split db-table-preview-split--${detailPosition}`}
          >
            <DockPanel minSize={160}>
              <div className="results-area db-sql-results">{previewGrid}</div>
            </DockPanel>
            <DockHandle direction={splitDirection} />
            <DockPanel
              defaultSize={detailDefaultSize}
              minSize={detailMinSize}
              collapsible
              collapsedSize={0}
              panelRef={detailPanelRef}
              onResize={handleDetailPanelResize}
              className={
                detailPosition === "right" ? "dock-panel-right" : "dock-panel-bottom"
              }
            >
              {detailPanel}
            </DockPanel>
          </DockLayout>
        </div>
      ) : (
        <div className="empty-state compact" style={{ flex: 1, padding: "var(--sp-4)" }}>
          {t("common.loading")}
        </div>
      )}
    </div>
  );
});
