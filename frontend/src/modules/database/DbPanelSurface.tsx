import { useDbWorkspace } from "../../contexts/DbWorkspaceContext";
import type { SqlWorkspaceTab } from "./workspaceTabs";
import { DockLayout, DockHandle, DockPanel } from "../../components/dock";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { TableDataGrid } from "./TableDataGrid";
import { SqlEditor } from "./SqlEditor";
import { useI18n } from "../../i18n";
import { createDefaultSqlTabState } from "./dbWorkspaceState";

interface DbPanelSurfaceProps {
  tab: SqlWorkspaceTab;
}

export function DbPanelSurface({ tab }: DbPanelSurfaceProps) {
  const { t } = useI18n();
  const ws = useDbWorkspace();

  const tabState = ws.sqlTabStates[tab.id] ?? createDefaultSqlTabState();
  const preview = ws.tablePreviews[tab.id];
  const colMeta = ws.tableColumnMeta[tab.id];
  const mode = ws.tabModes[tab.id] ?? "sql";

  const schemaKey =
    ws.activeConn && tabState.database.trim()
      ? `${ws.activeConn.id}:${tabState.database}`
      : null;
  const schemaLoading = schemaKey !== null && ws.schemaLoadingKey === schemaKey;

  const resultRows = tabState.result
    ? ws.rowsToRecord(tabState.result.columns, tabState.result.rows)
    : [];
  const rowCount = resultRows.length;

  const canRefresh = preview?.connId && preview?.dbName && preview?.tableName;
  const isPreviewTab = !!(preview?.connId);
  const hasSqlQueryOutput = !isPreviewTab && !!(tabState.result || tabState.error);

  const databasesForActiveConn = ws.databasesForActiveConn;

  const exportConn = preview?.connId
    ? ws.groupConnections.find((c) => c.id === preview.connId)
    : ws.activeConn;
  const hasSqlResult = !!(tabState.result && tabState.result.columns.length > 0);
  const canExport =
    hasSqlResult ||
    !!(tabState.sql.trim() && exportConn && tabState.database.trim());

  const dismissSqlResults = () => {
    ws.updateSqlTabState(tab.id, { result: null, error: null, elapsed: null });
  };

  const editorContent = (
    <div className="db-editor-area">
      <div className="sql-toolbar">
        <Select
          className="db-select"
          value={ws.activeConn?.id ?? ""}
          onChange={(v) => ws.setActiveConnId(v || null)}
          disabled={ws.groupConnections.length === 0}
          title={t("database.workspace.connection")}
          searchable={false}
          placeholder={t("database.results.noConnection")}
          options={
            ws.groupConnections.length === 0
              ? [{ value: "", label: t("database.results.noConnection"), disabled: true }]
              : ws.groupConnections.map((conn) => ({ value: conn.id, label: conn.name }))
          }
        />
        <Select
          className="db-select"
          value={tabState.database}
          onChange={(v) => ws.updateSqlTabState(tab.id, { database: v })}
          disabled={!ws.activeConn || databasesForActiveConn.length === 0}
          title={t("database.workspace.database")}
          searchable={false}
          placeholder={t("database.workspace.noDatabase")}
          options={
            !ws.activeConn || databasesForActiveConn.length === 0
              ? [{ value: "", label: t("database.workspace.noDatabase"), disabled: true }]
              : databasesForActiveConn.map((dbName) => ({ value: dbName, label: dbName }))
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
            tabState.running || !ws.connectionForSql || !tabState.database.trim()
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
        schemas={ws.sqlCompletionSchemas}
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
            onPageChange={() => {}}
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
            rows={preview.data.rows}
            totalRows={preview.totalRows}
            page={preview.page}
            pageSize={preview.pageSize}
            loading={false}
            columnMeta={colMeta}
            enableTranspose
            onCellEdit={(cellInfo) => ws.handleCellEdit(tab.id, cellInfo)}
            dirtyRowKeys={new Set(Object.keys(ws.tabDirtyRows[tab.id] ?? {}))}
            cellOverrides={ws.tabDirtyRows[tab.id]}
            onPageChange={(page) => ws.requestTabAction({ kind: "page", tabId: tab.id, page })}
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
}
