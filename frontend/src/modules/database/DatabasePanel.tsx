import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DockLayout, DockHandle, DockPanel, DockWorkspace } from "../../components/dock";
import { SchemaBrowser, type SchemaTableSelection } from "./SchemaBrowser";
import { ConnectionDialog } from "./ConnectionDialog";
import { TableDataGrid } from "./TableDataGrid";
import { useActionStore } from "../../stores/actionStore";
import { useDbGroupStore } from "../../stores/dbGroupStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";
import { quickInput } from "../../lib/quickInput";
import { SqlEditor } from "./SqlEditor";
import {
  connectionMatchesGroup,
  introspectSchema,
  listConnections,
  listDatabases,
  previewTable,
  type DbConnectionConfig,
  type TablePreviewResult,
} from "./api";
import { buildDatabaseSchema, introspectToTableSchemas } from "./lsp/sqlCompletion";
import type { DatabaseSchema } from "./types";
import {
  makeSqlTabId,
  makeSqlTabLabel,
  makeTableTabId,
  makeTableTabLabel,
  type DatabaseWorkspaceTab,
  type SqlWorkspaceTab,
} from "./workspaceTabs";

const DEFAULT_SQL = `SELECT 1;`;

/** db_execute_query 的返回结构（serde camelCase）。 */
interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowsAffected: number;
}

type TablePreviewState = {
  loading: boolean;
  error: string | null;
  data: TablePreviewResult | null;
};

type SqlTabState = {
  sql: string;
  database: string;
  result: QueryResult | null;
  error: string | null;
  elapsed: number | null;
  running: boolean;
};

function createDefaultSqlTabState(database = ""): SqlTabState {
  return {
    sql: DEFAULT_SQL,
    database,
    result: null,
    error: null,
    elapsed: null,
    running: false,
  };
}

const INITIAL_SQL_TAB_ID = makeSqlTabId();
const INITIAL_SQL_TAB: SqlWorkspaceTab = {
  id: INITIAL_SQL_TAB_ID,
  kind: "sql",
  label: makeSqlTabLabel(1),
};

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function DatabasePanel() {
  const { t } = useI18n();
  const enqueueAction = useActionStore((s) => s.enqueueAction);
  const groups = useDbGroupStore((s) => s.groups);
  const activeGroupId = useDbGroupStore((s) => s.activeGroupId);
  const setActiveGroupId = useDbGroupStore((s) => s.setActiveGroupId);
  const addGroup = useDbGroupStore((s) => s.addGroup);
  const getGroupName = useDbGroupStore((s) => s.getGroupName);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [schemaRefreshToken, setSchemaRefreshToken] = useState(0);

  const [connections, setConnections] = useState<DbConnectionConfig[]>([]);
  const [activeConnId, setActiveConnId] = useState<string | null>(null);
  const [sqlTabStates, setSqlTabStates] = useState<Record<string, SqlTabState>>(() => ({
    [INITIAL_SQL_TAB_ID]: createDefaultSqlTabState(),
  }));

  const [workspaceTabs, setWorkspaceTabs] = useState<DatabaseWorkspaceTab[]>([INITIAL_SQL_TAB]);
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] = useState(INITIAL_SQL_TAB_ID);
  const [tablePreviews, setTablePreviews] = useState<Record<string, TablePreviewState>>({});
  const [activeTableKey, setActiveTableKey] = useState<string | null>(null);
  const [databasesByConnId, setDatabasesByConnId] = useState<Record<string, string[]>>({});
  const [schemaByKey, setSchemaByKey] = useState<Record<string, DatabaseSchema>>({});
  const [schemaLoadingKey, setSchemaLoadingKey] = useState<string | null>(null);

  const activeGroupName = useMemo(
    () => getGroupName(activeGroupId),
    [activeGroupId, getGroupName, groups],
  );

  const groupConnections = useMemo(
    () => connections.filter((conn) => connectionMatchesGroup(conn, activeGroupName)),
    [connections, activeGroupName],
  );

  const activeConn = useMemo(
    () => groupConnections.find((c) => c.id === activeConnId) ?? groupConnections[0] ?? null,
    [groupConnections, activeConnId],
  );

  const activeWorkspaceTab = useMemo(
    () => workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? null,
    [workspaceTabs, activeWorkspaceTabId],
  );

  const updateSqlTabState = useCallback((tabId: string, patch: Partial<SqlTabState>) => {
    setSqlTabStates((prev) => ({
      ...prev,
      [tabId]: { ...(prev[tabId] ?? createDefaultSqlTabState()), ...patch },
    }));
  }, []);

  const refreshConnections = useCallback(async () => {
    try {
      const list = await listConnections();
      setConnections(list);
      setActiveConnId((prev) => {
        if (prev && list.some((item) => item.id === prev)) {
          return prev;
        }
        const inGroup = list.find((item) => connectionMatchesGroup(item, activeGroupName));
        return inGroup?.id ?? list[0]?.id ?? null;
      });
    } catch {
      // 非 Tauri 环境（纯前端 dev）忽略。
    }
  }, [activeGroupName]);

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections, schemaRefreshToken]);

  useEffect(() => {
    setActiveConnId((prev) => {
      if (prev && groupConnections.some((item) => item.id === prev)) {
        return prev;
      }
      return groupConnections[0]?.id ?? null;
    });
  }, [activeGroupId, groupConnections]);

  const activeSqlTabId =
    activeWorkspaceTab?.kind === "sql" ? activeWorkspaceTab.id : null;
  const activeSqlTabState = activeSqlTabId
    ? (sqlTabStates[activeSqlTabId] ?? createDefaultSqlTabState())
    : null;
  const activeSqlDatabase = activeSqlTabState?.database ?? "";

  const connectionForSql = useMemo(() => {
    if (!activeConn) {
      return null;
    }
    if (!activeSqlDatabase.trim()) {
      return activeConn;
    }
    return { ...activeConn, database: activeSqlDatabase };
  }, [activeConn, activeSqlDatabase]);

  const databasesForActiveConn = activeConn
    ? (databasesByConnId[activeConn.id] ?? [])
    : [];

  const sqlCompletionSchemas = useMemo((): DatabaseSchema[] => {
    if (!activeConn || !activeSqlDatabase.trim()) {
      return [];
    }
    const key = `${activeConn.id}:${activeSqlDatabase}`;
    const cached = schemaByKey[key];
    if (cached) {
      return [cached];
    }
    return [buildDatabaseSchema(activeSqlDatabase, [])];
  }, [activeConn, activeSqlDatabase, schemaByKey]);

  useEffect(() => {
    if (!activeConn) {
      return;
    }
    if (databasesByConnId[activeConn.id]) {
      return;
    }
    let cancelled = false;
    void listDatabases(activeConn)
      .then((names) => {
        if (!cancelled) {
          setDatabasesByConnId((prev) => ({ ...prev, [activeConn.id]: names }));
        }
      })
      .catch(() => {
        if (!cancelled) {
          const fallback = activeConn.database.trim() ? [activeConn.database] : [];
          setDatabasesByConnId((prev) => ({ ...prev, [activeConn.id]: fallback }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeConn, databasesByConnId]);

  useEffect(() => {
    if (!activeSqlTabId || !activeConn || databasesForActiveConn.length === 0) {
      return;
    }
    const tabState = sqlTabStates[activeSqlTabId];
    if (tabState?.database.trim()) {
      return;
    }
    const preset = activeConn.database.trim();
    const pick =
      preset && databasesForActiveConn.includes(preset)
        ? preset
        : databasesForActiveConn[0];
    if (pick) {
      updateSqlTabState(activeSqlTabId, { database: pick });
    }
  }, [
    activeSqlTabId,
    activeConn,
    databasesForActiveConn,
    sqlTabStates,
    updateSqlTabState,
  ]);

  useEffect(() => {
    if (!activeConn || !activeSqlDatabase.trim()) {
      return;
    }
    const key = `${activeConn.id}:${activeSqlDatabase}`;
    if (schemaByKey[key]) {
      return;
    }
    let cancelled = false;
    setSchemaLoadingKey(key);
    void introspectSchema(activeConn, activeSqlDatabase)
      .then((result) => {
        if (cancelled) {
          return;
        }
        const tables = introspectToTableSchemas(result.tables);
        setSchemaByKey((prev) => ({
          ...prev,
          [key]: buildDatabaseSchema(result.database, tables),
        }));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setSchemaLoadingKey((current) => (current === key ? null : current));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeConn, activeSqlDatabase, schemaByKey]);

  const loadTablePreview = useCallback(
    async (tabId: string, connection: DbConnectionConfig, dbName: string, tableName: string) => {
      setTablePreviews((prev) => ({
        ...prev,
        [tabId]: { loading: true, error: null, data: prev[tabId]?.data ?? null },
      }));
      try {
        const connForSchema = { ...connection, database: dbName };
        const data = await previewTable(connForSchema, tableName);
        setTablePreviews((prev) => ({
          ...prev,
          [tabId]: { loading: false, error: null, data },
        }));
      } catch (e) {
        setTablePreviews((prev) => ({
          ...prev,
          [tabId]: {
            loading: false,
            error: typeof e === "string" ? e : String(e),
            data: null,
          },
        }));
      }
    },
    [],
  );

  const handleSelectTable = useCallback(
    (selection: SchemaTableSelection) => {
      const tableKey = `tbl:${selection.connId}:${selection.dbName}:${selection.tableName}`;
      const tabId = makeTableTabId(
        selection.connId,
        selection.dbName,
        selection.tableName,
      );
      setActiveTableKey(tableKey);
      setActiveConnId(selection.connId);

      setWorkspaceTabs((prev) => {
        if (prev.some((tab) => tab.id === tabId)) {
          return prev;
        }
        return [
          ...prev,
          {
            id: tabId,
            kind: "table",
            connId: selection.connId,
            dbName: selection.dbName,
            tableName: selection.tableName,
            label: makeTableTabLabel(selection.dbName, selection.tableName),
          },
        ];
      });
      setActiveWorkspaceTabId(tabId);
      void loadTablePreview(
        tabId,
        selection.connection,
        selection.dbName,
        selection.tableName,
      );
    },
    [loadTablePreview],
  );

  const openNewSqlTab = useCallback(() => {
    const tabId = makeSqlTabId();
    const sqlTabCount = workspaceTabs.filter((tab) => tab.kind === "sql").length + 1;
    const tab: SqlWorkspaceTab = {
      id: tabId,
      kind: "sql",
      label: makeSqlTabLabel(sqlTabCount),
    };
    const presetDb = activeConn?.database.trim() ?? "";
    setSqlTabStates((prev) => ({
      ...prev,
      [tabId]: createDefaultSqlTabState(presetDb),
    }));
    setWorkspaceTabs((prev) => [...prev, tab]);
    setActiveWorkspaceTabId(tabId);
  }, [activeConn?.database, workspaceTabs]);

  const closeWorkspaceTab = useCallback((tabId: string) => {
    setWorkspaceTabs((prev) => {
      const idx = prev.findIndex((tab) => tab.id === tabId);
      const closing = prev.find((tab) => tab.id === tabId);
      if (closing?.kind === "table") {
        const key = `tbl:${closing.connId}:${closing.dbName}:${closing.tableName}`;
        setActiveTableKey((current) => (current === key ? null : current));
      }
      const next = prev.filter((tab) => tab.id !== tabId);
      setActiveWorkspaceTabId((current) => {
        if (current !== tabId) {
          return current;
        }
        const fallback = next[Math.min(idx, Math.max(0, next.length - 1))];
        return fallback?.id ?? "";
      });
      return next;
    });
    setSqlTabStates((prev) => {
      if (!(tabId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setTablePreviews((prev) => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  }, []);

  const handleCreateGroup = useCallback(async () => {
    const name = await quickInput({
      title: t("database.groups.createTitle"),
      subtitle: t("database.groups.nameLabel"),
      placeholder: t("database.groups.namePlaceholder"),
      validate: (value) => {
        if (!value.trim()) {
          return t("database.groups.nameRequired");
        }
        if (groups.some((group) => group.name === value.trim())) {
          return t("database.groups.duplicate");
        }
        return null;
      },
    });
    if (name) {
      addGroup(name);
    }
  }, [addGroup, groups, t]);

  const topbarTabs = useMemo(
    () =>
      groups.map((group) => ({
        id: group.id,
        label: group.name,
        active: group.id === activeGroupId,
      })),
    [groups, activeGroupId],
  );

  useTopbarTabs(
    topbarTabs,
    {
      onSelect: (id) => setActiveGroupId(id),
      onAdd: () => void handleCreateGroup(),
    },
    { mode: "connection", showAddTab: true, addTabTitle: t("database.groups.new") },
  );

  const runQuery = useCallback(async () => {
    if (activeWorkspaceTab?.kind !== "sql") {
      return;
    }
    const tabId = activeWorkspaceTab.id;
    const tabState = sqlTabStates[tabId] ?? createDefaultSqlTabState();
    const conn = connectionForSql;
    if (!conn) {
      updateSqlTabState(tabId, { error: t("database.results.noConnection") });
      return;
    }
    if (!tabState.database.trim()) {
      updateSqlTabState(tabId, { error: t("database.workspace.selectDatabase") });
      return;
    }
    updateSqlTabState(tabId, { running: true, error: null });
    enqueueAction({
      type: "sql",
      title: t("database.actions.runQuery"),
      description: `${conn.name} · ${t("database.actions.runQueryDesc")}`,
      command: tabState.sql,
      resourceId: conn.id,
      source: "用户",
    });
    const started = performance.now();
    try {
      const res = await invoke<QueryResult>("db_execute_query", {
        connection: conn,
        sql: tabState.sql,
      });
      updateSqlTabState(tabId, {
        result: res,
        elapsed: Math.round(performance.now() - started),
        running: false,
      });
    } catch (e) {
      updateSqlTabState(tabId, {
        result: null,
        error: typeof e === "string" ? e : JSON.stringify(e),
        running: false,
      });
    }
  }, [
    connectionForSql,
    activeWorkspaceTab,
    enqueueAction,
    sqlTabStates,
    t,
    updateSqlTabState,
  ]);

  const renderSqlPane = (tab: SqlWorkspaceTab) => {
    const tabState = sqlTabStates[tab.id] ?? createDefaultSqlTabState();
    const rowCount = tabState.result?.rows.length ?? 0;

    const schemaKey =
      activeConn && tabState.database.trim()
        ? `${activeConn.id}:${tabState.database}`
        : null;
    const schemaLoading = schemaKey !== null && schemaLoadingKey === schemaKey;

    return (
      <div className="db-workspace-pane db-workspace-pane--sql">
        <DockLayout direction="vertical" className="db-sql-split">
          <DockPanel defaultSize={55} minSize={160}>
            <div className="db-editor-area">
              <div className="sql-toolbar">
                <select
                  className="db-select"
                  value={activeConn?.id ?? ""}
                  onChange={(event) => setActiveConnId(event.target.value || null)}
                  disabled={groupConnections.length === 0}
                  title={t("database.workspace.connection")}
                >
                  {groupConnections.length === 0 ? (
                    <option value="">{t("database.results.noConnection")}</option>
                  ) : (
                    groupConnections.map((conn) => (
                      <option key={conn.id} value={conn.id}>
                        {conn.name}
                      </option>
                    ))
                  )}
                </select>
                <select
                  className="db-select"
                  value={tabState.database}
                  onChange={(event) =>
                    updateSqlTabState(tab.id, { database: event.target.value })
                  }
                  disabled={!activeConn || databasesForActiveConn.length === 0}
                  title={t("database.workspace.database")}
                >
                  {!activeConn || databasesForActiveConn.length === 0 ? (
                    <option value="">{t("database.workspace.noDatabase")}</option>
                  ) : (
                    databasesForActiveConn.map((dbName) => (
                      <option key={dbName} value={dbName}>
                        {dbName}
                      </option>
                    ))
                  )}
                </select>
                {schemaLoading && (
                  <span className="sql-toolbar-meta">{t("common.loading")}</span>
                )}
                <button
                  className="btn btn-primary btn-sm"
                  style={{ marginLeft: "auto" }}
                  onClick={runQuery}
                  disabled={
                    tabState.running || !connectionForSql || !tabState.database.trim()
                  }
                >
                  {tabState.running ? t("database.running") : t("database.runSql")}
                </button>
              </div>
              <SqlEditor
                value={tabState.sql}
                onChange={(value) => updateSqlTabState(tab.id, { sql: value })}
                onRun={runQuery}
                schemas={sqlCompletionSchemas}
              />
            </div>
          </DockPanel>
          <DockHandle direction="vertical" />
          <DockPanel defaultSize={45} minSize={120} className="dock-panel-bottom">
            <div className="results-area db-sql-results">
              <div className="results-header">
                <h3>{t("database.results.preview")}</h3>
                <span className="results-meta">
                  {t("database.results.meta", {
                    rows: rowCount,
                    ms: tabState.elapsed ?? 0,
                    mode: t("common.readonly"),
                  })}
                </span>
              </div>
              {tabState.error ? (
                <div
                  className="empty-state compact text-danger"
                  style={{ padding: "var(--sp-4)", whiteSpace: "pre-wrap" }}
                >
                  {tabState.error}
                </div>
              ) : tabState.result === null ? (
                <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
                  {t("database.results.runHint")}
                </div>
              ) : tabState.result.columns.length === 0 ? (
                <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
                  {t("database.results.affected", { rows: tabState.result.rowsAffected })}
                </div>
              ) : (
                <div className="results-grid">
                  <table>
                    <thead>
                      <tr>
                        {tabState.result.columns.map((col) => (
                          <th key={col}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tabState.result.rows.map((row, ri) => (
                        <tr key={ri}>
                          {row.map((cell, ci) => (
                            <td key={ci}>{cellToText(cell)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="exec-stats">
                <span className="stat">
                  {t("database.results.title")}: <span className="stat-val">{rowCount}</span>
                </span>
                <span className="stat">
                  Latency: <span className="stat-val">{tabState.elapsed ?? 0}ms</span>
                </span>
              </div>
            </div>
          </DockPanel>
        </DockLayout>
      </div>
    );
  };

  const renderTablePane = (tab: Extract<DatabaseWorkspaceTab, { kind: "table" }>) => {
    const preview = tablePreviews[tab.id];
    const rowTotal = preview?.data?.rows.length ?? 0;

    return (
      <div className="db-workspace-pane db-workspace-pane--table">
        <div className="results-area">
          <div className="results-header">
            <h3>{tab.label}</h3>
            <span className="results-meta">
              {preview?.loading
                ? t("common.loading")
                : t("database.results.meta", {
                    rows: rowTotal,
                    ms: 0,
                    mode: t("common.readonly"),
                  })}
            </span>
          </div>
          {preview?.error ? (
            <div
              className="empty-state compact text-danger"
              style={{ padding: "var(--sp-4)", whiteSpace: "pre-wrap" }}
            >
              {preview.error}
            </div>
          ) : preview?.loading ? (
            <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
              {t("common.loading")}
            </div>
          ) : preview?.data ? (
            <TableDataGrid columns={preview.data.columns} rows={preview.data.rows} />
          ) : (
            <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
              {t("database.results.runHint")}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <DockWorkspace
        leftPreset="schema"
        leftMinPx={280}
        left={
          <SchemaBrowser
            onCreateConnection={() => setDialogOpen(true)}
            onNewQuery={openNewSqlTab}
            onSelectTable={handleSelectTable}
            activeTableKey={activeTableKey}
            refreshToken={schemaRefreshToken}
            groupFilter={activeGroupName}
          />
        }
        main={
          <div className="db-workspace">
            <div className="db-workspace-tabs" role="tablist">
              {workspaceTabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`db-workspace-tab${activeWorkspaceTabId === tab.id ? " active" : ""}`}
                  role="tab"
                  aria-selected={activeWorkspaceTabId === tab.id}
                >
                  <button
                    type="button"
                    className="db-workspace-tab-label"
                    onClick={() => setActiveWorkspaceTabId(tab.id)}
                  >
                    {tab.label}
                  </button>
                  <button
                    type="button"
                    className="db-workspace-tab-close"
                    title={t("shell.topbar.close")}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeWorkspaceTab(tab.id);
                    }}
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      width="12"
                      height="12"
                    >
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
            <div className="db-workspace-body">
              {!activeWorkspaceTab ? (
                <div className="empty-state" style={{ padding: "var(--sp-6)" }}>
                  {t("database.workspace.emptyTabs")}
                </div>
              ) : activeWorkspaceTab.kind === "sql" ? (
                renderSqlPane(activeWorkspaceTab)
              ) : (
                renderTablePane(activeWorkspaceTab)
              )}
            </div>
          </div>
        }
      />
      <ConnectionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={() => setSchemaRefreshToken((token) => token + 1)}
        defaultGroup={activeGroupName}
        groups={groups}
      />
    </>
  );
}
