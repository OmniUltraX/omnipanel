import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { SidebarWorkspace } from "../../components/ui/SidebarWorkspace";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import type { SchemaDatabaseSelection, SchemaTableSelection } from "./SchemaBrowser";
import { DatabaseSchemaSidebar } from "./DatabaseSchemaSidebar";
import {
  DatabaseModuleContextBridge,
  resolveDatabaseModuleContext,
} from "./ai";
import { DatabaseTablesPanel } from "./DatabaseTablesPanel";
import { DatabaseConnectionInfoPanel } from "./DatabaseConnectionInfoPanel";
import { ConnectionResolvedDockPane } from "./ConnectionResolvedDockPane";
import { DbSchemaProvider } from "./DbSchemaContext";
import { ConnectionDialog } from "./ConnectionDialog";
import { ContextMenu } from "../../components/ui/ContextMenu";
import { FormDialog, FormField } from "../../components/ui/FormDialog";
import { Select } from "../../components/ui/Select";
import { buildTabCloseMenuItems, type TabContextMenuAction } from "../../components/ui/contextMenuItems";
import { useActionStore } from "../../stores/actionStore";
import { useDbGroupStore } from "../../stores/dbGroupStore";
import { useDbSchemaFilterStore } from "../../stores/dbSchemaFilterStore";
import { useDbSchemaTreeExpandedStore } from "../../stores/dbSchemaTreeExpandedStore";
import { useDbSchemaCacheStore } from "../../stores/dbSchemaCacheStore";
import { usePoolConnectionRegistration, type PoolKind } from "../../stores/connectionPoolStore";
import { getVisibleNames, mergeFilter } from "./DatabaseFilterDialog";
import { useI18n } from "../../i18n";
import { quickInput } from "../../lib/quickInput";
import { useModuleSuspended } from "../../lib/moduleVisibility";
import { isSqlMonacoEditorFocused, sqlAtOffset } from "./lsp/sqlStatement";
import type { DbSqlFileNode } from "../../stores/dbSqlFileStore";
import { resolveSqlTabStateFromFile, useDbSqlFileStore } from "../../stores/dbSqlFileStore";
import {
  connectionMatchesGroup,
  normalizeConnectionGroup,
  countTable,
  createDatabase,
  fetchTableDdl,
  introspectTable,
  listConnections,
  listDatabases,
  MYSQL_CHARSET_PRESETS,
  previewTable,
  saveConnection,
  isConnectionEnabled,
  isSqlCapableConnection,
  isToolboxCapableConnection,
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
  makeDatabaseTabId,
  makeDatabaseTabKey,
  findTabIdForDatabase,
  findTabIdForConnection,
  findTabIdForSqlFile,
  makeTableTabLabel,
  makeTableTabKey,
  findTabIdForTable,
  findTabIdForDesigner,
  makeDesignerTabId,
  makeConnectionInfoTabId,
  makeTableDesignerTabLabel,
  type ConnectionInfoWorkspaceTab,
  type DatabaseListWorkspaceTab,
  type DbWorkspaceTab,
  type SqlWorkspaceTab,
  type TableDesignerWorkspaceTab,
} from "./workspaceTabs";
import { TableDesignerDockPane } from "./tableDesigner/TableDesignerDockPane";
import { supportsTableDesign, resolveTableDesignerDriver } from "./tableDesigner/resolveTableDesignerDriver";
import { DatabaseTableEditorHost } from "./DatabaseTableEditorHost";
import { DatabaseToolbox } from "./toolbox/DatabaseToolbox";
import {
  createDefaultSqlTabState,
  createDefaultTablePreviewState,
  buildOrderByClause,
  DEFAULT_QUERY_LIMIT,
  NEW_ROW_KEY_PREFIX,
  PENDING_INSERT_ROW_KEY,
  resolveSqlTabConnectionId,
  rowsToRecord,
  tabModeToEditorOpenMode,
  type SortState,
  type SqlTabState,
  type TableDesignerTabState,
  type TablePreviewState,
  type QueryResult,
} from "./dbWorkspaceState";
import { DatabaseWorkspaceDock } from "./DatabaseWorkspaceDock";
import {
  buildDatabaseModulePanelContentKey,
  buildDatabasePanelContentKeysByTab,
} from "./databasePanelTabKeys";
import { DbPanelSurface } from "./DbPanelSurface";
import { ModuleSegmentDock } from "../../components/dock";
import { patchDockTabFileMeta } from "../../components/dock/dockTabLiveMeta";
import { DbWorkspaceProvider, type DbWorkspaceContextValue } from "../../contexts/DbWorkspaceContext";
import { useDbDockLayoutStore } from "../../stores/dbDockLayoutStore";
import {
  schedulePersistWorkspaceSession,
  useDbWorkspaceSessionStore,
} from "../../stores/dbWorkspaceSessionStore";
import {
  buildClosedPanelEntry,
  buildWorkspaceSessionSnapshot,
  restoreTableDesignerStateFromSnapshot,
  sanitizeWorkspaceSession,
  type DbClosedPanelEntry,
  type DbSqlTabStateSnapshot,
} from "./dbWorkspaceSession";
import { useWorkspaceBottomDockStore } from "../../stores/workspaceBottomDockStore";
import { publishDbWorkspaceMirror } from "../../stores/dbWorkspaceMirrorStore";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";
import { useWorkspaceStore, onWorkspaceSwitch } from "../../stores/workspaceStore";
import { dbTabToSnapshot, addSnapshotToWorkspace, syncDatabaseTableTabToWorkspace } from "../../lib/workspaceTabActions";
import { useWorkspaceTabStore, type DbTabSnapshot } from "../../stores/workspaceTabStore";
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

type DbModuleTab = "query" | "transfer";
const DB_MODULE_TABS: DbModuleTab[] = ["query", "transfer"];
const EMPTY_DOCKED_DATABASE_TABS: string[] = [];

function restoreSqlTabStateFromSnapshot(snap: DbSqlTabStateSnapshot): SqlTabState {
  return {
    ...createDefaultSqlTabState(snap.database, snap.connId ?? ""),
    sql: snap.sql,
    database: snap.database,
    connId: snap.connId ?? "",
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
  setWorkspaceTabs([]);
  setActiveWorkspaceTabId("");
  setSqlTabStates({});
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
      <FormField
        label={t("database.createDatabase.nameLabel")}
        htmlFor="create-db-name"
        description={t("database.createDatabase.nameDescription")}
      >
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
      </FormField>
      <FormField
        label={t("database.createDatabase.charsetLabel")}
        htmlFor="create-db-charset"
        description={t("database.createDatabase.charsetDescription")}
      >
        <Select
          value={charset}
          onChange={setCharset}
          options={charsetOptions}
          size="sm"
          disabled={busy}
        />
      </FormField>
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
  const isActiveRoute = location.pathname === "/module/database";
  const moduleSuspended = useModuleSuspended();
  const moduleLive = isActiveRoute && !moduleSuspended;
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
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [activeConnId, setActiveConnId] = useState<string | null>(null);
  const [sqlTabStates, setSqlTabStates] = useState<Record<string, SqlTabState>>({});

  const [workspaceTabs, setWorkspaceTabs] = useState<DbWorkspaceTab[]>([]);
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] = useState("");
  const [workspaceInitialized, setWorkspaceInitialized] = useState(false);
  const recentClosedPanels = useDbWorkspaceSessionStore((s) => s.recentClosedPanels);
  const pushRecentClosedPanel = useDbWorkspaceSessionStore((s) => s.pushRecentClosedPanel);
  const removeRecentClosedPanel = useDbWorkspaceSessionStore((s) => s.removeRecentClosedPanel);
  /** SQL 工作区 Tab 未保存标记（按 tabId；与 store.dirtyFileIds 解耦，保证 Tab 头即时更新） */
  const [dirtySqlWorkspaceTabIds, setDirtySqlWorkspaceTabIds] = useState<Set<string>>(
    () => new Set(),
  );
  const tablePreviewRestoreDoneRef = useRef(false);
  const [tablePreviews, setTablePreviews] = useState<Record<string, TablePreviewState>>({});
  const [activeTableKey, setActiveTableKey] = useState<string | null>(null);
  const [tableColumnMeta, setTableColumnMeta] = useState<Record<string, DbColumnMeta[]>>({});
  const [tabModes, setTabModes] = useState<Record<string, "data" | "sql">>({});
  const [tableDesignerStates, setTableDesignerStates] = useState<Record<string, TableDesignerTabState>>({});
  const [databasesByConnId, setDatabasesByConnId] = useState<Record<string, string[]>>({});
  const [schemaByKey, setSchemaByKey] = useState<Record<string, DatabaseSchema>>({});
  const [schemaLoadingKey] = useState<string | null>(null);
  const [cellEdit, setCellEdit] = useState<{
    tabId: string;
    column: string;
    row: Record<string, unknown>;
  } | null>(null);
  const [rowEdit, setRowEdit] = useState<{
    tabId: string;
    column: string;
    row: Record<string, unknown>;
    isNewRow?: boolean;
  } | null>(null);
  /** 每个 tab 的「未提交修改」：行键 -> {列名: 新值}。提交或回滚后清空对应 tab。 */
  const [tabDirtyRows, setTabDirtyRows] = useState<
    Record<string, Record<string, Record<string, unknown>>>
  >({});
  const [committingTabs, setCommittingTabs] = useState<Set<string>>(() => new Set());
  const [pendingTabAction, setPendingTabAction] = useState<
    | {
        kind: "refresh" | "page" | "close" | "sort";
        tabId: string;
        page?: number;
        sort?: SortState | null;
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
  const referencedDatabaseTabIds = useWorkspaceBottomDockStore(
    useShallow((s) => {
      const ids = new Set<string>(s.dockedOriginByScope.database ?? []);
      for (const tabs of Object.values(s.tabsByWorkspace)) {
        for (const tab of tabs ?? []) {
          if (tab.kind === "payload" && tab.payload?.module === "database") {
            ids.add(tab.payload.id);
          }
        }
      }
      if (ids.size === 0) return EMPTY_DOCKED_DATABASE_TABS;
      return [...ids].sort();
    }),
  );
  const currentWorkspaceId = useWorkspaceStore((s) => s.workspace.id);
  const wsTabStore = useWorkspaceTabStore;

  // Refs for workspace switch (access current state from event listener)
  const workspaceTabsRef = useRef(workspaceTabs);
  workspaceTabsRef.current = workspaceTabs;
  const sqlTabStatesRef = useRef(sqlTabStates);
  sqlTabStatesRef.current = sqlTabStates;
  const tablePreviewsRef = useRef(tablePreviews);
  tablePreviewsRef.current = tablePreviews;
  const tabModesRef = useRef(tabModes);
  tabModesRef.current = tabModes;
  const tableDesignerStatesRef = useRef(tableDesignerStates);
  tableDesignerStatesRef.current = tableDesignerStates;

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

  const sqlConnections = useMemo(
    () =>
      connections.filter(
        (conn) => isSqlCapableConnection(conn) && isConnectionEnabled(conn),
      ),
    [connections],
  );

  const toolboxConnections = useMemo(
    () =>
      connections.filter(
        (conn) => isToolboxCapableConnection(conn) && isConnectionEnabled(conn),
      ),
    [connections],
  );

  const activeConn = useMemo(
    () => groupConnections.find((c) => c.id === activeConnId) ?? groupConnections[0] ?? null,
    [groupConnections, activeConnId],
  );

  const dbPoolKind: PoolKind =
    activeConn?.db_type?.toLowerCase() === "redis" ? "redis" : "database";
  usePoolConnectionRegistration(dbPoolKind, moduleLive ? activeConn?.id ?? null : null);

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

  const persistSqlFileState = useCallback((tabId: string, state: SqlTabState) => {
    const tab = workspaceTabsRef.current.find(
      (item): item is SqlWorkspaceTab => item.id === tabId && item.kind === "sql",
    );
    if (!tab?.sqlFileId) {
      return;
    }
    const store = useDbSqlFileStore.getState();
    store.updateFileSql(tab.sqlFileId, state.sql);
    store.updateFileBinding(tab.sqlFileId, state.connId, state.database);
  }, []);

  const syncSqlFileTabHeaderMeta = useCallback(
    (tabId: string, dirty: boolean, savedOverride?: boolean) => {
      const tab = workspaceTabsRef.current.find(
        (item): item is SqlWorkspaceTab => item.id === tabId && item.kind === "sql",
      );
      if (!tab || tablePreviewsRef.current[tab.id]?.tableName) {
        return;
      }
      patchDockTabFileMeta(tabId, {
        type: "file",
        dirty,
        saved: savedOverride ?? (Boolean(tab.sqlFileId) && !dirty),
      });
    },
    [],
  );

  const updateSqlTabState = useCallback((tabId: string, patch: Partial<SqlTabState>) => {
    const shouldPersist =
      patch.sql !== undefined || patch.connId !== undefined || patch.database !== undefined;
    let nextStateForPersist: SqlTabState | null = null;

    setSqlTabStates((prev) => {
      const nextState = { ...(prev[tabId] ?? createDefaultSqlTabState()), ...patch };
      if (shouldPersist) {
        nextStateForPersist = nextState;
      }
      return { ...prev, [tabId]: nextState };
    });

    if (nextStateForPersist) {
      persistSqlFileState(tabId, nextStateForPersist);
    }

    if (patch.sql !== undefined || patch.connId !== undefined || patch.database !== undefined) {
      const tab = workspaceTabsRef.current.find((item) => item.id === tabId);
      if (tab?.kind === "sql") {
        setDirtySqlWorkspaceTabIds((prev) => {
          if (prev.has(tabId)) return prev;
          const next = new Set(prev);
          next.add(tabId);
          return next;
        });
        syncSqlFileTabHeaderMeta(tabId, true);
      }
    }
  }, [persistSqlFileState, syncSqlFileTabHeaderMeta]);

  const setSqlTabConnection = useCallback(
    (tabId: string, connId: string | null) => {
      updateSqlTabState(tabId, { connId: connId ?? "", database: "" });
    },
    [updateSqlTabState],
  );

  const updateTableDesignerState = useCallback((tabId: string, state: TableDesignerTabState) => {
    setTableDesignerStates((prev) => ({ ...prev, [tabId]: state }));
  }, []);

  const isDesignerTabDirty = useCallback(
    (tabId: string) => {
      const tab = workspaceTabs.find((item) => item.id === tabId);
      if (!tab || tab.kind !== "designer") {
        return false;
      }
      const state = tableDesignerStates[tabId];
      if (!state) {
        return false;
      }
      const connection = connections.find((item) => item.id === tab.connId);
      if (!connection) {
        return false;
      }
      return resolveTableDesignerDriver(connection).hasModelChanges(state.baseline, state.model);
    },
    [connections, tableDesignerStates, workspaceTabs],
  );

  const refreshConnections = useCallback(async () => {
    setConnectionsLoading(true);
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
      // 连接列表加载失败时保留当前状态
    } finally {
      setConnectionsLoading(false);
    }
  }, [activeGroupName]);

  useEffect(() => {
    void refreshConnections();
  }, [schemaRefreshToken, refreshConnections]);

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
        const base = snap
          ? restoreSqlTabStateFromSnapshot(snap)
          : createDefaultSqlTabState();
        restoredSql[tab.id] =
          tab.sqlFileId != null
            ? resolveSqlTabStateFromFile(tab.sqlFileId, base)
            : base;
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
          sort: meta.sort ?? null,
        };
      }
      setTablePreviews(restoredPreviews);
      setTabModes(session.tabModes);

      const restoredDesigner: Record<string, TableDesignerTabState> = {};
      for (const [tabId, snap] of Object.entries(session.tableDesignerStates ?? {})) {
        restoredDesigner[tabId] = restoreTableDesignerStateFromSnapshot(snap);
      }
      setTableDesignerStates(restoredDesigner);

      const activeTab = session.tabs.find((tab) => tab.id === session.activeTabId);
      if (activeTab?.kind === "database" || activeTab?.kind === "connection") {
        setActiveConnId(activeTab.connId);
      } else if (activeTab?.kind === "designer") {
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
        tableDesignerStates,
      }),
    );
  }, [
    workspaceInitialized,
    workspaceTabs,
    activeWorkspaceTabId,
    sqlTabStates,
    tablePreviews,
    tabModes,
    tableDesignerStates,
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

      const sort = meta.sort ?? null;
      const orderBy = sort ? buildOrderByClause(sort, connection.db_type) : undefined;
      void Promise.all([
        countTable(connForSchema, meta.tableName, meta.dbName),
        previewTable(connForSchema, meta.tableName, meta.pageSize, meta.page * meta.pageSize, orderBy),
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
              sort,
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
              sort,
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

  const toolboxSeed = useMemo(() => {
    if (!activeSqlTabId) {
      return { connId: null as string | null, database: "" };
    }
    const connId = resolveSqlTabConnectionId(activeSqlTabId, sqlTabStates, tablePreviews);
    const database = sqlTabStates[activeSqlTabId]?.database?.trim() ?? "";
    if (!connId || !database) {
      return { connId: null, database: "" };
    }
    const conn = connections.find((item) => item.id === connId);
    if (!conn || !isSqlCapableConnection(conn)) {
      return { connId: null, database: "" };
    }
    return { connId, database };
  }, [activeSqlTabId, sqlTabStates, tablePreviews, connections]);

  const referencedSqlConnIds = useMemo(() => {
    const ids = new Set<string>();
    if (activeConn) {
      ids.add(activeConn.id);
    }
    for (const tab of workspaceTabs) {
      if (tab.kind !== "sql") {
        continue;
      }
      const connId = resolveSqlTabConnectionId(tab.id, sqlTabStates, tablePreviews);
      if (connId) {
        ids.add(connId);
      }
    }
    return ids;
  }, [activeConn, workspaceTabs, sqlTabStates, tablePreviews]);

  const resolveSqlTabConnection = useCallback(
    (tabId: string): DbConnectionConfig | null => {
      const connId = resolveSqlTabConnectionId(tabId, sqlTabStates, tablePreviews);
      if (!connId) {
        return null;
      }
      const conn = connections.find((item) => item.id === connId);
      if (!conn || !isConnectionEnabled(conn)) {
        return null;
      }
      if (!tablePreviews[tabId]?.connId && !isSqlCapableConnection(conn)) {
        return null;
      }
      return conn;
    },
    [connections, sqlTabStates, tablePreviews],
  );

  const databaseFilters = useDbSchemaFilterStore((s) => s.databaseFilters);
  const hydrateSchemaFilters = useDbSchemaFilterStore((s) => s.hydrate);
  const setDatabaseFilters = useDbSchemaFilterStore((s) => s.setDatabaseFilters);
  const filtersHydrated = useDbSchemaFilterStore((s) => s.hydrated);
  const hydrateSchemaCache = useDbSchemaCacheStore((s) => s.hydrate);
  const cacheHydrated = useDbSchemaCacheStore((s) => s.hydrated);
  const schemaSnapshot = useDbSchemaCacheStore((s) => s.snapshot);

  const getSqlTabDatabases = useCallback(
    (tabId: string): string[] => {
      const conn = resolveSqlTabConnection(tabId);
      if (!conn) {
        return [];
      }
      const all = databasesByConnId[conn.id] ?? [];
      return getVisibleNames(all, databaseFilters[conn.id]);
    },
    [resolveSqlTabConnection, databasesByConnId, databaseFilters],
  );

  const connectionForSqlTab = useCallback(
    (tabId: string): DbConnectionConfig | null => {
      const conn = resolveSqlTabConnection(tabId);
      const database = sqlTabStates[tabId]?.database.trim() ?? "";
      if (!conn || !database) {
        return null;
      }
      return { ...conn, database };
    },
    [resolveSqlTabConnection, sqlTabStates],
  );

  const getSqlCompletionSchemas = useCallback(
    (tabId: string): DatabaseSchema[] => {
      const conn = resolveSqlTabConnection(tabId);
      const database = sqlTabStates[tabId]?.database.trim() ?? "";
      if (!conn || !database) {
        return [];
      }
      const key = `${conn.id}:${database}`;
      const cached = schemaByKey[key];
      if (cached) {
        return [cached];
      }
      return [buildDatabaseSchema(database, [])];
    },
    [resolveSqlTabConnection, sqlTabStates, schemaByKey],
  );

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
    if (!cacheHydrated) {
      return;
    }
    for (const connId of referencedSqlConnIds) {
      const names = getCachedDatabaseNames(schemaSnapshot, connId);
      if (names.length === 0) {
        continue;
      }
      setDatabasesByConnId((prev) => {
        const current = prev[connId];
        if (current && current.length === names.length && current.every((name, index) => name === names[index])) {
          return prev;
        }
        return { ...prev, [connId]: names };
      });
      setDatabaseFilters((prev) => ({
        ...prev,
        [connId]: mergeFilter(prev[connId], names),
      }));
    }
  }, [referencedSqlConnIds, cacheHydrated, schemaSnapshot, setDatabaseFilters]);

  useEffect(() => {
    if (!cacheHydrated) {
      return;
    }
    let cancelled = false;
    for (const connId of referencedSqlConnIds) {
      const connection = connections.find((item) => item.id === connId);
      if (!connection || !isConnectionEnabled(connection)) {
        continue;
      }
      const cachedNames = getCachedDatabaseNames(schemaSnapshot, connId);
      if (cachedNames.length > 0) {
        continue;
      }
      void listDatabases(connection)
        .then((names) => {
          if (cancelled || names.length === 0) {
            return;
          }
          setDatabasesByConnId((prev) => {
            if (prev[connId]?.length) {
              return prev;
            }
            return { ...prev, [connId]: names };
          });
          setDatabaseFilters((prev) => ({
            ...prev,
            [connId]: mergeFilter(prev[connId], names),
          }));
        })
        .catch(() => {
          // 忽略：用户可在 Schema 侧栏手动刷新
        });
    }
    return () => {
      cancelled = true;
    };
  }, [referencedSqlConnIds, cacheHydrated, schemaSnapshot, connections, setDatabaseFilters]);

  useEffect(() => {
    if (!cacheHydrated) {
      return;
    }
    for (const tab of workspaceTabs) {
      if (tab.kind !== "sql") {
        continue;
      }
      const conn = resolveSqlTabConnection(tab.id);
      const database = sqlTabStates[tab.id]?.database.trim() ?? "";
      if (!conn || !database) {
        continue;
      }
      const key = `${conn.id}:${database}`;
      if (schemaByKey[key]) {
        continue;
      }
      const dbEntry = schemaSnapshot.connections[conn.id]?.databases.find(
        (entry) => entry.name === database,
      );
      if (!dbEntry) {
        continue;
      }
      const tables = introspectToTableSchemas(dbEntry.tables);
      setSchemaByKey((prev) => ({
        ...prev,
        [key]: buildDatabaseSchema(database, tables),
      }));
    }
  }, [
    workspaceTabs,
    sqlTabStates,
    resolveSqlTabConnection,
    schemaByKey,
    cacheHydrated,
    schemaSnapshot,
  ]);

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
      if (connection.db_type !== "redis") {
        void introspectTable(connection, dbName, tableName)
          .then((schema) => {
            setTableColumnMeta((prevMeta) => ({ ...prevMeta, [tabId]: schema.columns }));
          })
          .catch(() => {});
      }
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
        const orderBy = existing.sort
          ? buildOrderByClause(existing.sort, connection.db_type)
          : undefined;

        Promise.all([
          countTable(connForSchema, tableName, dbName),
          previewTable(connForSchema, tableName, pageSize, page * pageSize, orderBy),
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
        const orderBy = existing.sort
          ? buildOrderByClause(existing.sort, connection.db_type)
          : undefined;

        previewTable(connForSchema, tableName, pageSize, page * pageSize, orderBy)
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

  const setTableSort = useCallback(
    (tabId: string, sort: SortState | null) => {
      const preview = tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      const connection = connections.find((c) => c.id === preview.connId);
      if (!connection) return;
      const connForSchema = { ...connection, database: preview.dbName };

      setTablePreviews((prev) => {
        const existing = prev[tabId] ?? createDefaultTablePreviewState();
        const pageSize = existing.pageSize;
        const orderBy = sort ? buildOrderByClause(sort, connection.db_type) : undefined;

        Promise.all([
          countTable(connForSchema, preview.tableName!, preview.dbName!),
          previewTable(connForSchema, preview.tableName!, pageSize, 0, orderBy),
        ])
          .then(([totalRows, data]) => {
            setTablePreviews((p) => {
              const cur = p[tabId];
              if (!cur) return p;
              return {
                ...p,
                [tabId]: {
                  ...cur,
                  loading: false,
                  error: null,
                  data,
                  totalRows,
                  page: 0,
                  sort,
                },
              };
            });
          })
          .catch((e) => {
            setTablePreviews((p) => {
              const cur = p[tabId];
              if (!cur) return p;
              return {
                ...p,
                [tabId]: {
                  ...cur,
                  loading: false,
                  error: typeof e === "string" ? e : String(e),
                  sort,
                },
              };
            });
          });

        return { ...prev, [tabId]: { ...existing, loading: true, sort } };
      });
    },
    [tablePreviews, connections],
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
          if (rowKey.startsWith(NEW_ROW_KEY_PREFIX)) {
            const entries = Object.entries(changes);
            if (entries.length === 0) continue;
            const cols = entries.map(([col]) => `\`${col}\``);
            const vals = entries.map(([, val]) => escape(val));
            sqls.push(
              `INSERT INTO \`${tableName}\` (${cols.join(", ")}) VALUES (${vals.join(", ")})`,
            );
            continue;
          }
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
    const tab = workspaceTabsRef.current.find((item) => item.id === tabId);
    if (tab) {
      pushRecentClosedPanel(
        buildClosedPanelEntry({
          tab,
          sqlTabStates: sqlTabStatesRef.current,
          tablePreviews: tablePreviewsRef.current,
          tableDesignerStates: tableDesignerStatesRef.current,
          tabModes: tabModesRef.current,
        }),
      );
    }
    setDirtySqlWorkspaceTabIds((prev) => {
      if (!prev.has(tabId)) return prev;
      const next = new Set(prev);
      next.delete(tabId);
      return next;
    });
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
    setTableDesignerStates((prev) => {
      if (!(tabId in prev)) {
        return prev;
      }
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
  }, [pushRecentClosedPanel]);

  const reopenRecentClosedPanel = useCallback(
    (entry: DbClosedPanelEntry) => {
      const { tab } = entry;

      if (tab.kind === "sql" && tab.sqlFileId) {
        const existing = findTabIdForSqlFile(workspaceTabsRef.current, tab.sqlFileId);
        if (existing) {
          setActiveWorkspaceTabId(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
        const file = useDbSqlFileStore.getState().getNode(tab.sqlFileId);
        if (!file || file.type !== "file") {
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (tab.kind === "database") {
        const existing = findTabIdForDatabase(
          workspaceTabsRef.current,
          tab.connId,
          tab.dbName,
        );
        if (existing) {
          setActiveWorkspaceTabId(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (tab.kind === "connection") {
        const existing = findTabIdForConnection(workspaceTabsRef.current, tab.connId);
        if (existing) {
          setActiveWorkspaceTabId(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (tab.kind === "designer") {
        const existing = findTabIdForDesigner(
          workspaceTabsRef.current,
          tab.connId,
          tab.dbName,
          tab.tableName,
        );
        if (existing) {
          setActiveWorkspaceTabId(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (entry.tablePreviewMeta) {
        const meta = entry.tablePreviewMeta;
        const existing = findTabIdForTable(
          tablePreviewsRef.current,
          workspaceTabsRef.current.map((item) => item.id),
          meta.connId,
          meta.dbName,
          meta.tableName,
        );
        if (existing) {
          setActiveWorkspaceTabId(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (workspaceTabsRef.current.some((item) => item.id === tab.id)) {
        setActiveWorkspaceTabId(tab.id);
        removeRecentClosedPanel(entry.closedAt);
        return;
      }

      setWorkspaceTabs((prev) => [...prev, tab]);
      setActiveWorkspaceTabId(tab.id);

      if (tab.kind === "sql" && entry.sqlTabState) {
        const snap = entry.sqlTabState;
        const base = snap
          ? restoreSqlTabStateFromSnapshot(snap)
          : createDefaultSqlTabState();
        setSqlTabStates((prev) => ({
          ...prev,
          [tab.id]:
            tab.sqlFileId != null
              ? resolveSqlTabStateFromFile(tab.sqlFileId, base)
              : base,
        }));
      }

      if (entry.tabMode) {
        setTabModes((prev) => ({ ...prev, [tab.id]: entry.tabMode! }));
      }

      if (entry.tableDesignerState) {
        setTableDesignerStates((prev) => ({
          ...prev,
          [tab.id]: restoreTableDesignerStateFromSnapshot(entry.tableDesignerState!),
        }));
      }

      if (entry.tablePreviewMeta) {
        const meta = entry.tablePreviewMeta;
        setTablePreviews((prev) => ({
          ...prev,
          [tab.id]: {
            ...createDefaultTablePreviewState(),
            loading: true,
            connId: meta.connId,
            dbName: meta.dbName,
            tableName: meta.tableName,
            page: meta.page,
            pageSize: meta.pageSize,
            sort: meta.sort ?? null,
          },
        }));
        const connection = connections.find((item) => item.id === meta.connId);
        if (connection) {
          queueMicrotask(() => {
            void loadTablePreview(tab.id, connection, meta.dbName, meta.tableName);
            if (connection.db_type !== "redis") {
              void introspectTable(connection, meta.dbName, meta.tableName)
                .then((schema) => {
                  setTableColumnMeta((prev) => ({
                    ...prev,
                    [tab.id]: schema.columns,
                  }));
                })
                .catch(() => {});
            }
          });
        }
      }

      removeRecentClosedPanel(entry.closedAt);
    },
    [connections, loadTablePreview, removeRecentClosedPanel],
  );

  const hasDirty = useCallback(
    (tabId: string) => Object.keys(tabDirtyRows[tabId] ?? {}).length > 0,
    [tabDirtyRows],
  );

  const executeTabAction = useCallback(
    (action: { kind: "refresh" | "page" | "close" | "sort"; tabId: string; page?: number; sort?: SortState | null }) => {
      if (action.kind === "refresh") {
        refreshTabPreviewNow(action.tabId);
      } else if (action.kind === "page") {
        goToPageNow(action.tabId, action.page ?? 0);
      } else if (action.kind === "sort") {
        setTableSort(action.tabId, action.sort ?? null);
      } else {
        closeWorkspaceTab(action.tabId);
      }
    },
    [refreshTabPreviewNow, goToPageNow, setTableSort, closeWorkspaceTab],
  );

  const requestTabAction = useCallback(
    (action: { kind: "refresh" | "page" | "close" | "sort"; tabId: string; page?: number; sort?: SortState | null }) => {
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

  const handleRowEdit = useCallback(
    (tabId: string, cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> }) => {
      const pendingKey = cellInfo.row[PENDING_INSERT_ROW_KEY];
      setRowEdit({
        tabId,
        column: cellInfo.column,
        row: cellInfo.row,
        isNewRow: typeof pendingKey === "string",
      });
    },
    [],
  );

  const handleRowNew = useCallback(
    (tabId: string) => {
      const colMeta = tableColumnMeta[tabId];
      if (!colMeta?.length) return;
      const firstEditable = colMeta.find((c) => !c.isPk) ?? colMeta[0];
      setRowEdit({
        tabId,
        column: firstEditable.name,
        row: {},
        isNewRow: true,
      });
    },
    [tableColumnMeta],
  );

  const resolveConnection = useCallback(
    (connId: string) => connections.find((c) => c.id === connId) ?? null,
    [connections],
  );

  const isSameCellValue = useCallback((originalValue: unknown, value: unknown) => {
    return (
      originalValue === value ||
      (originalValue == null && value === "") ||
      (originalValue === "" && value == null) ||
      (typeof originalValue === "number" &&
        typeof value === "string" &&
        String(originalValue) === value)
    );
  }, []);

  const commitCellDirtyChange = useCallback(
    (
      tabId: string,
      column: string,
      row: Record<string, unknown>,
      value: unknown,
    ) => {
      const colMeta = tableColumnMeta[tabId];
      if (!colMeta) return;
      const meta = colMeta.find((c) => c.name === column);
      if (!meta || meta.isPk) return;

      const pendingKey = row[PENDING_INSERT_ROW_KEY];
      if (typeof pendingKey === "string") {
        setTabDirtyRows((prev) => {
          const cur = { ...(prev[tabId] ?? {}) };
          const rowDirty = { ...(cur[pendingKey] ?? {}) };
          const originalValue = row[column];
          if (isSameCellValue(originalValue, value)) {
            delete rowDirty[column];
          } else if (value === null || value === undefined) {
            rowDirty[column] = null;
          } else {
            rowDirty[column] = value;
          }
          if (Object.keys(rowDirty).length === 0) {
            delete cur[pendingKey];
          } else {
            cur[pendingKey] = rowDirty;
          }
          if (Object.keys(cur).length === 0) {
            const next = { ...prev };
            delete next[tabId];
            return next;
          }
          return { ...prev, [tabId]: cur };
        });
        return;
      }

      const pkCols = colMeta.filter((c) => c.isPk);
      if (pkCols.length === 0) return;
      const originalValue = row[column];
      if (isSameCellValue(originalValue, value)) return;

      const rowKey = pkCols
        .map((pk) => `${pk.name}=${row[pk.name] == null ? "" : String(row[pk.name])}`)
        .join("&");

      setTabDirtyRows((prev) => {
        const cur = { ...(prev[tabId] ?? {}) };
        const rowDirty = { ...(cur[rowKey] ?? {}) };
        if (value === null || value === undefined) {
          rowDirty[column] = null;
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
    },
    [tableColumnMeta, isSameCellValue],
  );

  const handleCellSetNull = useCallback(
    (
      tabId: string,
      cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> },
    ) => {
      commitCellDirtyChange(tabId, cellInfo.column, cellInfo.row, null);
    },
    [commitCellDirtyChange],
  );

  const handleRowSave = useCallback(
    (changes: Record<string, unknown>) => {
      if (!rowEdit) return;
      const { tabId, row, isNewRow } = rowEdit;
      const colMeta = tableColumnMeta[tabId];
      if (!colMeta) {
        setRowEdit(null);
        return;
      }

      if (isNewRow) {
        const pendingKey = row[PENDING_INSERT_ROW_KEY];
        const rowKey =
          typeof pendingKey === "string" ? pendingKey : `${NEW_ROW_KEY_PREFIX}${crypto.randomUUID()}`;
        setTabDirtyRows((prev) => {
          const cur = { ...(prev[tabId] ?? {}) };
          cur[rowKey] = { ...changes };
          return { ...prev, [tabId]: cur };
        });
        setRowEdit(null);
        return;
      }

      const pkCols = colMeta.filter((c) => c.isPk);
      if (pkCols.length === 0) {
        setRowEdit(null);
        return;
      }
      const rowKey = pkCols
        .map((pk) => `${pk.name}=${row[pk.name] == null ? "" : String(row[pk.name])}`)
        .join("&");

      setTabDirtyRows((prev) => {
        const cur = { ...(prev[tabId] ?? {}) };
        const rowDirty = { ...(cur[rowKey] ?? {}) };

        for (const [column, value] of Object.entries(changes)) {
          const meta = colMeta.find((c) => c.name === column);
          if (!meta) continue;
          const originalValue = row[column];
          if (isSameCellValue(originalValue, value)) {
            delete rowDirty[column];
          } else if (value === null || value === undefined) {
            rowDirty[column] = value;
          } else {
            rowDirty[column] = value;
          }
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
      setRowEdit(null);
    },
    [rowEdit, tableColumnMeta, isSameCellValue],
  );

  const handleCellSave = useCallback(
    (value: unknown) => {
      if (!cellEdit) return;
      commitCellDirtyChange(cellEdit.tabId, cellEdit.column, cellEdit.row, value);
      setCellEdit(null);
    },
    [cellEdit, commitCellDirtyChange],
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
      const connId = preview?.connId ?? sqlTabStates[tabId]?.connId;
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
    [sqlTabStates, tablePreviews, connections],
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

  const handleDesignTable = useCallback(
    (selection: SchemaTableSelection) => {
      if (!supportsTableDesign(selection.connection)) {
        return;
      }

      const existingTabId = findTabIdForDesigner(
        workspaceTabs,
        selection.connId,
        selection.dbName,
        selection.tableName,
      );
      if (existingTabId) {
        setActiveWorkspaceTabId(existingTabId);
        return;
      }

      const tabId = makeDesignerTabId();
      const tab: TableDesignerWorkspaceTab = {
        id: tabId,
        kind: "designer",
        label: makeTableDesignerTabLabel(selection.dbName, selection.tableName),
        connId: selection.connId,
        dbName: selection.dbName,
        tableName: selection.tableName,
      };
      setWorkspaceTabs((prev) => [...prev, tab]);
      setActiveWorkspaceTabId(tabId);
    },
    [workspaceTabs],
  );

  const buildTableContextMenuItems = useCallback(() => {
    const copyIcon = (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <rect x="5" y="5" width="9" height="9" rx="1.5" />
        <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" />
      </svg>
    );
    const designIcon = (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
        <path d="M5 8h6M8 5v6" />
      </svg>
    );
    const selection = tableCtxMenu?.selection;
    const canDesign = selection ? supportsTableDesign(selection.connection) : false;
    return [
      {
        id: "design-table",
        label: t("database.contextMenu.designTable"),
        icon: designIcon,
        disabled: !canDesign,
        onClick: () => {
          if (!selection) return;
          handleDesignTable(selection);
        },
      },
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
  }, [t, copyDdlForCurrentTable, copyNameForCurrentTable, handleDesignTable, tableCtxMenu?.selection]);

  const refreshConnDatabases = useCallback(
    (connId: string) => {
      const conn = connections.find((c) => c.id === connId);
      if (!conn || !isConnectionEnabled(conn)) {
        return;
      }
      const { setConnectionRefreshing, patchConnection } = useDbSchemaCacheStore.getState();
      setConnectionRefreshing(connId, true);
      void refreshConnectionSchemaCache(conn)
        .then(async (entry) => {
          await patchConnection(connId, entry);
          const names = entry.databases.map((db) => db.name);
          setDatabasesByConnId((prev) => ({ ...prev, [connId]: names }));
          setDatabaseFilters((prev) => ({
            ...prev,
            [connId]: mergeFilter(prev[connId], names),
          }));
        })
        .finally(() => {
          setConnectionRefreshing(connId, false);
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
        const existingTab = workspaceTabs.find((item) => item.id === existingTabId);
        if (existingTab) {
          syncDatabaseTableTabToWorkspace(existingTab, tabModes[existingTabId] ?? "data");
        }
        if (selection.connection.db_type !== "redis") {
          queueMicrotask(() => {
            void introspectTable(selection.connection, selection.dbName, selection.tableName)
              .then((schema) => {
                setTableColumnMeta((prev) => {
                  if (prev[existingTabId]?.length) return prev;
                  return { ...prev, [existingTabId]: schema.columns };
                });
              })
              .catch(() => {});
          });
        }
        return;
      }

      const tabId = makeSqlTabId();
      const newTab: SqlWorkspaceTab = {
        id: tabId,
        kind: "sql",
        label: makeTableTabLabel(selection.dbName, selection.tableName),
      };

      // Create a SQL tab with collapsed editor for table preview
      setWorkspaceTabs((prev) => [...prev, newTab]);
      setActiveWorkspaceTabId(tabId);
      setTabModes((prev) => ({ ...prev, [tabId]: "data" }));
      syncDatabaseTableTabToWorkspace(newTab, "data");

      // Set the database for the SQL tab
      setSqlTabStates((prev) => ({
        ...prev,
        [tabId]: {
          ...createDefaultSqlTabState(selection.dbName, selection.connId),
          sql: `SELECT * FROM \`${selection.tableName}\` LIMIT 100;`,
        },
      }));

      // Initialize preview metadata (before loadTablePreview's async updates)
      setTablePreviews((prev) => ({
        ...prev,
        [tabId]: { ...createDefaultTablePreviewState(), loading: true, connId: selection.connId, dbName: selection.dbName, tableName: selection.tableName },
      }));

      queueMicrotask(() => {
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
      });
    },
    [loadTablePreview, tabModes, tablePreviews, workspaceTabs],
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
    if (activeWorkspaceTab?.kind === "database" || activeWorkspaceTab?.kind === "connection") {
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
  const openSqlFile = useCallback(
    (file: DbSqlFileNode) => {
      const existingTabId = findTabIdForSqlFile(workspaceTabs, file.id);
      if (existingTabId) {
        setActiveWorkspaceTabId(existingTabId);
        syncSqlFileTabHeaderMeta(
          existingTabId,
          dirtySqlWorkspaceTabIds.has(existingTabId),
        );
        return;
      }
      const tabId = makeSqlTabId();
      const tab: SqlWorkspaceTab = {
        id: tabId,
        kind: "sql",
        label: file.name.replace(/\.sql$/i, ""),
        sqlFileId: file.id,
      };
      setSqlTabStates((prev) => ({
        ...prev,
        [tabId]: {
          ...createDefaultSqlTabState(file.database ?? "", file.connId ?? ""),
          sql: file.sql ?? "",
        },
      }));
      setWorkspaceTabs((prev) => [...prev, tab]);
      setActiveWorkspaceTabId(tabId);
      setTabModes((prev) => ({ ...prev, [tabId]: "sql" }));
      syncSqlFileTabHeaderMeta(tabId, false);
    },
    [workspaceTabs, dirtySqlWorkspaceTabIds, syncSqlFileTabHeaderMeta],
  );

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

      const existingTabId = findTabIdForConnection(workspaceTabs, connId);
      if (existingTabId) {
        setActiveWorkspaceTabId(existingTabId);
        return;
      }

      const tabId = makeConnectionInfoTabId();
      const tab: ConnectionInfoWorkspaceTab = {
        id: tabId,
        kind: "connection",
        label: conn.name,
        connId,
      };
      setWorkspaceTabs((prev) => [...prev, tab]);
      setActiveWorkspaceTabId(tabId);
    },
    [connections, groups, setActiveConnId, setActiveGroupId, workspaceTabs],
  );

  const runQuery = useCallback(async (sqlOverride?: string, tabIdOverride?: string) => {
    const tabId = tabIdOverride ?? activeWorkspaceTab?.id;
    const tab = tabId ? workspaceTabs.find((t) => t.id === tabId) : null;
    if (!tab || tab.kind !== "sql") {
      return;
    }
    const resolvedTabId = tab.id;
    const tabState = sqlTabStates[resolvedTabId] ?? createDefaultSqlTabState();
    const conn = connectionForSqlTab(resolvedTabId);
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
        limit: DEFAULT_QUERY_LIMIT,
        offset: 0,
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
    connectionForSqlTab,
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

  const isSqlTabDirty = useCallback(
    (tabId: string) => dirtySqlWorkspaceTabIds.has(tabId),
    [dirtySqlWorkspaceTabIds],
  );

  const saveSqlTab = useCallback(
    async (tabIdOverride?: string) => {
      const tabId = tabIdOverride ?? activeWorkspaceTabId;
      if (!tabId) return;

      const tab = workspaceTabsRef.current.find(
        (item): item is SqlWorkspaceTab => item.id === tabId && item.kind === "sql",
      );
      if (!tab) return;

      const state = sqlTabStates[tabId] ?? createDefaultSqlTabState();
      const store = useDbSqlFileStore.getState();

      if (tab.sqlFileId) {
        store.updateFileSql(tab.sqlFileId, state.sql);
        store.updateFileBinding(tab.sqlFileId, state.connId, state.database);
        await store.flushToDisk();
        setDirtySqlWorkspaceTabIds((prev) => {
          if (!prev.has(tabId)) return prev;
          const next = new Set(prev);
          next.delete(tabId);
          return next;
        });
        syncSqlFileTabHeaderMeta(tabId, false);
        return;
      }

      const name = await quickInput({
        title: t("database.queryFiles.saveAsTitle"),
        placeholder: t("database.queryFiles.fileNamePlaceholder"),
        defaultValue: t("database.queryFiles.defaultFileName"),
        validate: (value) =>
          value.trim() ? null : t("database.queryFiles.nameRequired"),
      });
      if (!name) return;

      const file = store.addFile(null, name.trim(), state.sql);
      store.updateFileBinding(file.id, state.connId, state.database);
      setWorkspaceTabs((prev) =>
        prev.map((item) =>
          item.id === tabId
            ? {
                ...item,
                label: file.name.replace(/\.sql$/i, ""),
                sqlFileId: file.id,
              }
            : item,
        ),
      );
      setDirtySqlWorkspaceTabIds((prev) => {
        if (!prev.has(tabId)) return prev;
        const next = new Set(prev);
        next.delete(tabId);
        return next;
      });
      syncSqlFileTabHeaderMeta(tabId, false, true);
      await store.flushToDisk();
    },
    [activeWorkspaceTabId, sqlTabStates, t, syncSqlFileTabHeaderMeta],
  );

  useEffect(() => {
    if (!isActiveRoute) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s" || e.shiftKey || e.altKey) {
        return;
      }
      if (isSqlMonacoEditorFocused()) return;
      if (!activeWorkspaceTabId) return;
      const tab = workspaceTabsRef.current.find((item) => item.id === activeWorkspaceTabId);
      if (!tab || tab.kind !== "sql") return;
      e.preventDefault();
      e.stopPropagation();
      void saveSqlTab(activeWorkspaceTabId);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isActiveRoute, activeWorkspaceTabId, saveSqlTab]);

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
    setTableSort,
    handleCellEdit,
    handleRowEdit,
    handleCellSetNull,
    handleRowNew,
    resolveConnection,
    connectionsLoading,
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
    sqlConnections,
    groupConnections,
    databasesByConnId,
    schemaByKey,
    schemaLoadingKey,
    resolveSqlTabConnection,
    getSqlTabDatabases,
    getSqlCompletionSchemas,
    connectionForSqlTab,
    setSqlTabConnection,
    rowsToRecord,
    tabModeToEditorOpenMode,
    saveSqlTab,
    isSqlTabDirty,
  }), [
    workspaceTabs, activeWorkspaceTabId, setActiveWorkspaceTabId, requestTabAction,
    runQuery, updateSqlTabState, refreshTablePreview, goToPage, handleCellEdit, handleRowEdit, handleCellSetNull, handleRowNew, resolveConnection, connectionsLoading, handleSelectTable,
    activeTableKey,
    sqlTabStates, tablePreviews, tableColumnMeta, tabModes, tabDirtyRows, committingTabs,
    commitTabDirty, sqlConnections, groupConnections, databasesByConnId,
    schemaByKey, schemaLoadingKey, resolveSqlTabConnection, getSqlTabDatabases,
    getSqlCompletionSchemas, connectionForSqlTab, setSqlTabConnection,
    saveSqlTab, isSqlTabDirty,
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
              closable: true,
            };
          }
          if (tab.kind === "connection") {
            return {
              id: tab.id,
              label: tab.label,
              panelType: "database",
              icon: "database" as const,
              tooltip: t("database.connectionInfo.subtitle"),
              closable: true,
            };
          }
          if (tab.kind === "designer") {
            const dirty = isDesignerTabDirty(tab.id);
            return {
              id: tab.id,
              label: tab.label,
              panelType: "database",
              type: "file" as const,
              dirty,
              saved: !dirty,
              icon: "table" as const,
              tooltip: t("database.tableDesigner.tabTooltip", { label: tab.label }),
              closable: true,
            };
          }
          const isTableTab = Boolean(tablePreviews[tab.id]?.tableName);
          const dirty = isTableTab ? false : dirtySqlWorkspaceTabIds.has(tab.id);
          const saved = !isTableTab && Boolean(tab.sqlFileId) && !dirty;
          return {
            id: tab.id,
            label: tab.label,
            panelType: "database",
            ...(!isTableTab
              ? { type: "file" as const, dirty, saved }
              : {}),
            icon: isTableTab ? ("table" as const) : ("sql" as const),
            tooltip: tab.label,
            closable: true,
          };
        }),
    [workspaceTabs, isOriginDocked, tablePreviews, dirtySqlWorkspaceTabIds, isDesignerTabDirty, t],
  );

  const recentClosedActionItems = useMemo(
    () =>
      [...recentClosedPanels]
        .sort((a, b) => b.closedAt - a.closedAt)
        .slice(0, 5)
        .map((entry) => ({
          id: String(entry.closedAt),
          label: entry.tab.label,
          meta: new Date(entry.closedAt).toLocaleString(),
          onClick: () => reopenRecentClosedPanel(entry),
        })),
    [recentClosedPanels, reopenRecentClosedPanel],
  );

  const renderDockPanel = useCallback(
    (tabId: string) => {
      const tab = workspaceTabs.find((item) => item.id === tabId);
      if (!tab) return null;

      if (tab.kind === "database") {
        return (
          <ConnectionResolvedDockPane connId={tab.connId}>
            {(connection) => {
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
                    onDesignTable={handleDesignTable}
                  />
                </div>
              );
            }}
          </ConnectionResolvedDockPane>
        );
      }

      if (tab.kind === "connection") {
        return (
          <ConnectionResolvedDockPane connId={tab.connId}>
            {(connection) => (
              <div className="db-workspace-pane db-dock-pane">
                <DatabaseConnectionInfoPanel connection={connection} />
              </div>
            )}
          </ConnectionResolvedDockPane>
        );
      }

      if (tab.kind === "designer") {
        return (
          <ConnectionResolvedDockPane
            connId={tab.connId}
            className="db-workspace-pane db-dock-pane db-workspace-pane--designer"
            missingFallback={
              <div className="db-workspace-pane db-dock-pane db-workspace-pane--designer">
                <div className="db-table-designer-state db-table-designer-state--error">
                  {t("database.tableDesigner.loadFailed")}
                </div>
              </div>
            }
          >
            {(connection) => (
              <div className="db-workspace-pane db-dock-pane db-workspace-pane--designer">
                <TableDesignerDockPane
                  connection={connection}
                  dbName={tab.dbName}
                  tableName={tab.tableName}
                  persistedState={tableDesignerStates[tab.id] ?? null}
                  onPersistState={(state) => updateTableDesignerState(tab.id, state)}
                  onSaved={() => setSchemaRefreshToken((token) => token + 1)}
                />
              </div>
            )}
          </ConnectionResolvedDockPane>
        );
      }

      return (
        <div className="db-workspace-pane db-dock-pane">
          <DbPanelSurface tab={tab} />
        </div>
      );
    },
    [workspaceTabs, handleSelectTable, handleDesignTable, tableDesignerStates, updateTableDesignerState, t],
  );

  const handleDockTabContextMenu = useCallback(
    (event: ReactMouseEvent, tabId: string, index: number) => {
      setCtxMenu({ x: event.clientX, y: event.clientY, tabId, index });
    },
    [],
  );

  const handleCtrlCopyTab = useCallback(
    (tabId: string) => {
      const ctxTab = workspaceTabs.find((tab) => tab.id === tabId);
      if (!ctxTab) return;
      addSnapshotToWorkspace(
        currentWorkspaceId,
        dbTabToSnapshot(ctxTab, tabModes[ctxTab.id]),
      );
    },
    [workspaceTabs, tabModes, currentWorkspaceId],
  );

  useEffect(() => {
    if (isActiveRoute) return;
    setCtxMenu(null);
    setTableCtxMenu(null);
    setConnCtxMenu(null);
    setExportMenu(null);
  }, [isActiveRoute]);

  const modulePanelContentKey = useMemo(
    () =>
      buildDatabaseModulePanelContentKey({
        moduleTab,
      }),
    [moduleTab],
  );

  const moduleSoftRefreshKey = useMemo(
    () => [
      connections.map((c) => c.id).join(","),
      connectionsLoading ? "1" : "0",
      workspaceTabs.map((t) => t.id).join(","),
    ].join("|"),
    [connections, connectionsLoading, workspaceTabs],
  );

  const panelContentKeysByTab = useMemo(
    () =>
      buildDatabasePanelContentKeysByTab({
        workspaceTabs,
        activeWorkspaceTabId,
        sqlTabStates,
        tablePreviews,
        tableDesignerStates,
        tabModes,
        connections,
      }),
    [
      workspaceTabs,
      activeWorkspaceTabId,
      sqlTabStates,
      tablePreviews,
      tableDesignerStates,
      tabModes,
      connections,
    ],
  );

  const schemaContextValue = useMemo(
    () => ({
      groupConnections,
      databasesByConnId,
      schemaByKey,
      schemaLoadingKey,
    }),
    [groupConnections, databasesByConnId, schemaByKey, schemaLoadingKey],
  );

  const databaseModuleContext = useMemo(
    () =>
      resolveDatabaseModuleContext(
        connections,
        activeConnId,
        activeWorkspaceTab,
        sqlTabStates,
        tablePreviews,
      ),
    [
      connections,
      activeConnId,
      activeWorkspaceTab,
      sqlTabStates,
      tablePreviews,
    ],
  );

  return (
    <>
    <DatabaseModuleContextBridge active={moduleLive} context={databaseModuleContext} />
    <DbWorkspaceProvider value={ctxValue}>
    <ModuleSegmentDock
      className="db-module-dock"
      enabled={moduleLive}
      panelContentKey={modulePanelContentKey}
      softRefreshKey={moduleSoftRefreshKey}
      tabs={moduleSegmentTabs}
      activeTabId={moduleTab}
      onActiveTabChange={(id) => setModuleTab(id as DbModuleTab)}
      renderPanel={(panelId) =>
        panelId === "transfer" ? (
    moduleTab === "transfer" ? (
    <div className="db-module-transfer">
      <DatabaseToolbox
        active
        connections={toolboxConnections}
        initialSourceConnectionId={
          toolboxSeed.connId ??
          (activeConn && isToolboxCapableConnection(activeConn) ? activeConn.id : null)
        }
        initialSourceDatabase={toolboxSeed.database}
      />
    </div>
    ) : null
  ) : (
    <>
      <SidebarWorkspace
        preset="schema"
        sidebarMinPx={280}
        sidebar={
          <DbSchemaProvider value={schemaContextValue}>
            <DatabaseSchemaSidebar
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
              onOpenSqlFile={openSqlFile}
              onSelectTable={handleSelectTable}
              onSelectDatabase={handleSelectDatabase}
              onContextTable={handleContextTable}
              onContextConnection={handleContextConnection}
              activeTableKey={activeTableKey}
              activeDatabaseKey={activeDatabaseKey}
              refreshToken={schemaRefreshToken}
              connectionConfigs={connections}
              connectionsReady={!connectionsLoading || connections.length > 0}
            />
          </DbSchemaProvider>
        }
      >
        <div
          className="db-workspace-drop-zone"
          data-schema-drop-type="workspace"
          {...{ [SCHEMA_TREE_DROP_ZONE_ATTR]: "" }}
        >
        {!workspaceInitialized ? null : (
          <DatabaseWorkspaceDock
            workspaceInitialized={workspaceInitialized}
            dockTabs={dockTabs}
            activeWorkspaceTabId={activeWorkspaceTabId}
            onActiveTabChange={setActiveWorkspaceTabId}
            onCloseTab={(tabId) => requestTabAction({ kind: "close", tabId })}
            dockLayout={dockLayout}
            onDockLayoutChange={setDockLayout}
            renderDockPanel={renderDockPanel}
            panelContentKeysByTab={panelContentKeysByTab}
            onTabContextMenu={handleDockTabContextMenu}
            onCtrlCopyTab={handleCtrlCopyTab}
            canAcceptSchemaTreeDrop={canAcceptSchemaTreeDrop}
            onExternalSchemaDrop={handleExternalSchemaDrop}
            recentClosedActionItems={recentClosedActionItems}
            emptyPrompt={t("database.workspace.emptyTabs")}
            recentClosedTitle={t("database.workspace.recentClosed")}
          />
        )}
        </div>
      </SidebarWorkspace>
    </>
  )
      }
    />
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
                variant="default"
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
    </DbWorkspaceProvider>
    <DatabaseTableEditorHost
      cellEdit={cellEdit}
      rowEdit={rowEdit}
      tableColumnMeta={tableColumnMeta}
      tabDirtyRows={tabDirtyRows}
      onCellSave={handleCellSave}
      onCellCancel={() => setCellEdit(null)}
      onRowSave={handleRowSave}
      onRowCancel={() => setRowEdit(null)}
    />
    {isActiveRoute && ctxMenu && (() => {
      const closeItems = buildTabCloseMenuItems(
        t,
        workspaceTabs.length,
        ctxMenu.index,
        handleContextAction,
        { showRename: true },
      );
      return (
        <ContextMenu
          items={closeItems}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
        />
      );
    })()}
    {isActiveRoute && tableCtxMenu && (
      <ContextMenu
        items={buildTableContextMenuItems()}
        position={{ x: tableCtxMenu.x, y: tableCtxMenu.y }}
        onClose={() => setTableCtxMenu(null)}
      />
    )}
    {isActiveRoute && connCtxMenu && (
      <ContextMenu
        items={buildConnContextMenuItems()}
        position={{ x: connCtxMenu.x, y: connCtxMenu.y }}
        onClose={() => setConnCtxMenu(null)}
      />
    )}
    {isActiveRoute && exportMenu && (
      <ContextMenu
        items={buildExportMenuItems()}
        position={{ x: exportMenu.x, y: exportMenu.y }}
        onClose={() => setExportMenu(null)}
      />
    )}
    </>
  );
}
