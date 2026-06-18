import { useMemo, memo, useCallback } from "react";
import { useDbWorkspace } from "../../contexts/DbWorkspaceContext";
import type { SqlWorkspaceTab } from "./workspaceTabs";
import { DockLayout, DockHandle, DockPanel } from "../../components/dock";
import { Button } from "../../components/ui/Button";
import { IconPlus } from "../../components/ui/Icons";
import { Select } from "../../components/ui/Select";
import { TableDataGrid } from "./TableDataGrid";
import { SqlEditor } from "./SqlEditor";
import { useI18n } from "../../i18n";
import { createDefaultSqlTabState, NEW_ROW_KEY_PREFIX, PENDING_INSERT_ROW_KEY } from "./dbWorkspaceState";
import { connectionHasTableSchemaChildren, isConnectionEnabled } from "./api";

interface DbPanelSurfaceProps {
  tab: SqlWorkspaceTab;
}

export const DbPanelSurface = memo(function DbPanelSurface({ tab }: DbPanelSurfaceProps) {
  const { t } = useI18n();
  const ws = useDbWorkspace();

  const tabState = ws.sqlTabStates[tab.id] ?? createDefaultSqlTabState();
  const preview = ws.tablePreviews[tab.id];
  const colMeta = ws.tableColumnMeta[tab.id];
  const mode = ws.tabModes[tab.id] ?? "sql";

  const isPreviewTab = !!(preview?.connId);
  const hasSqlQueryOutput = !isPreviewTab && !!(tabState.result || tabState.error);

  const tabConn = ws.resolveSqlTabConnection(tab.id);
  const tabDatabases = ws.getSqlTabDatabases(tab.id);
  const connectionForRun = ws.connectionForSqlTab(tab.id);
  const completionSchemas = ws.getSqlCompletionSchemas(tab.id);

  const schemaKey =
    tabConn && tabState.database.trim()
      ? `${tabConn.id}:${tabState.database}`
      : null;
  const schemaLoading = schemaKey !== null && ws.schemaLoadingKey === schemaKey;

  const resultRows = tabState.result
    ? ws.rowsToRecord(tabState.result.columns, tabState.result.rows)
    : [];
  const rowCount = resultRows.length;

  const canRefresh = preview?.connId && preview?.dbName && preview?.tableName;

  const sqlConnections = ws.sqlConnections;

  const exportConn = preview?.connId
    ? ws.groupConnections.find((c) => c.id === preview.connId)
    : tabConn;
  const hasSqlResult = !!(tabState.result && tabState.result.columns.length > 0);
  const canExport =
    hasSqlResult ||
    !!(tabState.sql.trim() && exportConn && tabState.database.trim());

  const previewConnection = preview?.connId ? ws.resolveConnection(preview.connId) : null;
  const canInsertRow = !!(
    isPreviewTab &&
    canRefresh &&
    preview?.data &&
    colMeta?.length &&
    previewConnection &&
    connectionHasTableSchemaChildren(previewConnection)
  );

  const previewDisplayRows = useMemo(() => {
    if (!preview?.data || !colMeta) return preview?.data?.rows ?? [];
    const dirty = ws.tabDirtyRows[tab.id] ?? {};
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
  }, [preview?.data, colMeta, ws.tabDirtyRows, tab.id]);

  const previewDirtyRowKeys = useMemo(
    () => new Set(Object.keys(ws.tabDirtyRows[tab.id] ?? {})),
    [ws.tabDirtyRows, tab.id],
  );
  const previewCellOverrides = ws.tabDirtyRows[tab.id];
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
  const handlePreviewPageChange = useCallback(
    (page: number) => {
      ws.requestTabAction({ kind: "page", tabId: tab.id, page });
    },
    [ws.requestTabAction, tab.id],
  );
  const noopPageChange = useCallback(() => {}, []);

  const dismissSqlResults = () => {
    ws.updateSqlTabState(tab.id, { result: null, error: null, elapsed: null });
  };

  const editorContent = (
    <div className="db-editor-area">
      <div className="sql-toolbar">
        <Select
          className="db-select"
          value={tabConn?.id ?? tabState.connId ?? ""}
          onChange={(v) => ws.setSqlTabConnection(tab.id, v || null)}
          disabled={isPreviewTab || !tabState.connId && sqlConnections.length === 0}
          title={t("database.workspace.connection")}
          searchable={false}
          placeholder={t("database.results.noConnection")}
          options={
            sqlConnections.length === 0
              ? [{ value: "", label: t("database.results.noConnection"), disabled: true }]
              : sqlConnections.map((conn) => ({
                  value: conn.id,
                  label: isConnectionEnabled(conn)
                    ? conn.name
                    : `${conn.name} (${t("database.sidebar.connectionDisabled")})`,
                  disabled: !isConnectionEnabled(conn),
                }))
          }
        />
        <Select
          className="db-select"
          value={tabState.database}
          onChange={(v) => ws.updateSqlTabState(tab.id, { database: v })}
          disabled={isPreviewTab || !tabState.connId}
          title={t("database.workspace.database")}
          searchable={false}
          placeholder={t("database.workspace.noDatabase")}
          options={
            !tabConn || tabDatabases.length === 0
              ? [{ value: "", label: t("database.workspace.noDatabase"), disabled: true }]
              : tabDatabases.map((dbName) => ({ value: dbName, label: dbName }))
          }
        />
        {schemaLoading && (
          <span className="sql-toolbar-meta">{t("common.loading")}</span>
        )}
        <Button
          variant="primary"
          size="sm"
          style={{ marginLeft: "auto" }}
          onClick={() => void ws.runQuery(undefined, tab.id)}
          disabled={
            tabState.running || !connectionForRun || !tabState.database.trim()
          }
        >
          {tabState.running ? t("database.running") : t("database.runSql")}
        </Button>
      </div>
      <SqlEditor
        key={tab.id}
        openMode={ws.tabModeToEditorOpenMode(mode)}
        value={tabState.sql}
        onChange={(value) => ws.updateSqlTabState(tab.id, { sql: value })}
        onCursorOffsetChange={(cursorOffset) =>
          ws.updateSqlTabState(tab.id, { cursorOffset })
        }
        onRun={(sql) => void ws.runQuery(sql, tab.id)}
        schemas={completionSchemas}
      />
    </div>
  );

  const resultsContent = (
    <div className="results-area db-sql-results">
      <div className="results-header">
        <h3 style={{ marginRight: "auto" }}>
          {isPreviewTab ? tab.label : t("database.results.preview")}
        </h3>
        {isPreviewTab && canRefresh && (
          <>
            <Button
              variant="icon"
              style={{ marginLeft: "var(--sp-2)" }}
              title="Refresh"
              disabled={preview!.loading}
              onClick={() => ws.requestTabAction({ kind: "refresh", tabId: tab.id })}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <path d="M23 4v6h-6M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
              </svg>
            </Button>
            {!preview!.loading && canInsertRow && (
              <Button
                variant="icon"
                style={{ marginLeft: "var(--sp-2)" }}
                title={t("database.rowEditor.newRow")}
                aria-label={t("database.rowEditor.newRow")}
                onClick={() => ws.handleRowNew(tab.id)}
              >
                <IconPlus size={14} />
              </Button>
            )}
          </>
        )}
        {isPreviewTab && preview?.data && !preview.loading && canRefresh && (
          <span className="results-meta" style={{ marginLeft: "var(--sp-2)" }}>
            {preview!.page * preview!.pageSize + 1}–
            {Math.min((preview!.page + 1) * preview!.pageSize, preview!.totalRows)}
            {" / "}
            {preview!.totalRows.toLocaleString()}
          </span>
        )}
        {canExport && (
          <Button
            variant="icon"
            style={{ marginLeft: "var(--sp-2)" }}
            title={t("database.results.exportCsv")}
            aria-label={t("database.results.exportCsv")}
            disabled={tabState.running}
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
        {isPreviewTab && (() => {
          const dirtyCount = Object.keys(ws.tabDirtyRows[tab.id] ?? {}).length;
          const isCommitting = ws.committingTabs.has(tab.id);
          return (
            <span className="db-toolbar-icon-button-wrap" style={{ marginLeft: "var(--sp-2)" }}>
              <Button
                variant={dirtyCount > 0 ? "primary" : "icon"}
                style={{ position: "relative" }}
                disabled={dirtyCount === 0 || isCommitting}
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
              {dirtyCount > 0 && !isCommitting && (
                <span className="db-toolbar-badge" aria-hidden>{dirtyCount}</span>
              )}
            </span>
          );
        })()}
        {!isPreviewTab && (
          <span className="results-meta">
            {t("database.results.meta", {
              rows: rowCount,
              ms: tabState.elapsed ?? 0,
              mode: t("common.readonly"),
            })}
          </span>
        )}
        {mode === "sql" && hasSqlQueryOutput && (
          <Button
            variant="icon"
            title={t("database.results.close")}
            aria-label={t("database.results.close")}
            onClick={dismissSqlResults}
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              width="14"
              height="14"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </Button>
        )}
      </div>
      {tabState.error ? (
        <div
          className="empty-state compact text-danger"
          style={{ padding: "var(--sp-4)", whiteSpace: "pre-wrap" }}
        >
          {tabState.error}
        </div>
      ) : tabState.result ? (
        tabState.result.columns.length === 0 ? (
          <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
            {t("database.results.affected", { rows: tabState.result.rowsAffected })}
          </div>
        ) : (
          <TableDataGrid
            columns={tabState.result.columns}
            rows={resultRows}
            totalRows={resultRows.length}
            page={0}
            pageSize={resultRows.length}
            loading={false}
            onPageChange={noopPageChange}
          />
        )
      ) : isPreviewTab && preview ? (
        preview.loading ? (
          <div className="empty-state compact" style={{ flex: 1, padding: "var(--sp-4)" }}>
            {t("common.loading")}
          </div>
        ) : preview.error ? (
          <div
            className="empty-state compact text-danger"
            style={{ padding: "var(--sp-4)", whiteSpace: "pre-wrap" }}
          >
            {preview.error}
          </div>
        ) : preview.data && canRefresh ? (
          <TableDataGrid
            columns={preview.data.columns}
            rows={previewDisplayRows}
            totalRows={preview.totalRows + (previewDisplayRows.length - preview.data.rows.length)}
            page={preview.page}
            pageSize={preview.pageSize}
            loading={false}
            columnMeta={colMeta}
            enableTranspose
            onCellEdit={handlePreviewCellEdit}
            onRowEdit={handlePreviewRowEdit}
            dirtyRowKeys={previewDirtyRowKeys}
            cellOverrides={previewCellOverrides}
            onPageChange={handlePreviewPageChange}
          />
        ) : null
      ) : (
        <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
          {t("database.results.runHint")}
        </div>
      )}
      {tabState.result && (
        <div className="exec-stats">
          <span className="stat">
            {t("database.results.title")}: <span className="stat-val">{rowCount}</span>
          </span>
          <span className="stat">
            Latency: <span className="stat-val">{tabState.elapsed ?? 0}ms</span>
          </span>
        </div>
      )}
    </div>
  );

  if (mode === "data") {
    return (
      <div className="db-workspace-pane db-workspace-pane--sql">
        <DockLayout direction="vertical" className="db-sql-split">
          <DockPanel key={tab.id} defaultSize={0} minSize={160} collapsible collapsedSize={0}>
            {editorContent}
          </DockPanel>
          <DockHandle direction="vertical" />
          <DockPanel defaultSize={100} minSize={120} className="dock-panel-bottom">
            {resultsContent}
          </DockPanel>
        </DockLayout>
      </div>
    );
  }

  if (!hasSqlQueryOutput) {
    return (
      <div className="db-workspace-pane db-workspace-pane--sql">
        <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
          {editorContent}
        </div>
      </div>
    );
  }

  return (
    <div className="db-workspace-pane db-workspace-pane--sql">
      <DockLayout direction="vertical" className="db-sql-split">
        <DockPanel key={tab.id} defaultSize={55} minSize={160}>
          {editorContent}
        </DockPanel>
        <DockHandle direction="vertical" />
        <DockPanel defaultSize={45} minSize={120} className="dock-panel-bottom">
          {resultsContent}
        </DockPanel>
      </DockLayout>
    </div>
  );
});
