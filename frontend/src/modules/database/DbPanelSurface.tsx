import { memo, useCallback } from "react";
import { useModuleSuspended } from "../../lib/moduleVisibility";
import {
  useDbWorkspace,
  useDbWorkspaceActiveTabId,
  useDbTabWorkspaceSliceOrMirror,
} from "../../contexts/DbWorkspaceContext";
import type { SqlWorkspaceTab } from "./workspaceTabs";
import { DockLayout, DockHandle, DockPanel } from "../../components/dock";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { SqlEditor, type SqlEditorOpenMode } from "./SqlEditor";
import { SqlResultSessionsDock } from "./SqlResultSessionsDock";
import { useI18n } from "../../i18n";
import { createDefaultSqlTabState, type SqlTabState } from "./dbWorkspaceState";
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
    tabMode: _mode,
  } = useDbTabWorkspaceSliceOrMirror(tab.id);
  const tabState = sqlTabState ?? createDefaultSqlTabState();

  const resultSessions = tabState.resultSessions ?? [];
  const hasResultPanel = resultSessions.length > 0;

  const tabConn = ws.resolveSqlTabConnection(tab.id);
  const tabDatabases = ws.getSqlTabDatabases(tab.id);
  const connectionForRun = ws.connectionForSqlTab(tab.id);
  const completionSchemas = ws.getSqlCompletionSchemas(tab.id);

  const schemaKey =
    tabConn && tabState.database.trim()
      ? `${tabConn.id}:${tabState.database}`
      : null;
  const schemaLoading = schemaKey !== null && ws.schemaLoadingKey === schemaKey;

  const sqlConnections = ws.sqlConnections;

  const handleSqlChange = useCallback(
    (value: string) => {
      ws.updateSqlTabState(tab.id, {
        sql: value,
        ...(tabState.error ? { error: null } : {}),
      });
    },
    [ws.updateSqlTabState, tab.id, tabState.error],
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
  const sqlEditorOpenMode = ws.tabModeToEditorOpenMode(_mode);

  const handleActiveSessionChange = useCallback(
    (sessionId: string) => {
      ws.updateSqlTabState(tab.id, { activeResultSessionId: sessionId });
    },
    [ws.updateSqlTabState, tab.id],
  );

  const handleCloseSession = useCallback(
    (sessionId: string) => {
      ws.closeSqlResultSession(tab.id, sessionId);
    },
    [ws.closeSqlResultSession, tab.id],
  );

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
      {tabState.error && !tabState.running ? (
        <div className="sql-toolbar-error text-danger">{tabState.error}</div>
      ) : null}
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
      <SqlResultSessionsDock
        sqlTabId={tab.id}
        sessions={resultSessions}
        activeSessionId={tabState.activeResultSessionId}
        onActiveSessionChange={handleActiveSessionChange}
        onCloseSession={handleCloseSession}
      />
    </div>
  );

  if (!hasResultPanel) {
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
