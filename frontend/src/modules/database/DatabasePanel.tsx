import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { SidebarWorkspace } from "../../components/ui/SidebarWorkspace";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { WorkspaceEmptyPage } from "../../components/ui/WorkspaceEmptyPage";
import { SchemaBrowser, type SchemaDatabaseSelection, type SchemaTableSelection } from "./SchemaBrowser";
import { DatabaseTablesPanel } from "./DatabaseTablesPanel";
import { ConnectionDialog } from "./ConnectionDialog";
import { ContextMenu } from "../../components/ui/ContextMenu";
import { FormDialog } from "../../components/ui/FormDialog";
import { Select } from "../../components/ui/Select";
import { buildTabCloseMenuItems, type TabContextMenuAction } from "../../components/ui/contextMenuItems";
import { useActionStore } from "../../stores/actionStore";
import { useDbGroupStore } from "../../stores/dbGroupStore";
import { useDbSchemaFilterStore } from "../../stores/dbSchemaFilterStore";
import { useDbSchemaTreeExpandedStore } from "../../stores/dbSchemaTreeExpandedStore";
import { useDbSchemaCacheStore } from "../../stores/dbSchemaCacheStore";
import { getVisibleNames, mergeFilter } from "./DatabaseFilterDialog";
import { useI18n } from "../../i18n";
import { quickInput } from "../../lib/quickInput";
import { isSqlMonacoEditorFocused, sqlAtOffset } from "./lsp/sqlStatement";
import {
  connectionMatchesGroup,
  normalizeConnectionGroup,
  countTable,
  createDatabase,
  fetchTableDdl,
  introspectTable,
  listConnections,
  MYSQL_CHARSET_PRESETS,
  previewTable,
  saveConnection,
  isConnectionEnabled,
  type DbColumnMeta,
  type DbConnectionConfig,
} from "./api";
import { buildDatabaseSchema, introspectToTableSchemas } from "./lsp/sqlCompletion";
import { toCsv } from "./csvExport";
import { buildRedisColumnMeta, buildRedisUpdateCommands } from "./redisTableMeta";
import { getCachedDatabaseNames } from "./schemaCacheMerge";
import { refreshConnectionSchemaCache } from "./schemaCacheRefresh";
import type { DatabaseSchema } from "./types";
import {
  makeSqlTabId,
  makeSqlTabLabel,
  makeDatabaseTabId,
  makeDatabaseTabKey,
  findTabIdForDatabase,
  makeTableTabLabel,
  makeTableTabKey,
  findTabIdForTable,
  isSqlWorkspaceTab,
  type DatabaseListWorkspaceTab,
  type DbWorkspaceTab,
  type SqlWorkspaceTab,
} from "./workspaceTabs";
import { CellEditorDialog } from "./cell_editor";
import { DatabaseToolbox } from "./toolbox/DatabaseToolbox";
import {
  createDefaultSqlTabState,
  createDefaultTablePreviewState,
  rowsToRecord,
  tabModeToEditorOpenMode,
  type SqlTabState,
  type TablePreviewState,
  type QueryResult,
} from "./dbWorkspaceState";
import { DbPanelSurface } from "./DbPanelSurface";
import { DockableWorkspace, ModuleSegmentDock } from "../../components/dock";
import { DbWorkspaceProvider, type DbWorkspaceContextValue } from "../../contexts/DbWorkspaceContext";
import { useDbDockLayoutStore } from "../../stores/dbDockLayoutStore";
import {
  schedulePersistWorkspaceSession,
  useDbWorkspaceSessionStore,
} from "../../stores/dbWorkspaceSessionStore";
import {
  buildWorkspaceSessionSnapshot,
  sanitizeWorkspaceSession,
  type DbSqlTabStateSnapshot,
} from "./dbWorkspaceSession";
import { useWorkspaceBottomDockStore } from "../../stores/workspaceBottomDockStore";
import { publishDbWorkspaceMirror } from "../../stores/dbWorkspaceMirrorStore";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";
import { useWorkspaceStore, onWorkspaceSwitch } from "../../stores/workspaceStore";
import { dbTabToSnapshot, buildCopyToWorkspaceMenuItems, buildMoveToWorkspaceMenuItems, addSnapshotToWorkspace } from "../../lib/workspaceTabActions";
import { useWorkspaceTabStore, type DbTabSnapshot } from "../../stores/workspaceTabStore";

const EMPTY_DOCKED_DATABASE_TABS: string[] = [];
import {
  canAcceptSchemaTreeDrop,
  parseSchemaTreeItemFromDrop,
  setActiveSchemaDragItem,
} from "./schemaTreeItem";
import {
  registerSchemaTreeDropListener,
  SCHEMA_TREE_DROP_ZONE_ATTR,
} from "./schemaTreePointerDrag";
import { logSchemaTreeDrop } from "./schemaTreeDragLog";
import { connectionNodeId } from "./schemaTreeExpanded";
import type { SchemaTreeItem } from "./schemaTreeItem";

const INITIAL_SQL_TAB_ID = makeSqlTabId();
const INITIAL_SQL_TAB: SqlWorkspaceTab = {
  id: INITIAL_SQL_TAB_ID,
  kind: "sql",
  label: makeSqlTabLabel(1),
};

type DbModuleTab = "query" | "transfer";
const DB_MODULE_TABS: DbModuleTab[] = ["query", "transfer"];

function restoreSqlTabStateFromSnapshot(snap: DbSqlTabStateSnapshot): SqlTabState {
  return {
    ...createDefaultSqlTabState(snap.database),
    sql: snap.sql,
    database: snap.database,
    cursorOffset: snap.cursorOffset,
    result: null,
    error: null,
    elapsed: null,
    running: false,
  };
}

function applyDefaultWorkspaceSession(
  setWorkspaceTabs: (tabs: DbWorkspaceTab[]) => void,
  setActiveWorkspaceTabId: (id: string) => void,
  setSqlTabStates: (states: Record<string, SqlTabState>) => void,
): void {
  setWorkspaceTabs([INITIAL_SQL_TAB]);
  setActiveWorkspaceTabId(INITIAL_SQL_TAB_ID);
  setSqlTabStates({ [INITIAL_SQL_TAB_ID]: createDefaultSqlTabState() });
}


/** 把行主键拼成的字符串（"col=val&col=val"）解析回单列值，rowKey 中空字符串表示 NULL。 */
function readRowKeyValue(rowKey: string, colName: string): string {
  for (const part of rowKey.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === colName) {
      return part.slice(eq + 1);
    }
  }
  return "";
}

interface CreateDatabaseDialogProps {
  open: boolean;
  connection: DbConnectionConfig | null;
  onCancel: () => void;
  onCreated: (name: string) => void;
}

const RESERVED_DB_NAMES = ["information_schema", "performance_schema", "mysql", "sys"];
const DB_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

function CreateDatabaseDialog({
  open,
  connection,
  onCancel,
  onCreated,
}: CreateDatabaseDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [charset, setCharset] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName("");
      setCharset("");
      setBusy(false);
      setError(null);
    }
  }, [open, connection?.id]);

  const validate = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return t("database.createDatabase.nameRequired");
    if (trimmed.length > 64) return t("database.createDatabase.nameTooLong");
    if (!DB_NAME_RE.test(trimmed)) return t("database.createDatabase.nameInvalid");
    if (RESERVED_DB_NAMES.some((r) => r.toLowerCase() === trimmed.toLowerCase())) {
      return t("database.createDatabase.nameReserved", { name: trimmed });
    }
    return null;
  };

  const handleSubmit = async () => {
    if (!connection) return;
    const trimmed = name.trim();
    const validationError = validate(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const preset = charset
        ? MYSQL_CHARSET_PRESETS.find((p) => p.value === charset)
        : null;
      const created = await createDatabase({
        connection,
        name: trimmed,
        charset: charset || null,
        collation: preset?.collation ?? null,
      });
      onCreated(created);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(t("database.createDatabase.failed", { message }));
    } finally {
      setBusy(false);
    }
  };

  const charsetOptions = [
    { value: "", label: t("database.createDatabase.charsetServerDefault") },
    ...MYSQL_CHARSET_PRESETS.map((p) => ({ value: p.value, label: p.label })),
  ];
  const preset = charset
    ? MYSQL_CHARSET_PRESETS.find((p) => p.value === charset)
    : null;

  return (
    <FormDialog
      open={open}
      onClose={busy ? () => undefined : onCancel}
      closeDisabled={busy}
      title={t("database.createDatabase.title")}
      subtitle={connection ? t("database.createDatabase.subtitle", { name: connection.name }) : undefined}
      size="sm"
      onCancel={onCancel}
      cancelDisabled={busy}
      status={error ? { kind: "error", message: error } : null}
      primaryAction={{
        label: busy ? t("database.createDatabase.creating") : t("database.createDatabase.create"),
        disabled: busy,
        onClick: () => void handleSubmit(),
      }}
    >
      <div className="form-field">
        <label className="form-label" htmlFor="create-db-name">
          {t("database.createDatabase.nameLabel")}
        </label>
        <input
          id="create-db-name"
          className="input"
          autoFocus
          placeholder={t("database.createDatabase.namePlaceholder")}
          value={name}
          disabled={busy}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          style={{ width: "100%" }}
        />
      </div>
      <div className="form-field">
        <label className="form-label" htmlFor="create-db-charset">
          {t("database.createDatabase.charsetLabel")}
        </label>
        <Select
          value={charset}
          onChange={setCharset}
          options={charsetOptions}
          size="sm"
          disabled={busy}
        />
      </div>
      {preset && (
        <div
          style={{
            fontSize: "11px",
            color: "var(--muted, #8e8e93)",
            marginTop: "-2px",
          }}
        >
          {t("database.createDatabase.collationLabel")}: <code>{preset.collation}</code>
        </div>
      )}
    </FormDialog>
  );
}

export function DatabasePanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/database";
  const [moduleTab, setModuleTab] = usePersistedModuleTab(
    "database-workspace",
    "query",
    DB_MODULE_TABS,
  );
  const enqueueAction = useActionStore((s) => s.enqueueAction);
  const groups = useDbGroupStore((s) => s.groups);
  const activeGroupId = useDbGroupStore((s) => s.activeGroupId);
  const setActiveGroupId = useDbGroupStore((s) => s.setActiveGroupId);
  const addGroup = useDbGroupStore((s) => s.addGroup);
  const getGroupName = useDbGroupStore((s) => s.getGroupName);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<DbConnectionConfig | null>(null);
  const [schemaRefreshToken, setSchemaRefreshToken] = useState(0);

  const [connections, setConnections] = useState<DbConnectionConfig[]>([]);
  const [activeConnId, setActiveConnId] = useState<string | null>(null);
  const [sqlTabStates, setSqlTabStates] = useState<Record<string, SqlTabState>>({});

  const [workspaceTabs, setWorkspaceTabs] = useState<DbWorkspaceTab[]>([]);
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] = useState("");
  const [workspaceInitialized, setWorkspaceInitialized] = useState(false);
  const tablePreviewRestoreDoneRef = useRef(false);
  const [tablePreviews, setTablePreviews] = useState<Record<string, TablePreviewState>>({});
  const [activeTableKey, setActiveTableKey] = useState<string | null>(null);
  const [tableColumnMeta, setTableColumnMeta] = useState<Record<string, DbColumnMeta[]>>({});
  const [tabModes, setTabModes] = useState<Record<string, "data" | "sql">>({});
  const [databasesByConnId, setDatabasesByConnId] = useState<Record<string, string[]>>({});
  const [schemaByKey, setSchemaByKey] = useState<Record<string, DatabaseSchema>>({});
  const [schemaLoadingKey] = useState<string | null>(null);
  const [cellEdit, setCellEdit] = useState<{
    tabId: string;
    column: string;
    row: Record<string, unknown>;
  } | null>(null);
  /** 每个 tab 的「未提交修改」：行键 -> {列名: 新值}。提交或回滚后清空对应 tab。 */
  const [tabDirtyRows, setTabDirtyRows] = useState<
    Record<string, Record<string, Record<string, unknown>>>
  >({});
  const [committingTabs, setCommittingTabs] = useState<Set<string>>(() => new Set());
  const [pendingTabAction, setPendingTabAction] = useState<
    | {
        kind: "refresh" | "page" | "close";
        tabId: string;
        page?: number;
      }
    | null
  >(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabId: string; index: number } | null>(null);
  const [tableCtxMenu, setTableCtxMenu] = useState<
    | {
        x: number;
        y: number;
        selection: SchemaTableSelection;
      }
    | null
  >(null);
  const [connCtxMenu, setConnCtxMenu] = useState<
    | {
        x: number;
        y: number;
        connId: string;
      }
    | null
  >(null);
  const updateSchemaExpanded = useDbSchemaTreeExpandedStore((s) => s.updateExpanded);
  const [createDbDialog, setCreateDbDialog] = useState<
    | {
        connId: string;
      }
    | null
  >(null);
  const dockLayout = useDbDockLayoutStore((s) => s.savedLayout);
  const setDockLayout = useDbDockLayoutStore((s) => s.setSavedLayout);
  const isOriginDocked = useWorkspaceBottomDockStore((s) => s.isOriginDocked);
  const referencedDatabaseTabIds = useWorkspaceBottomDockStore((s) => {
    const ids = new Set<string>(s.dockedOriginByScope.database ?? []);
    for (const tabs of Object.values(s.tabsByWorkspace)) {
      for (const tab of tabs ?? []) {
        if (tab.kind === "payload" && tab.payload?.module === "database") {
          ids.add(tab.payload.id);
        }
      }
    }
    return ids.size > 0 ? [...ids] : EMPTY_DOCKED_DATABASE_TABS;
  });
  const allWorkspaces = useWorkspaceStore((s) => s.workspaces);
  const currentWorkspaceId = useWorkspaceStore((s) => s.workspace.id);
  const wsTabStore = useWorkspaceTabStore;

  // Refs for workspace switch (access current state from event listener)
  const workspaceTabsRef = useRef(workspaceTabs);
  workspaceTabsRef.current = workspaceTabs;
  const tabModesRef = useRef(tabModes);
  tabModesRef.current = tabModes;

  // 工作区切换时：保存当前数据库 tab 快照 → 恢复目标工作区的快照
  useEffect(() => {
    return onWorkspaceSwitch(({ prevWorkspaceId, nextWorkspaceId }) => {
      const wsTabStoreState = wsTabStore.getState();

      // 保存当前数据库 tabs 到旧工作区
      const currentTabs = workspaceTabsRef.current;
      const currentTabModes = tabModesRef.current;
      const dbSnapshots = currentTabs.map((tab) => dbTabToSnapshot(tab, currentTabModes[tab.id]));
      // 合并到已有快照（保留 terminal/docker 快照）
      const existing = wsTabStoreState.getTabs(prevWorkspaceId).filter(
        (s) => s.module !== "database",
      );
      wsTabStoreState.saveTabs(prevWorkspaceId, [...existing, ...dbSnapshots]);

      // 恢复目标工作区的数据库 tabs
      const targetDbSnapshots = wsTabStoreState.getTabs(nextWorkspaceId).filter(
        (s): s is DbTabSnapshot => s.module === "database",
      );
      // 通过全局事件通知 DatabasePanel 恢复 tabs
      window.dispatchEvent(
        new CustomEvent("omnipanel:db-restore-tabs", {
          detail: { snapshots: targetDbSnapshots },
        }),
      );
    });
  }, []);

  // 监听数据库 tab 恢复事件
  useEffect(() => {
    const handler = (e: Event) => {
      const { snapshots } = (e as CustomEvent<{ snapshots: DbTabSnapshot[] }>).detail;
      // 目标工作区没有保存过数据库快照 → 保留当前 tab（新工作区继承）
      if (!snapshots || snapshots.length === 0) return;
      const restoredTabs: DbWorkspaceTab[] = snapshots.map((s) => s.tab);
      const restoredTabModes: Record<string, "data" | "sql"> = {};
      for (const s of snapshots) {
        if (s.tabMode) restoredTabModes[s.id] = s.tabMode;
      }
      setWorkspaceTabs(restoredTabs);
      setTabModes((prev) => ({ ...prev, ...restoredTabModes }));
      setActiveWorkspaceTabId(restoredTabs[0]?.id ?? "");
    };
    window.addEventListener("omnipanel:db-restore-tabs", handler);
    return () => window.removeEventListener("omnipanel:db-restore-tabs", handler);
  }, []);

  const activeGroupNameFromStore = useMemo(
    () => getGroupName(activeGroupId),
    [activeGroupId, getGroupName],
  );

  const groupConnections = useMemo(
    () => connections.filter((conn) => connectionMatchesGroup(conn, activeGroupNameFromStore)),
    [connections, activeGroupNameFromStore],
  );

  const activeConn = useMemo(
    () => groupConnections.find((c) => c.id === activeConnId) ?? groupConnections[0] ?? null,
    [groupConnections, activeConnId],
  );

  const moduleSegmentTabs = useMemo(
    () => [
      { id: "query", label: t("database.tabs.query") },
      { id: "transfer", label: t("database.tabs.transfer") },
    ],
    [t],
  );

  const activeGroupName = useMemo(
    () =>
      activeConn
        ? normalizeConnectionGroup(activeConn.group)
        : activeGroupNameFromStore,
    [activeConn, activeGroupNameFromStore],
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
        const pickEnabled = (items: DbConnectionConfig[]) =>
          items.find((item) => isConnectionEnabled(item));
        if (prev) {
          const current = list.find((item) => item.id === prev);
          if (current && isConnectionEnabled(current)) {
            return prev;
          }
        }
        const inGroup = list.find(
          (item) => connectionMatchesGroup(item, activeGroupName) && isConnectionEnabled(item),
        );
        return inGroup?.id ?? pickEnabled(list)?.id ?? null;
      });
    } catch {
      // 非 Tauri 环境（纯前端 dev）忽略。
    }
  }, [activeGroupName]);

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections, schemaRefreshToken]);

  useEffect(() => {
    const bootstrapWorkspace = () => {
      const session = sanitizeWorkspaceSession(useDbWorkspaceSessionStore.getState().session);
      if (!session) {
        applyDefaultWorkspaceSession(setWorkspaceTabs, setActiveWorkspaceTabId, setSqlTabStates);
        setWorkspaceInitialized(true);
        return;
      }

      setWorkspaceTabs(session.tabs);
      setActiveWorkspaceTabId(session.activeTabId);

      const restoredSql: Record<string, SqlTabState> = {};
      for (const tab of session.tabs) {
        if (tab.kind !== "sql") {
          continue;
        }
        const snap = session.sqlTabStates[tab.id];
        restoredSql[tab.id] = snap
          ? restoreSqlTabStateFromSnapshot(snap)
          : createDefaultSqlTabState();
      }
      setSqlTabStates(restoredSql);

      const restoredPreviews: Record<string, TablePreviewState> = {};
      for (const [tabId, meta] of Object.entries(session.tablePreviewMeta)) {
        restoredPreviews[tabId] = {
          ...createDefaultTablePreviewState(),
          loading: true,
          connId: meta.connId,
          dbName: meta.dbName,
          tableName: meta.tableName,
          page: meta.page,
          pageSize: meta.pageSize,
        };
      }
      setTablePreviews(restoredPreviews);
      setTabModes(session.tabModes);

      const activeTab = session.tabs.find((tab) => tab.id === session.activeTabId);
      if (activeTab?.kind === "database") {
        setActiveConnId(activeTab.connId);
      } else {
        const activeMeta = session.tablePreviewMeta[session.activeTabId];
        if (activeMeta) {
          setActiveConnId(activeMeta.connId);
          setActiveTableKey(
            makeTableTabKey(activeMeta.connId, activeMeta.dbName, activeMeta.tableName),
          );
        }
      }

      setWorkspaceInitialized(true);
    };

    if (useDbWorkspaceSessionStore.persist.hasHydrated()) {
      bootstrapWorkspace();
      return;
    }

    return useDbWorkspaceSessionStore.persist.onFinishHydration(bootstrapWorkspace);
  }, []);

  useEffect(() => {
    if (!workspaceInitialized) {
      return;
    }
    if (workspaceTabs.length === 0) {
      schedulePersistWorkspaceSession(null);
      return;
    }
    schedulePersistWorkspaceSession(
      buildWorkspaceSessionSnapshot({
        tabs: workspaceTabs,
        activeTabId: activeWorkspaceTabId,
        sqlTabStates,
        tablePreviews,
        tabModes,
      }),
    );
  }, [
    workspaceInitialized,
    workspaceTabs,
    activeWorkspaceTabId,
    sqlTabStates,
    tablePreviews,
    tabModes,
  ]);

  useEffect(() => {
    if (!workspaceInitialized || connections.length === 0 || tablePreviewRestoreDoneRef.current) {
      return;
    }

    const session = sanitizeWorkspaceSession(useDbWorkspaceSessionStore.getState().session);
    if (!session?.tablePreviewMeta || Object.keys(session.tablePreviewMeta).length === 0) {
      tablePreviewRestoreDoneRef.current = true;
      return;
    }

    tablePreviewRestoreDoneRef.current = true;

    for (const [tabId, meta] of Object.entries(session.tablePreviewMeta)) {
      const connection = connections.find((item) => item.id === meta.connId);
      if (!connection) {
        setTablePreviews((prev) => ({
          ...prev,
          [tabId]: {
            ...(prev[tabId] ?? createDefaultTablePreviewState()),
            loading: false,
            error: "Connection not found",
            connId: meta.connId,
            dbName: meta.dbName,
            tableName: meta.tableName,
            page: meta.page,
            pageSize: meta.pageSize,
          },
        }));
        continue;
      }

      const connForSchema = { ...connection, database: meta.dbName };
      void introspectTable(connection, meta.dbName, meta.tableName)
        .then((schema) => {
          if (connection.db_type !== "redis") {
            setTableColumnMeta((prev) => ({ ...prev, [tabId]: schema.columns }));
          }
        })
        .catch(() => {});

      void Promise.all([
        countTable(connForSchema, meta.tableName, meta.dbName),
        previewTable(connForSchema, meta.tableName, meta.pageSize, meta.page * meta.pageSize),
      ])
        .then(([totalRows, data]) => {
          if (connection.db_type === "redis") {
            setTableColumnMeta((prev) => ({
              ...prev,
              [tabId]: buildRedisColumnMeta(data.columns),
            }));
          }
          setTablePreviews((prev) => ({
            ...prev,
            [tabId]: {
              ...(prev[tabId] ?? createDefaultTablePreviewState()),
              loading: false,
              error: null,
              data,
              totalRows,
              page: meta.page,
              pageSize: meta.pageSize,
              connId: meta.connId,
              dbName: meta.dbName,
              tableName: meta.tableName,
            },
          }));
        })
        .catch((error) => {
          setTablePreviews((prev) => ({
            ...prev,
            [tabId]: {
              ...(prev[tabId] ?? createDefaultTablePreviewState()),
              loading: false,
              error: typeof error === "string" ? error : String(error),
              connId: meta.connId,
              dbName: meta.dbName,
              tableName: meta.tableName,
              page: meta.page,
              pageSize: meta.pageSize,
            },
          }));
        });
    }
  }, [workspaceInitialized, connections]);

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
    if (!activeConn || !isConnectionEnabled(activeConn)) {
      return null;
    }
    if (!activeSqlDatabase.trim()) {
      return activeConn;
    }
    return { ...activeConn, database: activeSqlDatabase };
  }, [activeConn, activeSqlDatabase]);

  const databaseFilters = useDbSchemaFilterStore((s) => s.databaseFilters);
  const hydrateSchemaFilters = useDbSchemaFilterStore((s) => s.hydrate);
  const setDatabaseFilters = useDbSchemaFilterStore((s) => s.setDatabaseFilters);
  const filtersHydrated = useDbSchemaFilterStore((s) => s.hydrated);
  const hydrateSchemaCache = useDbSchemaCacheStore((s) => s.hydrate);
  const cacheHydrated = useDbSchemaCacheStore((s) => s.hydrated);
  const schemaSnapshot = useDbSchemaCacheStore((s) => s.snapshot);

  const allDatabasesForActiveConn = activeConn
    ? (databasesByConnId[activeConn.id] ?? [])
    : [];

  const databasesForActiveConn = useMemo(() => {
    if (!activeConn) {
      return [];
    }
    return getVisibleNames(allDatabasesForActiveConn, databaseFilters[activeConn.id]);
  }, [activeConn, allDatabasesForActiveConn, databaseFilters]);

  useEffect(() => {
    if (!filtersHydrated) {
      void hydrateSchemaFilters();
    }
  }, [filtersHydrated, hydrateSchemaFilters, schemaRefreshToken]);

  useEffect(() => {
    if (!cacheHydrated) {
      void hydrateSchemaCache();
    }
  }, [cacheHydrated, hydrateSchemaCache]);

  useEffect(() => {
    if (!cacheHydrated || !activeConn) {
      return;
    }
    const names = getCachedDatabaseNames(schemaSnapshot, activeConn.id);
    if (names.length === 0) {
      return;
    }
    setDatabasesByConnId((prev) => {
      const current = prev[activeConn.id];
      if (current && current.length === names.length && current.every((name, index) => name === names[index])) {
        return prev;
      }
      return { ...prev, [activeConn.id]: names };
    });
    setDatabaseFilters((prev) => ({
      ...prev,
      [activeConn.id]: mergeFilter(prev[activeConn.id], names),
    }));
  }, [activeConn, cacheHydrated, schemaSnapshot, setDatabaseFilters]);

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
    if (!activeSqlTabId || !activeConn || databasesForActiveConn.length === 0) {
      return;
    }
    const tabState = sqlTabStates[activeSqlTabId];
    const current = tabState?.database.trim() ?? "";
    const preset = activeConn.database.trim();
    const pick =
      current && databasesForActiveConn.includes(current)
        ? current
        : preset && databasesForActiveConn.includes(preset)
          ? preset
          : databasesForActiveConn[0];
    if (pick && pick !== current) {
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
    if (!activeConn || !activeSqlDatabase.trim() || !cacheHydrated) {
      return;
    }
    const key = `${activeConn.id}:${activeSqlDatabase}`;
    if (schemaByKey[key]) {
      return;
    }
    const dbEntry = schemaSnapshot.connections[activeConn.id]?.databases.find(
      (entry) => entry.name === activeSqlDatabase,
    );
    if (!dbEntry) {
      return;
    }
    const tables = introspectToTableSchemas(dbEntry.tables);
    setSchemaByKey((prev) => ({
      ...prev,
      [key]: buildDatabaseSchema(activeSqlDatabase, tables),
    }));
  }, [activeConn, activeSqlDatabase, schemaByKey, cacheHydrated, schemaSnapshot]);

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
        totalRows = await countTable(connForSchema, tableName, dbName);
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
        if (connection.db_type === "redis") {
          setTableColumnMeta((prev) => ({
            ...prev,
            [tabId]: buildRedisColumnMeta(data.columns),
          }));
        }
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
          countTable(connForSchema, tableName, dbName),
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

  const clearTabDirty = useCallback((tabId: string) => {
    setTabDirtyRows((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  }, []);

  const refreshTabPreviewNow = useCallback(
    (tabId: string) => {
      const preview = tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      refreshTablePreview(tabId, preview.connId, preview.dbName, preview.tableName);
    },
    [tablePreviews, refreshTablePreview],
  );

  const goToPageNow = useCallback(
    (tabId: string, page: number) => {
      const preview = tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      goToPage(tabId, preview.connId, preview.dbName, preview.tableName, page);
    },
    [tablePreviews, goToPage],
  );

  const commitTabDirty = useCallback(
    async (tabId: string) => {
      const dirty = tabDirtyRows[tabId];
      if (!dirty) return;
      const preview = tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      const connection = connections.find((c) => c.id === preview.connId);
      if (!connection) return;
      const colMeta = tableColumnMeta[tabId];
      if (!colMeta) return;
      const pkCols = colMeta.filter((c) => c.isPk);
      if (pkCols.length === 0) {
        console.error("[db.commit] no primary key found, cannot commit");
        return;
      }
      const connForSchema = { ...connection, database: preview.dbName };
      const tableName = preview.tableName;
      const isRedis = connection.db_type === "redis";
      const sqls: string[] = [];

      if (isRedis) {
        for (const [rowKey, changes] of Object.entries(dirty)) {
          sqls.push(...buildRedisUpdateCommands(tableName, rowKey, pkCols, changes));
        }
        if (sqls.length === 0) {
          console.error("[db.commit] no redis commands generated");
          return;
        }
      } else {
        const pkNames = pkCols.map((c) => c.name);
        const escape = (v: unknown): string => {
          if (v === null || v === undefined) return "NULL";
          if (typeof v === "number") return String(v);
          return `'${String(v).replace(/'/g, "\\'")}'`;
        };
        for (const [rowKey, changes] of Object.entries(dirty)) {
          const setClause = Object.entries(changes)
            .map(([col, val]) => `\`${col}\` = ${escape(val)}`)
            .join(", ");
          const pkValues = pkNames.map((n) => {
            const v = readRowKeyValue(rowKey, n);
            return v === "" ? `${n} IS NULL` : `${n} = ${escape(v)}`;
          });
          sqls.push(`UPDATE \`${tableName}\` SET ${setClause} WHERE ${pkValues.join(" AND ")} LIMIT 1`);
        }
      }
      setCommittingTabs((prev) => new Set(prev).add(tabId));
      try {
        for (const sql of sqls) {
          await invoke("db_execute_query", { connection: connForSchema, sql });
        }
        clearTabDirty(tabId);
        refreshTabPreviewNow(tabId);
      } catch (err) {
        console.error("[db.commit] failed", err);
        throw err;
      } finally {
        setCommittingTabs((prev) => {
          const next = new Set(prev);
          next.delete(tabId);
          return next;
        });
      }
    },
    [tabDirtyRows, tablePreviews, connections, tableColumnMeta, clearTabDirty, refreshTabPreviewNow],
  );

  const rollbackTabDirty = useCallback(
    (tabId: string) => {
      clearTabDirty(tabId);
      refreshTabPreviewNow(tabId);
    },
    [clearTabDirty, refreshTabPreviewNow],
  );

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
    setTabDirtyRows((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setCommittingTabs((prev) => {
      if (!prev.has(tabId)) return prev;
      const next = new Set(prev);
      next.delete(tabId);
      return next;
    });
  }, []);

  const hasDirty = useCallback(
    (tabId: string) => Object.keys(tabDirtyRows[tabId] ?? {}).length > 0,
    [tabDirtyRows],
  );

  const executeTabAction = useCallback(
    (action: { kind: "refresh" | "page" | "close"; tabId: string; page?: number }) => {
      if (action.kind === "refresh") {
        refreshTabPreviewNow(action.tabId);
      } else if (action.kind === "page") {
        goToPageNow(action.tabId, action.page ?? 0);
      } else {
        closeWorkspaceTab(action.tabId);
      }
    },
    [refreshTabPreviewNow, goToPageNow, closeWorkspaceTab],
  );

  const requestTabAction = useCallback(
    (action: { kind: "refresh" | "page" | "close"; tabId: string; page?: number }) => {
      if (hasDirty(action.tabId)) {
        setPendingTabAction(action);
        return;
      }
      executeTabAction(action);
    },
    [hasDirty, executeTabAction],
  );

  const confirmPendingCommit = useCallback(async () => {
    if (!pendingTabAction) return;
    const tabId = pendingTabAction.tabId;
    setPendingTabAction(null);
    try {
      await commitTabDirty(tabId);
    } catch {
      // 提交失败时不清空 dirty，提示用户去处理
      return;
    }
    executeTabAction(pendingTabAction);
  }, [pendingTabAction, commitTabDirty, executeTabAction]);

  const cancelPendingCommit = useCallback(() => {
    if (!pendingTabAction) return;
    const action = pendingTabAction;
    setPendingTabAction(null);
    rollbackTabDirty(action.tabId);
    executeTabAction(action);
  }, [pendingTabAction, rollbackTabDirty, executeTabAction]);

  const handleCellEdit = useCallback(
    (tabId: string, cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> }) => {
      setCellEdit({ tabId, column: cellInfo.column, row: cellInfo.row });
    },
    [],
  );

  const handleCellSave = useCallback(
    (value: unknown) => {
      if (!cellEdit) return;
      const { tabId, column, row } = cellEdit;
      const colMeta = tableColumnMeta[tabId];
      if (!colMeta) {
        setCellEdit(null);
        return;
      }
      const pkCols = colMeta.filter((c) => c.isPk);
      if (pkCols.length === 0) {
        setCellEdit(null);
        return;
      }
      const originalValue = row[column];
      const same =
        originalValue === value ||
        (originalValue == null && value === "") ||
        (originalValue === "" && value == null) ||
        (typeof originalValue === "number" &&
          typeof value === "string" &&
          String(originalValue) === value);
      if (same) {
        setCellEdit(null);
        return;
      }
      const rowKey = pkCols
        .map((pk) => `${pk.name}=${row[pk.name] == null ? "" : String(row[pk.name])}`)
        .join("&");
      setTabDirtyRows((prev) => {
        const cur = { ...(prev[tabId] ?? {}) };
        const rowDirty = { ...(cur[rowKey] ?? {}) };
        if (value === null || value === undefined) {
          delete rowDirty[column];
        } else {
          rowDirty[column] = value;
        }
        if (Object.keys(rowDirty).length === 0) {
          delete cur[rowKey];
        } else {
          cur[rowKey] = rowDirty;
        }
        if (Object.keys(cur).length === 0) {
          const next = { ...prev };
          delete next[tabId];
          return next;
        }
        return { ...prev, [tabId]: cur };
      });
      setCellEdit(null);
    },
    [cellEdit, tableColumnMeta],
  );

  const handleContextTable = useCallback(
    (selection: SchemaTableSelection, event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setTableCtxMenu({ x: event.clientX, y: event.clientY, selection });
    },
    [],
  );

  const handleContextConnection = useCallback(
    (connId: string, event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setConnCtxMenu({ x: event.clientX, y: event.clientY, connId });
    },
    [],
  );

  const toggleConnectionEnabled = useCallback(
    async (connId: string, enabled: boolean) => {
      const connection = connections.find((c) => c.id === connId);
      if (!connection) return;
      try {
        await saveConnection({ ...connection, enabled });
        if (!enabled) {
          updateSchemaExpanded((prev) => {
            const next = new Set(prev);
            next.delete(connectionNodeId(connId));
            return next;
          });
          setActiveConnId((prev) => (prev === connId ? null : prev));
        }
        setSchemaRefreshToken((token) => token + 1);
      } catch (err) {
        console.error("[DatabasePanel] toggleConnectionEnabled failed", err);
      }
    },
    [connections, updateSchemaExpanded],
  );

  async function writeToClipboard(text: string): Promise<boolean> {
    const clip = navigator.clipboard;
    if (clip && typeof clip.writeText === "function") {
      try {
        await clip.writeText(text);
        return true;
      } catch (err) {
        console.error("[clipboard] writeText failed, falling back", err);
      }
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      console.error("[clipboard] execCommand failed", err);
    }
    document.body.removeChild(ta);
    return ok;
  }

  const copyNameForCurrentTable = useCallback(() => {
    const ctx = tableCtxMenu;
    if (!ctx) return;
    void writeToClipboard(`\`${ctx.selection.dbName}\`.\`${ctx.selection.tableName}\``);
  }, [tableCtxMenu]);

  const resolveTabExportData = useCallback(
    async (tabId: string) => {
      const tabState = sqlTabStates[tabId] ?? createDefaultSqlTabState();
      const preview = tablePreviews[tabId];
      const connId = preview?.connId ?? activeConn?.id;
      const baseConn = connId ? connections.find((c) => c.id === connId) : null;
      if (!baseConn || !tabState.database.trim()) {
        return null;
      }
      const conn = { ...baseConn, database: tabState.database };

      let queryResult: QueryResult | null = null;
      if (tabState.result && tabState.result.columns.length > 0) {
        queryResult = tabState.result;
      } else if (tabState.sql.trim()) {
        try {
          queryResult = await invoke<QueryResult>("db_execute_query", {
            connection: conn,
            sql: tabState.sql.trim(),
          });
        } catch {
          return null;
        }
      }

      if (!queryResult || queryResult.columns.length === 0) {
        return null;
      }

      const rows = rowsToRecord(queryResult.columns, queryResult.rows);
      const baseName =
        preview?.dbName && preview?.tableName
          ? `${preview.dbName}_${preview.tableName}`
          : tabState.database.trim()
            ? `${tabState.database}_query`
            : "query";

      return { columns: queryResult.columns, rows, baseName };
    },
    [sqlTabStates, tablePreviews, activeConn, connections],
  );

  const exportTabResultToCsv = useCallback(
    async (tabId: string) => {
      const payload = await resolveTabExportData(tabId);
      if (!payload) return;
      const csv = toCsv(payload.columns, payload.rows);
      const filePath = await save({
        title: t("database.results.exportCsv"),
        defaultPath: `${payload.baseName}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!filePath) return;
      await invoke("write_text_file", { path: filePath, contents: csv });
    },
    [resolveTabExportData, t],
  );

  const copyTabResultToClipboard = useCallback(
    async (tabId: string) => {
      const payload = await resolveTabExportData(tabId);
      if (!payload) return;
      await writeToClipboard(toCsv(payload.columns, payload.rows));
    },
    [resolveTabExportData],
  );

  const [exportMenu, setExportMenu] = useState<
    { x: number; y: number; tabId: string } | null
  >(null);
  const buildExportMenuItems = useCallback(() => {
    const clipboardIcon = (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <rect x="5" y="5" width="9" height="9" rx="1.5" />
        <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" />
      </svg>
    );
    const fileIcon = (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M3 2.5h7l3 3v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
        <path d="M10 2.5V6h3" />
      </svg>
    );
    return [
      {
        id: "export-clipboard",
        label: t("database.results.exportToClipboard"),
        icon: clipboardIcon,
        onClick: () => {
          const tabId = exportMenu?.tabId;
          if (!tabId) return;
          void copyTabResultToClipboard(tabId);
        },
      },
      {
        id: "export-file",
        label: t("database.results.exportToFile"),
        icon: fileIcon,
        onClick: () => {
          const tabId = exportMenu?.tabId;
          if (!tabId) return;
          void exportTabResultToCsv(tabId);
        },
      },
    ];
  }, [copyTabResultToClipboard, exportTabResultToCsv, exportMenu?.tabId, t]);

  const copyDdlForCurrentTable = useCallback(() => {
    const ctx = tableCtxMenu;
    if (!ctx) return;
    fetchTableDdl(ctx.selection.connection, ctx.selection.dbName, ctx.selection.tableName)
      .then((ddl) => writeToClipboard(ddl))
      .catch((err) => console.error("[db.copyDdl] fetchTableDdl failed", err));
  }, [tableCtxMenu]);

  const buildTableContextMenuItems = useCallback(() => {
    const copyIcon = (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <rect x="5" y="5" width="9" height="9" rx="1.5" />
        <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" />
      </svg>
    );
    return [
      {
        id: "copy",
        label: t("database.contextMenu.copy"),
        icon: copyIcon,
        children: [
          {
            id: "copy-name",
            label: t("database.contextMenu.copyName"),
            onClick: copyNameForCurrentTable,
          },
          {
            id: "copy-ddl",
            label: t("database.contextMenu.copyDdl"),
            onClick: copyDdlForCurrentTable,
          },
          {
            id: "copy-data",
            label: t("database.contextMenu.copyData"),
            disabled: true,
          },
        ],
      },
    ];
  }, [t, copyDdlForCurrentTable, copyNameForCurrentTable]);

  const refreshConnDatabases = useCallback(
    (connId: string) => {
      const conn = connections.find((c) => c.id === connId);
      if (!conn || !isConnectionEnabled(conn)) {
        return;
      }
      void refreshConnectionSchemaCache(conn).then(async (entry) => {
        await useDbSchemaCacheStore.getState().patchConnection(connId, entry);
        const names = entry.databases.map((db) => db.name);
        setDatabasesByConnId((prev) => ({ ...prev, [connId]: names }));
        setDatabaseFilters((prev) => ({
          ...prev,
          [connId]: mergeFilter(prev[connId], names),
        }));
      });
    },
    [connections, setDatabaseFilters],
  );

  const buildConnContextMenuItems = useCallback(() => {
    const plusIcon = (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M8 3v10M3 8h10" />
      </svg>
    );
    const refreshIcon = (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M2 8a6 6 0 0 1 10.5-3.9" />
        <path d="M14 2v3h-3" />
        <path d="M14 8a6 6 0 0 1-10.5 3.9" />
        <path d="M2 14v-3h3" />
      </svg>
    );
    const editIcon = (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M11 2l3 3-8 8H3v-3l8-8z" />
        <path d="M2 14h12" />
      </svg>
    );
    const openIcon = (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M3 6l5-4 5 4" />
        <path d="M8 2v12" />
      </svg>
    );
    const closeIcon = (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M3 10l5 4 5-4" />
        <path d="M8 14V2" />
      </svg>
    );
    const connId = connCtxMenu?.connId;
    const connection = connections.find((c) => c.id === connId);
    const connEnabled = connection ? isConnectionEnabled(connection) : false;
    return [
      {
        id: connEnabled ? "disable-connection" : "enable-connection",
        label: connEnabled
          ? t("database.contextMenu.closeConnection")
          : t("database.contextMenu.openConnection"),
        icon: connEnabled ? closeIcon : openIcon,
        disabled: !connection,
        onClick: () => {
          if (!connection) return;
          void toggleConnectionEnabled(connection.id, !connEnabled);
        },
      },
      {
        id: "edit-connection",
        label: t("database.contextMenu.editConnection"),
        icon: editIcon,
        disabled: !connection,
        onClick: () => {
          if (!connection) return;
          setEditingConnection(connection);
          setDialogOpen(true);
        },
      },
      {
        id: "create-database",
        label: t("database.contextMenu.createDatabase"),
        icon: plusIcon,
        disabled: !connId || !connEnabled,
        onClick: () => {
          if (!connId) return;
          setCreateDbDialog({ connId });
        },
      },
      {
        id: "refresh-databases",
        label: t("database.contextMenu.refresh"),
        icon: refreshIcon,
        disabled: !connId || !connEnabled,
        onClick: () => {
          if (!connId) return;
          refreshConnDatabases(connId);
        },
      },
    ];
  }, [connCtxMenu?.connId, connections, refreshConnDatabases, toggleConnectionEnabled, t]);

  const handleSelectTable = useCallback(
    (selection: SchemaTableSelection) => {
      const tableKey = makeTableTabKey(selection.connId, selection.dbName, selection.tableName);
      setActiveTableKey(tableKey);
      setActiveConnId(selection.connId);

      const existingTabId = findTabIdForTable(
        tablePreviews,
        workspaceTabs.map((tab) => tab.id),
        selection.connId,
        selection.dbName,
        selection.tableName,
      );
      if (existingTabId) {
        setActiveWorkspaceTabId(existingTabId);
        return;
      }

      const tabId = makeSqlTabId();

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
      if (selection.connection.db_type !== "redis") {
        void introspectTable(selection.connection, selection.dbName, selection.tableName)
          .then((schema) => {
            setTableColumnMeta((prev) => ({ ...prev, [tabId]: schema.columns }));
          })
          .catch(() => {});
      }
    },
    [loadTablePreview, tablePreviews, workspaceTabs],
  );

  const handleSelectDatabase = useCallback(
    (selection: SchemaDatabaseSelection) => {
      setActiveConnId(selection.connId);

      const existingTabId = findTabIdForDatabase(
        workspaceTabs,
        selection.connId,
        selection.dbName,
      );
      if (existingTabId) {
        setActiveWorkspaceTabId(existingTabId);
        return;
      }

      const tabId = makeDatabaseTabId();
      const tab: DatabaseListWorkspaceTab = {
        id: tabId,
        kind: "database",
        label: selection.dbName,
        connId: selection.connId,
        dbName: selection.dbName,
      };
      setWorkspaceTabs((prev) => [...prev, tab]);
      setActiveWorkspaceTabId(tabId);
    },
    [workspaceTabs],
  );

  const activeDatabaseKey = useMemo(() => {
    if (activeWorkspaceTab?.kind === "database") {
      return makeDatabaseTabKey(activeWorkspaceTab.connId, activeWorkspaceTab.dbName);
    }
    return null;
  }, [activeWorkspaceTab]);

  useEffect(() => {
    if (activeWorkspaceTab?.kind === "database") {
      setActiveConnId(activeWorkspaceTab.connId);
    }
  }, [activeWorkspaceTab]);

  const applySchemaTableDrop = useCallback(
    (item: SchemaTreeItem) => {
      if (item.type !== "table") {
        return;
      }
      if (!item.connId || !item.dbName || !item.tableName) {
        return;
      }

      const connection = connections.find((c) => c.id === item.connId);
      if (!connection) {
        return;
      }

      handleSelectTable({
        connId: item.connId,
        dbName: item.dbName,
        tableName: item.tableName,
        connection,
      });
      setActiveSchemaDragItem(null);
    },
    [connections, handleSelectTable],
  );

  const handleExternalSchemaDrop = useCallback(
    (dataTransfer: DataTransfer) => {
      const item = parseSchemaTreeItemFromDrop(dataTransfer);
      logSchemaTreeDrop(item?.type ?? "unknown", "workspace");
      if (!item) {
        return;
      }
      applySchemaTableDrop(item);
    },
    [applySchemaTableDrop],
  );

  useEffect(() => {
    return registerSchemaTreeDropListener((item) => {
      applySchemaTableDrop(item);
    });
  }, [applySchemaTableDrop]);

  const openNewSqlTab = useCallback(() => {
    const tabId = makeSqlTabId();
    const sqlTabCount = workspaceTabs.filter(isSqlWorkspaceTab).length + 1;
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

  const renameWorkspaceTab = useCallback((tabId: string, label: string) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    setWorkspaceTabs((prev) =>
      prev.map((tab) => (tab.id === tabId ? { ...tab, label: nextLabel } : tab)),
    );
  }, []);

  const handleRenameTab = useCallback(
    async (tabId: string) => {
      const tab = workspaceTabs.find((item) => item.id === tabId);
      if (!tab) return;

      const name = await quickInput({
        title: t("database.workspace.renameTabTitle"),
        subtitle: t("shell.topbar.rename"),
        placeholder: t("database.workspace.renameTabPlaceholder"),
        defaultValue: tab.label,
        validate: (value) => {
          if (!value.trim()) {
            return t("database.workspace.renameTabRequired");
          }
          return null;
        },
      });

      if (name) {
        renameWorkspaceTab(tabId, name);
      }
    },
    [workspaceTabs, t, renameWorkspaceTab],
  );

  const handleContextAction = useCallback(
    (action: TabContextMenuAction) => {
      if (!ctxMenu) return;
      const idx = ctxMenu.index;
      const tabList = workspaceTabs;
      const { tabId } = ctxMenu;

      if (action === "rename") {
        setCtxMenu(null);
        void handleRenameTab(tabId);
        return;
      }

      if (action === "close") {
        closeWorkspaceTab(tabId);
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
        setDockLayout(null);
      }
      setCtxMenu(null);
    },
    [ctxMenu, workspaceTabs, closeWorkspaceTab, handleRenameTab, setDockLayout],
  );


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

  const handleSelectGroup = useCallback(
    (groupId: string) => {
      setActiveGroupId(groupId);
    },
    [setActiveGroupId],
  );

  const handleSelectConnection = useCallback(
    (connId: string) => {
      setActiveConnId(connId);
      const conn = connections.find((item) => item.id === connId);
      if (!conn) return;
      const normalized = normalizeConnectionGroup(conn.group);
      const group = groups.find((item) => item.name === normalized);
      if (group) {
        setActiveGroupId(group.id);
      }
    },
    [connections, groups, setActiveConnId, setActiveGroupId],
  );

  const runQuery = useCallback(async (sqlOverride?: string, tabIdOverride?: string) => {
    const tabId = tabIdOverride ?? activeWorkspaceTab?.id;
    const tab = tabId ? workspaceTabs.find((t) => t.id === tabId) : null;
    if (!tab || tab.kind !== "sql") {
      return;
    }
    const resolvedTabId = tab.id;
    const tabState = sqlTabStates[resolvedTabId] ?? createDefaultSqlTabState();
    const conn = connectionForSql;
    const sql = (sqlOverride ?? tabState.sql).trim();
    if (!conn) {
      updateSqlTabState(resolvedTabId, { error: t("database.results.noConnection") });
      return;
    }
    if (!tabState.database.trim()) {
      updateSqlTabState(resolvedTabId, { error: t("database.workspace.selectDatabase") });
      return;
    }
    if (!sql) {
      updateSqlTabState(resolvedTabId, { error: t("database.results.emptySql") });
      return;
    }
    updateSqlTabState(resolvedTabId, { running: true, error: null });
    enqueueAction({
      type: "sql",
      title: t("database.actions.runQuery"),
      description: `${conn.name} · ${t("database.actions.runQueryDesc")}`,
      command: sql,
      resourceId: conn.id,
      source: "用户",
    });
    const started = performance.now();
    try {
      const res = await invoke<QueryResult>("db_execute_query", {
        connection: conn,
        sql,
      });
      updateSqlTabState(resolvedTabId, {
        result: res,
        elapsed: Math.round(performance.now() - started),
        running: false,
      });
    } catch (e) {
      updateSqlTabState(resolvedTabId, {
        result: null,
        error: typeof e === "string" ? e : JSON.stringify(e),
        running: false,
      });
    }
  }, [
    connectionForSql,
    activeWorkspaceTab,
    workspaceTabs,
    enqueueAction,
    sqlTabStates,
    t,
    updateSqlTabState,
  ]);

  // 表预览（data）模式：编辑器常折叠且无焦点，在此统一处理 ⌘/Ctrl+Enter。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter" || e.shiftKey || e.altKey) {
        return;
      }
      if (isSqlMonacoEditorFocused()) return;

      const tabId = activeWorkspaceTabId;
      if (!tabId) return;
      const tabState = sqlTabStates[tabId];
      if (!tabState) return;

      const statement = sqlAtOffset(tabState.sql, tabState.cursorOffset);
      if (!statement) return;

      e.preventDefault();
      e.stopPropagation();
      void runQuery(statement, tabId);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeWorkspaceTabId, sqlTabStates, runQuery]);

  const ctxValue = useMemo<DbWorkspaceContextValue>(() => ({
    tabs: workspaceTabs,
    activeTabId: activeWorkspaceTabId,
    setActiveTabId: setActiveWorkspaceTabId,
    closeTab: (tabId) => requestTabAction({ kind: "close", tabId }),
    runQuery,
    updateSqlTabState,
    refreshTablePreview,
    goToPage,
    requestTabAction,
    handleCellEdit,
    selectTable: handleSelectTable,
    activeTableKey,
    sqlTabStates,
    tablePreviews,
    tableColumnMeta,
    tabModes,
    setTabMode: (id, mode) => setTabModes((prev) => ({ ...prev, [id]: mode })),
    tabDirtyRows,
    committingTabs,
    commitTabDirty,
    openExportMenu: (x: number, y: number, tabId: string) => setExportMenu({ x, y, tabId }),
    activeConn,
    groupConnections,
    databasesByConnId,
    databasesForActiveConn,
    schemaByKey,
    schemaLoadingKey,
    setActiveConnId,
    sqlCompletionSchemas,
    connectionForSql,
    rowsToRecord,
    tabModeToEditorOpenMode,
  }), [
    workspaceTabs, activeWorkspaceTabId, setActiveWorkspaceTabId, requestTabAction,
    runQuery, updateSqlTabState, refreshTablePreview, goToPage, handleCellEdit, handleSelectTable,
    activeTableKey,
    sqlTabStates, tablePreviews, tableColumnMeta, tabModes, tabDirtyRows, committingTabs,
    commitTabDirty, activeConn, groupConnections, databasesByConnId, databasesForActiveConn,
    schemaByKey, schemaLoadingKey, setActiveConnId, sqlCompletionSchemas, connectionForSql,
  ]);

  const mirrorRevisionsRef = useRef(new Map<string, string>());

  useLayoutEffect(() => {
    mirrorRevisionsRef.current = publishDbWorkspaceMirror(
      ctxValue,
      referencedDatabaseTabIds,
      mirrorRevisionsRef.current,
    );
  }, [ctxValue, referencedDatabaseTabIds]);

  const dockTabs = useMemo(
    () =>
      workspaceTabs
        .filter((tab) => !isOriginDocked("database", tab.id))
        .map((tab) => {
          if (tab.kind === "database") {
            return {
              id: tab.id,
              label: tab.label,
              panelType: "database",
              icon: "database" as const,
              tooltip: tab.label,
            };
          }
          const isTableTab =
            tabModes[tab.id] === "data" ||
            Boolean(tablePreviews[tab.id]?.tableName);
          return {
            id: tab.id,
            label: tab.label,
            panelType: "database",
            icon: isTableTab ? ("table" as const) : ("sql" as const),
            tooltip: tab.label,
          };
        }),
    [workspaceTabs, isOriginDocked, tablePreviews, tabModes],
  );

  const renderDockPanel = useCallback(
    (tabId: string) => {
      const tab = workspaceTabs.find((item) => item.id === tabId);
      if (!tab) return null;

      if (tab.kind === "database") {
        const connection = connections.find((item) => item.id === tab.connId);
        if (!connection) {
          return null;
        }
        const selection: SchemaDatabaseSelection = {
          connId: tab.connId,
          dbName: tab.dbName,
          connection,
        };
        return (
          <div className="db-workspace-pane db-dock-pane">
            <DatabaseTablesPanel
              selection={selection}
              onSelectTable={handleSelectTable}
            />
          </div>
        );
      }

      return (
        <div className="db-workspace-pane db-dock-pane">
          <DbPanelSurface tab={tab} />
        </div>
      );
    },
    [workspaceTabs, connections, handleSelectTable],
  );

  const handleDockTabContextMenu = useCallback(
    (event: ReactMouseEvent, tabId: string, index: number) => {
      setCtxMenu({ x: event.clientX, y: event.clientY, tabId, index });
    },
    [],
  );

  return (
    <ModuleSegmentDock
      className="db-module-dock"
      enabled={isActiveRoute}
      tabs={moduleSegmentTabs}
      activeTabId={moduleTab}
      onActiveTabChange={(id) => setModuleTab(id as DbModuleTab)}
      renderPanel={(panelId) =>
        panelId === "transfer" ? (
    <div className="db-module-transfer">
      <DatabaseToolbox
        connections={groupConnections}
        initialSourceConnectionId={activeConn?.id}
        initialSourceDatabase={activeSqlDatabase}
      />
    </div>
  ) : (
    <DbWorkspaceProvider value={ctxValue}>
      <SidebarWorkspace
        preset="schema"
        sidebarMinPx={280}
        sidebar={
          <SchemaBrowser
            groups={groups}
            activeGroupId={activeGroupId}
            activeConnId={activeConnId}
            onCreateConnection={() => {
              setEditingConnection(null);
              setDialogOpen(true);
            }}
            onCreateGroup={() => void handleCreateGroup()}
            onSelectGroup={handleSelectGroup}
            onSelectConnection={handleSelectConnection}
            onNewQuery={openNewSqlTab}
            onSelectTable={handleSelectTable}
            onSelectDatabase={handleSelectDatabase}
            onContextTable={handleContextTable}
            onContextConnection={handleContextConnection}
            activeTableKey={activeTableKey}
            activeDatabaseKey={activeDatabaseKey}
            refreshToken={schemaRefreshToken}
          />
        }
      >
        <div
          className="db-workspace-drop-zone"
          data-schema-drop-type="workspace"
          {...{ [SCHEMA_TREE_DROP_ZONE_ATTR]: "" }}
        >
        {!workspaceInitialized ? null : dockTabs.length === 0 ? (
          <WorkspaceEmptyPage
            prompt={t("database.workspace.emptyTabs")}
            actions={
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={openNewSqlTab}
              >
                {t("database.workspace.newQuery")}
              </Button>
            }
          />
        ) : (
          <DockableWorkspace
            className="db-workspace"
            dockScope="database"
            defaultHeaderPosition="top"
            enableTabGroups={false}
            tabs={dockTabs}
            activeTabId={activeWorkspaceTabId}
            onActiveTabChange={setActiveWorkspaceTabId}
            onCloseTab={(tabId) => requestTabAction({ kind: "close", tabId })}
            savedLayout={dockLayout}
            onSavedLayoutChange={setDockLayout}
            renderPanel={renderDockPanel}
            onTabContextMenu={handleDockTabContextMenu}
            canAcceptExternalDrop={canAcceptSchemaTreeDrop}
            onExternalDrop={handleExternalSchemaDrop}
            windowControl={false}
          />
        )}
        </div>
      </SidebarWorkspace>
      {ctxMenu && (() => {
        const ctxTab = workspaceTabs.find((t) => t.id === ctxMenu.tabId);
        const snapshot = ctxTab ? dbTabToSnapshot(ctxTab, tabModes[ctxTab.id]) : null;
        const closeItems = buildTabCloseMenuItems(
          t,
          workspaceTabs.length,
          ctxMenu.index,
          handleContextAction,
          { showRename: true },
        );
        const wsCopyItems = snapshot ? buildCopyToWorkspaceMenuItems({
          workspaces: allWorkspaces,
          currentWorkspaceId,
          snapshot,
          onCopyToCurrent: () => {
            if (!ctxTab) return;
            const newTab: DbWorkspaceTab = ctxTab.kind === "sql"
              ? { id: makeSqlTabId(), kind: "sql", label: `${ctxTab.label} (副本)` }
              : { id: makeDatabaseTabId(), kind: "database", label: `${ctxTab.label} (副本)`, connId: ctxTab.connId, dbName: ctxTab.dbName };
            setWorkspaceTabs((prev) => [...prev, newTab]);
            setActiveWorkspaceTabId(newTab.id);
            addSnapshotToWorkspace(
              currentWorkspaceId,
              dbTabToSnapshot(newTab, tabModes[ctxTab.id]),
            );
          },
        }) : [];
        const wsMoveItems = snapshot ? buildMoveToWorkspaceMenuItems(t, {
          workspaces: allWorkspaces,
          currentWorkspaceId,
          snapshot,
          onMoveToOther: () => closeWorkspaceTab(ctxMenu.tabId),
        }) : [];
        const allItems = [
          ...closeItems,
          { id: "ws-sep-before", separator: true, label: "" },
          {
            id: "ws-copy",
            label: t("shell.workspace.copyTo"),
            children: wsCopyItems,
          },
          {
            id: "ws-move",
            label: t("shell.workspace.moveTo"),
            children: wsMoveItems,
          },
        ];
        return (
          <ContextMenu
            items={allItems}
            position={{ x: ctxMenu.x, y: ctxMenu.y }}
            onClose={() => setCtxMenu(null)}
          />
        );
      })()}
      {tableCtxMenu && (
        <ContextMenu
          items={buildTableContextMenuItems()}
          position={{ x: tableCtxMenu.x, y: tableCtxMenu.y }}
          onClose={() => setTableCtxMenu(null)}
        />
      )}
      {connCtxMenu && (
        <ContextMenu
          items={buildConnContextMenuItems()}
          position={{ x: connCtxMenu.x, y: connCtxMenu.y }}
          onClose={() => setConnCtxMenu(null)}
        />
      )}
      <CreateDatabaseDialog
        open={createDbDialog !== null}
        connection={
          createDbDialog
            ? connections.find((c) => c.id === createDbDialog.connId) ?? null
            : null
        }
        onCancel={() => setCreateDbDialog(null)}
        onCreated={(_created) => {
          const connId = createDbDialog?.connId;
          setCreateDbDialog(null);
          if (connId) {
            refreshConnDatabases(connId);
            setActiveConnId(connId);
          }
        }}
      />
      {exportMenu && (
        <ContextMenu
          items={buildExportMenuItems()}
          position={{ x: exportMenu.x, y: exportMenu.y }}
          onClose={() => setExportMenu(null)}
        />
      )}
      <Modal
        open={pendingTabAction !== null}
        onClose={cancelPendingCommit}
      >
        {pendingTabAction && (() => {
          const dirtyCount = Object.keys(tabDirtyRows[pendingTabAction.tabId] ?? {}).length;
          return (
            <div className="warn-alert-dialog" role="alertdialog">
              <div className="warn-alert-header">
                <span className="warn-alert-icon" aria-hidden>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </span>
                <h3 className="warn-alert-title">{t("database.results.dirtyTitle")}</h3>
              </div>
              <div className="warn-alert-body">
                <p className="warn-alert-message">
                  {t("database.results.dirtyMessage", { count: dirtyCount })}
                </p>
              </div>
              <div className="warn-alert-footer">
                <Button type="button" variant="secondary" onClick={cancelPendingCommit}>
                  {t("database.results.dirtyRollback")}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={confirmPendingCommit}
                  disabled={committingTabs.has(pendingTabAction.tabId)}
                >
                  {t("database.results.dirtyCommit")}
                </Button>
              </div>
            </div>
          );
        })()}
      </Modal>
      <ConnectionDialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setEditingConnection(null);
        }}
        onSaved={() => {
          setSchemaRefreshToken((token) => token + 1);
          setEditingConnection(null);
        }}
        defaultGroup={activeGroupName}
        groups={groups}
        initialConnection={editingConnection}
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
    </DbWorkspaceProvider>
  )
      }
    />
  );
}
