import { useMemo, memo, useCallback } from "react";
import { useModuleSuspended } from "../../lib/moduleVisibility";
import {
  useDbWorkspace,
  useDbWorkspaceActiveTabId,
} from "../../contexts/DbWorkspaceContext";
import type { SqlWorkspaceTab } from "./workspaceTabs";
import { DockLayout, DockHandle, DockPanel } from "../../components/dock";
import { Button } from "../../components/ui/Button";
import { IconPlus } from "../../components/ui/Icons";
import { Select } from "../../components/ui/Select";
import { TableDataGrid } from "./TableDataGrid";
import { SqlEditor, type SqlEditorOpenMode } from "./SqlEditor";
import { useI18n } from "../../i18n";
import { createDefaultSqlTabState, DEFAULT_QUERY_LIMIT, NEW_ROW_KEY_PREFIX, PENDING_INSERT_ROW_KEY, type SortState, type SqlTabState } from "./dbWorkspaceState";
import { connectionHasTableSchemaChildren, isConnectionEnabled } from "./api";
import type { DatabaseSchema } from "./types";

interface DbPanelSurfaceProps {
  tab: SqlWorkspaceTab;
}

interface DbPanelSqlEditorProps {
  tabId: string;
  tabState: SqlTabState;
  openMode: SqlEditorOpenMode;
  scopedSchemas: DatabaseSchema[];
  onChange: (value: string) => void;
  onCursorOffsetChange: (cursorOffset: number) => void;
  onRun: (sql: string) => void;
  onSave: () => void;
}

/** 单独订阅 activeTabId，避免切换 Tab 时整页 DbPanelSurface reconcile。 */
const DbPanelSqlEditor = memo(function DbPanelSqlEditor({
  tabId,
  tabState,
  openMode,
  scopedSchemas,
  onChange,
  onCursorOffsetChange,
  onRun,
  onSave,
}: DbPanelSqlEditorProps) {
  const activeTabId = useDbWorkspaceActiveTabId();
  const moduleSuspended = useModuleSuspended();
  const editorActive = activeTabId === tabId && !moduleSuspended;

  return (
    <SqlEditor
      key={tabId}
      editorActive={editorActive}
      openMode={openMode}
      value={tabState.sql}
      onChange={onChange}
      onCursorOffsetChange={onCursorOffsetChange}
      onRun={onRun}
      onSave={onSave}
      schemas={scopedSchemas}
    />
  );
});

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
  const scopedSchemas = useMemo(() => {
    if (!isPreviewTab || !preview?.tableName) return completionSchemas;
    const tableName = preview.tableName;
    return completionSchemas.map((db) => ({
      ...db,
      tables: db.tables.filter((t) => t.name === tableName),
    }));
  }, [completionSchemas, isPreviewTab, preview?.tableName]);

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
  const handleSqlChange = useCallback(
    (value: string) => ws.updateSqlTabState(tab.id, { sql: value }),
    [ws.updateSqlTabState, tab.id],
  );
  const handleSqlCursorChange = useCallback(
    (cursorOffset: number) => ws.updateSqlTabState(tab.id, { cursorOffset }),
    [ws.updateSqlTabState, tab.id],
  );
  const handleSqlRun = useCallback(
    (sql: string) => void ws.runQuery(sql, tab.id),
    [ws.runQuery, tab.id],
  );
  const handleSqlSave = useCallback(
    () => void ws.saveSqlTab(tab.id),
    [ws.saveSqlTab, tab.id],
  );
  const sqlEditorOpenMode = ws.tabModeToEditorOpenMode(mode);
  const noopPageChange = useCallback(() => {}, []);

  const dismissSqlResults = () => {
    ws.updateSqlTabState(tab.id, { result: null, error: null, elapsed: null });
  };

  const showPreviewGrid = Boolean(
    isPreviewTab && preview?.data && canRefresh && !preview.loading && !preview.error,
  );

  const previewToolbar = useMemo(() => {
    if (!showPreviewGrid || !preview) return null;
    const dirtyCount = Object.keys(ws.tabDirtyRows[tab.id] ?? {}).length;
    const isCommitting = ws.committingTabs.has(tab.id);
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
        <span className="db-toolbar-icon-button-wrap">
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
      </>
    );
  }, [
    showPreviewGrid,
    preview,
    canInsertRow,
    canExport,
    tabState.running,
    tab.id,
    t,
    ws,
  ]);

  const showResultsHeader = !showPreviewGrid && !!(tabState.error || tabState.result);

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
      <DbPanelSqlEditor
        tabId={tab.id}
        tabState={tabState}
        openMode={sqlEditorOpenMode}
        scopedSchemas={scopedSchemas}
        onChange={handleSqlChange}
        onCursorOffsetChange={handleSqlCursorChange}
        onRun={handleSqlRun}
        onSave={handleSqlSave}
      />
    </div>
  );

  const resultsContent = (
    <div className="results-area db-sql-results">
      {showResultsHeader && (
      <div className="results-header">
        <h3 style={{ marginRight: "auto" }}>
          {t("database.results.preview")}
        </h3>
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
        <span className="results-meta">
          {t("database.results.meta", {
            rows: rowCount,
            ms: tabState.elapsed ?? 0,
            mode: t("common.readonly"),
          })}
        </span>
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
      )}
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
        preview.error ? (
          <div
            className="empty-state compact text-danger"
            style={{ padding: "var(--sp-4)", whiteSpace: "pre-wrap" }}
          >
            {preview.error}
          </div>
        ) : !preview.data && preview.loading ? (
          <div className="empty-state compact" style={{ flex: 1, padding: "var(--sp-4)" }}>
            {t("common.loading")}
          </div>
        ) : preview.data && canRefresh ? (
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
          {rowCount >= DEFAULT_QUERY_LIMIT && (
            <span className="stat db-exec-stats-truncated">
              {t("database.results.truncated", { limit: DEFAULT_QUERY_LIMIT })}
            </span>
          )}
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
