import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { DockLayout, DockHandle, DockPanel, DockWorkspace } from "../../components/dock";
import { SchemaBrowser, type SchemaTableSelection } from "./SchemaBrowser";
import { ConnectionDialog } from "./ConnectionDialog";
import { TableDataGrid } from "./TableDataGrid";
import { TabContextMenu } from "../../components/shell/TabContextMenu";
import { useActionStore } from "../../stores/actionStore";
import { useDbGroupStore } from "../../stores/dbGroupStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";
import { quickInput } from "../../lib/quickInput";
import { SqlEditor } from "./SqlEditor";
import {
  connectionMatchesGroup,
  countTable,
  introspectSchema,
  introspectTable,
  listConnections,
  listDatabases,
  previewTable,
  type DbColumnMeta,
  type DbConnectionConfig,
  type TablePreviewResult,
} from "./api";
import { buildDatabaseSchema, introspectToTableSchemas } from "./lsp/sqlCompletion";
import type { DatabaseSchema } from "./types";
import {
  makeSqlTabId,
  makeSqlTabLabel,
  makeTableTabLabel,
  type SqlWorkspaceTab,
} from "./workspaceTabs";
import { CellEditorDialog } from "./cell_editor";

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
  totalRows: number;
  page: number;
  pageSize: number;
  connId?: string;
  dbName?: string;
  tableName?: string;
};

const DEFAULT_PAGE_SIZE = 100;

function createDefaultTablePreviewState(): TablePreviewState {
  return { loading: false, error: null, data: null, totalRows: 0, page: 0, pageSize: DEFAULT_PAGE_SIZE };
}

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

function rowsToRecord(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i]] = row[i];
    }
    return obj;
  });
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

  const [workspaceTabs, setWorkspaceTabs] = useState<SqlWorkspaceTab[]>([INITIAL_SQL_TAB]);
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] = useState(INITIAL_SQL_TAB_ID);
  const [tablePreviews, setTablePreviews] = useState<Record<string, TablePreviewState>>({});
  const [activeTableKey, setActiveTableKey] = useState<string | null>(null);
  const [tableColumnMeta, setTableColumnMeta] = useState<Record<string, DbColumnMeta[]>>({});
  const [tabModes, setTabModes] = useState<Record<string, "data" | "sql">>({});
  const [databasesByConnId, setDatabasesByConnId] = useState<Record<string, string[]>>({});
  const [schemaByKey, setSchemaByKey] = useState<Record<string, DatabaseSchema>>({});
  const [schemaLoadingKey, setSchemaLoadingKey] = useState<string | null>(null);
  const [cellEdit, setCellEdit] = useState<{
    tabId: string;
    column: string;
    row: Record<string, unknown>;
  } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabId: string; index: number } | null>(null);

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
      const connForSchema = { ...connection, database: dbName };
      const defaultState = createDefaultTablePreviewState();
      const prev = defaultState;

      // 1) 查询总数
      setTablePreviews((prevMap) => ({
        ...prevMap,
        [tabId]: { ...(prevMap[tabId] ?? defaultState), loading: true, error: null },
      }));
      let totalRows = 0;
      try {
        totalRows = await countTable(connForSchema, tableName);
      } catch (e) {
        setTablePreviews((prevMap) => ({
          ...prevMap,
          [tabId]: {
            ...(prevMap[tabId] ?? defaultState),
            loading: false,
            error: typeof e === "string" ? e : String(e),
          },
        }));
        return;
      }

      // 2) 查询当前页数据
      const pageSize = prev.pageSize;
      try {
        const data = await previewTable(connForSchema, tableName, pageSize, 0);
        setTablePreviews((prevMap) => ({
          ...prevMap,
          [tabId]: { ...(prevMap[tabId] ?? defaultState), loading: false, error: null, data, totalRows, page: 0, pageSize },
        }));
      } catch (e) {
        setTablePreviews((prevMap) => ({
          ...prevMap,
          [tabId]: {
            ...(prevMap[tabId] ?? defaultState),
            loading: false,
            error: typeof e === "string" ? e : String(e),
          },
        }));
      }
    },
    [],
  );

  const refreshTablePreview = useCallback(
    (tabId: string, connId: string, dbName: string, tableName: string) => {
      const connection = connections.find((c) => c.id === connId);
      if (!connection) return;
      const connForSchema = { ...connection, database: dbName };

      setTablePreviews((prev) => {
        const existing = prev[tabId] ?? createDefaultTablePreviewState();
        const pageSize = existing.pageSize;
        const page = existing.page;

        Promise.all([
          countTable(connForSchema, tableName),
          previewTable(connForSchema, tableName, pageSize, page * pageSize),
        ])
          .then(([totalRows, data]) => {
            setTablePreviews((p) => {
              const cur = p[tabId];
              if (!cur) return p;
              return { ...p, [tabId]: { ...cur, loading: false, error: null, data, totalRows } };
            });
          })
          .catch((e) => {
            setTablePreviews((p) => {
              const cur = p[tabId];
              if (!cur) return p;
              return { ...p, [tabId]: { ...cur, loading: false, error: typeof e === "string" ? e : String(e) } };
            });
          });

        return { ...prev, [tabId]: { ...existing, loading: true } };
      });
    },
    [connections],
  );

  const goToPage = useCallback(
    (tabId: string, connId: string, dbName: string, tableName: string, page: number) => {
      const connection = connections.find((c) => c.id === connId);
      if (!connection) return;
      const connForSchema = { ...connection, database: dbName };
      setTablePreviews((prev) => {
        const existing = prev[tabId] ?? createDefaultTablePreviewState();
        const pageSize = existing.pageSize;

        previewTable(connForSchema, tableName, pageSize, page * pageSize)
          .then((data) => {
            setTablePreviews((p) => {
              const cur = p[tabId];
              if (!cur) return p;
              return { ...p, [tabId]: { ...cur, loading: false, data, page } };
            });
          })
          .catch((e) => {
            setTablePreviews((p) => {
              const cur = p[tabId];
              if (!cur) return p;
              return { ...p, [tabId]: { ...cur, loading: false, error: typeof e === "string" ? e : String(e) } };
            });
          });

        return { ...prev, [tabId]: { ...existing, loading: true } };
      });
    },
    [connections],
  );

  const handleCellEdit = useCallback(
    (tabId: string, cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> }) => {
      setCellEdit({ tabId, column: cellInfo.column, row: cellInfo.row });
    },
    [],
  );

  const handleCellSave = useCallback(
    async (value: unknown) => {
      if (!cellEdit) return;
      const { tabId, column, row } = cellEdit;
      const preview = tablePreviews[tabId];
      if (!preview || !preview.connId || !preview.dbName || !preview.tableName) {
        setCellEdit(null);
        return;
      }
      const connection = connections.find((c) => c.id === preview.connId);
      if (!connection) {
        setCellEdit(null);
        return;
      }
      const colMeta = tableColumnMeta[tabId];
      if (!colMeta) {
        setCellEdit(null);
        return;
      }
      // Build PK WHERE clause
      const pkCols = colMeta.filter((c) => c.isPk);
      if (pkCols.length === 0) {
        setCellEdit(null);
        return;
      }
      const pkConditions = pkCols
        .map((pk) => {
          const val = row[pk.name];
          if (val === null || val === undefined) return `${pk.name} IS NULL`;
          if (typeof val === "number") return `${pk.name} = ${val}`;
          return `${pk.name} = '${String(val).replace(/'/g, "\\'")}'`;
        })
        .join(" AND ");

      const connForSchema = { ...connection, database: preview.dbName };
      const escapedValue =
        typeof value === "number"
          ? String(value)
          : value === null
            ? "NULL"
            : `'${String(value).replace(/'/g, "\\'")}'`;

      const sql = `UPDATE \`${preview.tableName}\` SET \`${column}\` = ${escapedValue} WHERE ${pkConditions} LIMIT 1`;

      try {
        await invoke("db_execute_query", { connection: connForSchema, sql });
        setCellEdit(null);
        // Refresh preview
        refreshTablePreview(tabId, preview.connId, preview.dbName, preview.tableName);
      } catch (e) {
        console.error("Cell update failed:", e);
        setCellEdit(null);
      }
    },
    [cellEdit, tablePreviews, connections, tableColumnMeta, refreshTablePreview],
  );

  const handleSelectTable = useCallback(
    (selection: SchemaTableSelection) => {
      const tableKey = `tbl:${selection.connId}:${selection.dbName}:${selection.tableName}`;
      const tabId = makeSqlTabId();
      setActiveTableKey(tableKey);
      setActiveConnId(selection.connId);

      // Create a SQL tab with collapsed editor for table preview
      setWorkspaceTabs((prev) => {
        const tab: SqlWorkspaceTab = {
          id: tabId,
          kind: "sql",
          label: makeTableTabLabel(selection.dbName, selection.tableName),
        };
        return [...prev, tab];
      });
      setActiveWorkspaceTabId(tabId);
      setTabModes((prev) => ({ ...prev, [tabId]: "data" }));

      // Set the database for the SQL tab
      setSqlTabStates((prev) => ({
        ...prev,
        [tabId]: { ...createDefaultSqlTabState(selection.dbName), sql: `SELECT * FROM \`${selection.tableName}\` LIMIT 100;` },
      }));

      // Initialize preview metadata (before loadTablePreview's async updates)
      setTablePreviews((prev) => ({
        ...prev,
        [tabId]: { ...createDefaultTablePreviewState(), loading: true, connId: selection.connId, dbName: selection.dbName, tableName: selection.tableName },
      }));

      void loadTablePreview(
        tabId,
        selection.connection,
        selection.dbName,
        selection.tableName,
      );
      // Fetch column metadata for cell editing
      void introspectTable(selection.connection, selection.dbName, selection.tableName)
        .then((schema) => {
          setTableColumnMeta((prev) => ({ ...prev, [tabId]: schema.columns }));
        })
        .catch(() => {});
    },
    [loadTablePreview],
  );

  const openNewSqlTab = useCallback(() => {
    const tabId = makeSqlTabId();
    const sqlTabCount = workspaceTabs.length + 1;
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
    setTabModes((prev) => ({ ...prev, [tabId]: "sql" }));
  }, [activeConn?.database, workspaceTabs]);

  const closeWorkspaceTab = useCallback((tabId: string) => {
    setWorkspaceTabs((prev) => {
      const idx = prev.findIndex((tab) => tab.id === tabId);
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
    setTableColumnMeta((prev) => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setTabModes((prev) => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  }, []);

  const handleContextAction = useCallback(
    (action: "close" | "closeLeft" | "closeRight" | "closeOthers" | "closeAll") => {
      if (!ctxMenu) return;
      const idx = ctxMenu.index;
      const tabList = workspaceTabs;

      if (action === "close") {
        closeWorkspaceTab(ctxMenu.tabId);
      } else if (action === "closeLeft") {
        for (let i = idx - 1; i >= 0; i--) closeWorkspaceTab(tabList[i].id);
      } else if (action === "closeRight") {
        for (let i = tabList.length - 1; i > idx; i--) closeWorkspaceTab(tabList[i].id);
      } else if (action === "closeOthers") {
        for (let i = tabList.length - 1; i >= 0; i--) {
          if (i !== idx) closeWorkspaceTab(tabList[i].id);
        }
      } else if (action === "closeAll") {
        for (let i = tabList.length - 1; i >= 0; i--) closeWorkspaceTab(tabList[i].id);
      }
      setCtxMenu(null);
    },
    [ctxMenu, workspaceTabs, closeWorkspaceTab],
  );

  useEffect(() => {
    if (!ctxMenu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [ctxMenu]);

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
    const preview = tablePreviews[tab.id];
    const colMeta = tableColumnMeta[tab.id];
    const mode = tabModes[tab.id] ?? "sql";

    const schemaKey =
      activeConn && tabState.database.trim()
        ? `${activeConn.id}:${tabState.database}`
        : null;
    const schemaLoading = schemaKey !== null && schemaLoadingKey === schemaKey;

    const resultRows = tabState.result ? rowsToRecord(tabState.result.columns, tabState.result.rows) : [];
    const rowCount = resultRows.length;

    const canRefresh = preview?.connId && preview?.dbName && preview?.tableName;
    const isPreviewTab = !!(preview?.connId);

    const editorContent = (
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
    );

    const resultsContent = (
      <div className="results-area db-sql-results">
        <div className="results-header">
          <h3>{isPreviewTab ? tab.label : t("database.results.preview")}</h3>
          {isPreviewTab && canRefresh && (
            <button
              type="button"
              className="btn-icon"
              style={{ marginLeft: "var(--sp-2)" }}
              title="Refresh"
              disabled={preview!.loading}
              onClick={() => refreshTablePreview(tab.id, preview!.connId!, preview!.dbName!, preview!.tableName!)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <path d="M23 4v6h-6M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
              </svg>
            </button>
          )}
          {isPreviewTab && preview?.data && !preview.loading && canRefresh && (
            <span className="results-meta" style={{ marginLeft: "var(--sp-2)" }}>
              {preview!.page * preview!.pageSize + 1}–
              {Math.min((preview!.page + 1) * preview!.pageSize, preview!.totalRows)}
              {" / "}
              {preview!.totalRows.toLocaleString()}
            </span>
          )}
          {!isPreviewTab && (
            <span className="results-meta">
              {t("database.results.meta", {
                rows: rowCount,
                ms: tabState.elapsed ?? 0,
                mode: t("common.readonly"),
              })}
            </span>
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
              onCellEdit={(cellInfo) => handleCellEdit(tab.id, cellInfo)}
              onPageChange={(page) => goToPage(tab.id, preview.connId!, preview.dbName!, preview.tableName!, page)}
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

    // SQL mode — show editor full height unless there are results
    if (!tabState.result) {
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
              {workspaceTabs.map((tab, idx) => (
                <div
                  key={tab.id}
                  className={`db-workspace-tab${activeWorkspaceTabId === tab.id ? " active" : ""}`}
                  role="tab"
                  aria-selected={activeWorkspaceTabId === tab.id}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id, index: idx });
                  }}
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
              ) : (
                renderSqlPane(activeWorkspaceTab)
              )}
            </div>
          </div>
        }
      />
      {ctxMenu && createPortal(
        <TabContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          tabCount={workspaceTabs.length}
          tabIndex={ctxMenu.index}
          onClose={handleContextAction}
          onDismiss={() => setCtxMenu(null)}
        />,
        document.body,
      )}
      <ConnectionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={() => setSchemaRefreshToken((token) => token + 1)}
        defaultGroup={activeGroupName}
        groups={groups}
      />
      {cellEdit && (() => {
        const colMeta = tableColumnMeta[cellEdit.tabId]?.find((c) => c.name === cellEdit.column);
        return (
          <CellEditorDialog
            open
            columnName={cellEdit.column}
            columnType={colMeta?.type ?? "text"}
            currentValue={cellEdit.row[cellEdit.column]}
            onSave={handleCellSave}
            onCancel={() => setCellEdit(null)}
          />
        );
      })()}
    </>
  );
}
