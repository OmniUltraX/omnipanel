import { memo, useCallback } from "react";
import { useModuleSuspended } from "../../lib/moduleVisibility";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  useDbWorkspace,
  useDbWorkspaceActiveTabId,
  useDbTabWorkspaceSliceOrMirror,
} from "../../contexts/DbWorkspaceContext";
import type { SqlWorkspaceTab } from "./workspaceTabs";
import { DockLayout, DockHandle, DockPanel } from "../../components/dock";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { TableDataGrid } from "./TableDataGrid";
import { SqlEditor, type SqlEditorOpenMode } from "./SqlEditor";
import { useI18n } from "../../i18n";
import { createDefaultSqlTabState, estimateSqlResultTotalRows, type SqlTabState } from "./dbWorkspaceState";
import { isConnectionEnabled } from "./api";
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
  const {
    sqlTabState,
    tabMode: mode,
  } = useDbTabWorkspaceSliceOrMirror(tab.id);
  const tabState = sqlTabState ?? createDefaultSqlTabState();
  const databaseQueryPageSize = useSettingsStore((s) => s.databaseQueryPageSize);

  const hasSqlQueryOutput = !!(tabState.result || tabState.error);

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

  const resultPage = tabState.resultPage ?? 0;
  const resultHasMore = tabState.resultHasMore ?? false;
  const estimatedTotalRows = estimateSqlResultTotalRows(
    resultPage,
    databaseQueryPageSize,
    rowCount,
    resultHasMore,
  );

  const sqlConnections = ws.sqlConnections;

  const exportConn = tabConn;
  const hasSqlResult = !!(tabState.result && tabState.result.columns.length > 0);
  const canExport =
    hasSqlResult ||
    !!(tabState.sql.trim() && exportConn && tabState.database.trim());

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
  const handleQueryPageChange = useCallback(
    (page: number) => void ws.goToQueryResultPage(tab.id, page),
    [ws.goToQueryResultPage, tab.id],
  );

  const dismissSqlResults = () => {
    ws.updateSqlTabState(tab.id, {
      result: null,
      error: null,
      elapsed: null,
      resultPage: 0,
      lastExecutedSql: null,
      resultHasMore: false,
    });
  };

  const editorContent = (
    <div className="db-editor-area">
      <div className="sql-toolbar">
        <Select
          className="db-select"
          value={tabConn?.id ?? tabState.connId ?? ""}
          onChange={(v) => ws.setSqlTabConnection(tab.id, v || null)}
          disabled={!tabState.connId && sqlConnections.length === 0}
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
          disabled={!tabState.connId}
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
        scopedSchemas={completionSchemas}
        onChange={handleSqlChange}
        onCursorOffsetChange={handleSqlCursorChange}
        onRun={handleSqlRun}
        onSave={handleSqlSave}
      />
    </div>
  );

  const resultsContent = (
    <div className="results-area db-sql-results">
      {(tabState.error || tabState.result) && (
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
            rows: resultHasMore ? `${estimatedTotalRows}+` : estimatedTotalRows,
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
            totalRows={estimatedTotalRows}
            page={resultPage}
            pageSize={databaseQueryPageSize}
            loading={tabState.running}
            onPageChange={handleQueryPageChange}
          />
        )
      ) : (
        <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
          {t("database.results.runHint")}
        </div>
      )}
      {tabState.result && (
        <div className="exec-stats">
          <span className="stat">
            {t("database.results.title")}:{" "}
            <span className="stat-val">
              {resultHasMore ? `${estimatedTotalRows}+` : estimatedTotalRows}
            </span>
          </span>
          <span className="stat">
            Latency: <span className="stat-val">{tabState.elapsed ?? 0}ms</span>
          </span>
          {resultHasMore && (
            <span className="stat db-exec-stats-truncated">
              {t("database.results.hasMore")}
            </span>
          )}
        </div>
      )}
    </div>
  );

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
