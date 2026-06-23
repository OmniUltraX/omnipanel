import { useMemo, memo, useCallback } from "react";
import {
  useDbWorkspace,
  useDbTabWorkspaceSliceOrMirror,
} from "../../contexts/DbWorkspaceContext";
import type { SqlWorkspaceTab } from "./workspaceTabs";
import { Button } from "../../components/ui/Button";
import { IconPlus } from "../../components/ui/Icons";
import { TableDataGrid } from "./TableDataGrid";
import { useI18n } from "../../i18n";
import { NEW_ROW_KEY_PREFIX, PENDING_INSERT_ROW_KEY, type SortState } from "./dbWorkspaceState";
import { connectionHasTableSchemaChildren } from "./api";

interface DbTablePreviewSurfaceProps {
  tab: SqlWorkspaceTab;
}

export const DbTablePreviewSurface = memo(function DbTablePreviewSurface({
  tab,
}: DbTablePreviewSurfaceProps) {
  const { t } = useI18n();
  const ws = useDbWorkspace();
  const {
    tablePreview: preview,
    tableColumnMeta: colMeta,
    tabDirtyRows: tabDirtyRowsForTab,
    isCommitting,
  } = useDbTabWorkspaceSliceOrMirror(tab.id);

  const canRefresh = preview?.connId && preview?.dbName && preview?.tableName;

  const previewConnection = preview?.connId ? ws.resolveConnection(preview.connId) : null;
  const canInsertRow = !!(
    canRefresh &&
    preview?.data &&
    colMeta?.length &&
    previewConnection &&
    connectionHasTableSchemaChildren(previewConnection)
  );

  const canExport = Boolean(preview?.data && previewConnection);

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
    return [...preview.data.rows, ...pendingRows];
  }, [preview?.data, colMeta, tabDirtyRowsForTab]);

  const previewDirtyRowKeys = useMemo(
    () => new Set(Object.keys(tabDirtyRowsForTab)),
    [tabDirtyRowsForTab],
  );
  const previewCellOverrides = tabDirtyRowsForTab;

  const handlePreviewCellEdit = useCallback(
    (cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> }) => {
      ws.handleCellEdit(tab.id, cellInfo);
    },
    [ws.handleCellEdit, tab.id],
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

  return (
    <div className="db-workspace-pane db-workspace-pane--data">
      <div className="results-area db-sql-results">
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
        ) : preview?.data && canRefresh ? (
          <TableDataGrid
            columns={preview.data.columns}
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
            toolbar={previewToolbar}
            onCellEdit={handlePreviewCellEdit}
            onRowEdit={handlePreviewRowEdit}
            onCellSetNull={handlePreviewCellSetNull}
            dirtyRowKeys={previewDirtyRowKeys}
            cellOverrides={previewCellOverrides}
            onPageChange={handlePreviewPageChange}
          />
        ) : null}
      </div>
    </div>
  );
});
