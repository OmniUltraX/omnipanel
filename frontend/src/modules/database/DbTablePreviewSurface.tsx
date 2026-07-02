import { useMemo, memo, useCallback, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  useDbWorkspace,
  useDbTabWorkspaceSliceOrMirror,
} from "../../contexts/DbWorkspaceContext";
import type { TablePreviewWorkspaceTab } from "./workspaceTabs";
import { Button } from "../../components/ui/Button";
import { IconPlus } from "../../components/ui/Icons";
import { DockHandle, DockLayout, DockPanel } from "../../components/dock";
import { TableDataGrid, type TableDataGridActiveCell } from "./TableDataGrid";
import { CellEditorPanel, type CellEditorPanelHandle } from "./cell_editor";
import { useI18n } from "../../i18n";
import {
  NEW_ROW_KEY_PREFIX,
  PENDING_INSERT_ROW_KEY,
  DELETED_ROW_KEY_PREFIX,
  isDeletedRowDirtyKey,
  resolvePreviewRowKey,
  type SortState,
} from "./dbWorkspaceState";
import type { RuleGroupType } from "react-querybuilder";
import { connectionHasTableSchemaChildren } from "./api";

interface DbTablePreviewSurfaceProps {
  tab: TablePreviewWorkspaceTab;
}

export const DbTablePreviewSurface = memo(function DbTablePreviewSurface({
  tab,
}: DbTablePreviewSurfaceProps) {
  const { t } = useI18n();
  const ws = useDbWorkspace();
  const cellEditorRef = useRef<CellEditorPanelHandle>(null);
  const cellEditorPanelRef = useRef<PanelImperativeHandle | null>(null);
  const [cellEditorCollapsed, setCellEditorCollapsed] = useState(false);
  const [activeCell, setActiveCell] = useState<TableDataGridActiveCell | null>(null);
  const {
    tablePreview: preview,
    tableColumnMeta: colMeta,
    tabDirtyRows: tabDirtyRowsForTab,
    isCommitting,
  } = useDbTabWorkspaceSliceOrMirror(tab.id);

  const canRefresh = tab.connId && tab.dbName && tab.tableName;

  const previewConnection = tab.connId ? ws.resolveConnection(tab.connId) : null;
  const canInsertRow = !!(
    canRefresh &&
    preview?.data &&
    colMeta?.length &&
    previewConnection &&
    connectionHasTableSchemaChildren(previewConnection)
  );

  const canDeleteRow = !!(
    canInsertRow &&
    previewConnection.db_type !== "redis"
  );

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
    if (!activeCell) return null;
    const rowKey = resolvePreviewRowKey(activeCell.row, pkCols);
    return `${rowKey}:${activeCell.column}`;
  }, [activeCell, pkCols]);

  const activeColumnMeta = useMemo(
    () => (activeCell ? colMeta?.find((col) => col.name === activeCell.column) : undefined),
    [activeCell, colMeta],
  );

  const activeCellValue = useMemo(() => {
    if (!activeCell) return undefined;
    const rowKey = resolvePreviewRowKey(activeCell.row, pkCols);
    const override = rowKey ? previewCellOverrides[rowKey]?.[activeCell.column] : undefined;
    return override !== undefined ? override : activeCell.row[activeCell.column];
  }, [activeCell, pkCols, previewCellOverrides]);

  const handleActiveCellChange = useCallback((cell: TableDataGridActiveCell | null) => {
    cellEditorRef.current?.commitIfDirty();
    setActiveCell(cell);
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
  const handlePreviewRowEdit = useCallback(
    (cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> }) => {
      ws.handleRowEdit(tab.id, cellInfo);
    },
    [ws.handleRowEdit, tab.id],
  );
  const handlePreviewCellSetNull = useCallback(
    (cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> }) => {
      ws.handleCellSetNull(tab.id, cellInfo);
    },
    [ws.handleCellSetNull, tab.id],
  );
  const handlePreviewCellApply = useCallback(
    (value: unknown) => {
      if (!activeCell) return;
      ws.handleCellCommit(tab.id, activeCell, value);
    },
    [activeCell, ws.handleCellCommit, tab.id],
  );
  const handlePreviewCellSetNullActive = useCallback(() => {
    if (!activeCell) return;
    ws.handleCellSetNull(tab.id, activeCell);
  }, [activeCell, ws.handleCellSetNull, tab.id]);
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

  const handleCellEditorCollapsedChange = useCallback(() => {
    const handle = cellEditorPanelRef.current;
    if (!handle) return;
    if (handle.isCollapsed()) {
      handle.expand();
      setCellEditorCollapsed(false);
    } else {
      cellEditorRef.current?.commitIfDirty();
      handle.collapse();
      setCellEditorCollapsed(true);
    }
  }, []);

  const handleCellEditorFocusRequest = useCallback(() => {
    cellEditorRef.current?.focusEditor();
  }, []);

  const handleCellEditorPanelResize = useCallback(() => {
    const collapsed = cellEditorPanelRef.current?.isCollapsed() ?? false;
    setCellEditorCollapsed(collapsed);
  }, []);

  const showPreviewGrid = Boolean(
    preview?.data && canRefresh && !preview.loading && !preview.error,
  );

  const previewToolbar = useMemo(() => {
    if (!showPreviewGrid || !preview) return null;
    const dirtyCount = Object.keys(tabDirtyRowsForTab).length;
    const isCommittingTab = isCommitting;
    return (
      <>
        <Button
          variant="icon"
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
          disabled={preview.loading}
          onClick={() => ws.requestTabAction({ kind: "refresh", tabId: tab.id })}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </Button>
        {!preview.loading && canInsertRow && (
          <Button
            variant="icon"
            title={t("database.rowEditor.newRow")}
            aria-label={t("database.rowEditor.newRow")}
            onClick={() => ws.handleRowNew(tab.id)}
          >
            <IconPlus size={14} />
          </Button>
        )}
        {canExport && (
          <Button
            variant="icon"
            title={t("database.results.exportCsv")}
            aria-label={t("database.results.exportCsv")}
            onClick={(e) => {
              ws.openExportMenu(e.clientX, e.clientY, tab.id);
            }}
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
              <path d="M8 1.5v9" strokeLinecap="round" />
              <path d="M4.5 7L8 10.5 11.5 7" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 13h11" strokeLinecap="round" />
            </svg>
          </Button>
        )}
        <span className="db-toolbar-icon-button-wrap">
          <Button
            variant={dirtyCount > 0 ? "primary" : "icon"}
            style={{ position: "relative" }}
            disabled={dirtyCount === 0 || isCommittingTab}
            onClick={() => {
              ws.commitTabDirty(tab.id).catch(() => {});
            }}
            title={t("database.results.commitDirty", { count: dirtyCount })}
            aria-label={t("database.results.commitDirty", { count: dirtyCount })}
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
              <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
          {dirtyCount > 0 && !isCommittingTab && (
            <span className="db-toolbar-badge" aria-hidden>{dirtyCount}</span>
          )}
        </span>
      </>
    );
  }, [
    showPreviewGrid,
    preview,
    canInsertRow,
    canExport,
    tabDirtyRowsForTab,
    isCommitting,
    tab.id,
    t,
    ws,
  ]);

  const previewGrid = preview?.data && canRefresh && showPreviewGrid ? (
    <TableDataGrid
      columns={previewColumns}
      rows={previewDisplayRows}
      totalRows={preview.totalRows + (previewDisplayRows.length - preview.data.rows.length)}
      page={preview.page}
      pageSize={preview.pageSize}
      loading={preview.loading}
      columnMeta={colMeta}
      enableTranspose
      enableSort
      sort={preview.sort ?? null}
      onSortChange={handlePreviewSortChange}
      enableFilter={Boolean(previewConnection && previewConnection.db_type !== "redis")}
      filter={preview.filter ?? null}
      onFilterChange={handlePreviewFilterChange}
      toolbar={previewToolbar}
      onCellCommit={handlePreviewCellCommit}
      onActiveCellChange={handleActiveCellChange}
      onRowEdit={handlePreviewRowEdit}
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
      cellEditorCollapsed={cellEditorCollapsed}
      onCellEditorCollapsedChange={handleCellEditorCollapsedChange}
      onCellEditorFocusRequest={handleCellEditorFocusRequest}
    />
  ) : null;

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
      ) : previewGrid ? (
        <DockLayout direction="vertical" className="db-table-preview-split">
          <DockPanel defaultSize={68} minSize={160}>
            <div className="results-area db-sql-results">{previewGrid}</div>
          </DockPanel>
          <DockHandle direction="vertical" />
          <DockPanel
            defaultSize={32}
            minSize={120}
            collapsible
            collapsedSize={0}
            panelRef={cellEditorPanelRef}
            onResize={handleCellEditorPanelResize}
            className="dock-panel-bottom"
          >
            <CellEditorPanel
              ref={cellEditorRef}
              cellKey={activeCellKey}
              columnName={activeCell?.column ?? null}
              columnType={activeColumnMeta?.type ?? "text"}
              currentValue={activeCellValue}
              onApply={handlePreviewCellApply}
              onSetNull={activeCell ? handlePreviewCellSetNullActive : undefined}
            />
          </DockPanel>
        </DockLayout>
      ) : null}
    </div>
  );
});
