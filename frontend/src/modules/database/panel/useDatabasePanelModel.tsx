import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import type { SchemaDatabaseSelection, SchemaTableSelection, SchemaContextMenuContext } from "../schema/SchemaBrowser";
import type { SchemaTreeItem } from "../schema/schemaTreeItem";
import { CONNECTION_TAG_KINDS } from "../../tags/tagKinds";
import { passTagFilter, useModuleTagFilter } from "../../tags/useModuleTagFilter";
import { resolveDatabaseModuleContext } from "../ai";
import { DatabaseTablesPanel } from "../workspace/DatabaseTablesPanel";
import { DatabaseSlowQueryLogPanel } from "../workspace/DatabaseSlowQueryLogPanel";
import { DialectSlowQueryPanel } from "../workspace/DialectSlowQueryPanel";
import { DatabaseBinlogPanel } from "../workspace/DatabaseBinlogPanel";
import { RedisQueryPanel } from "../redis/RedisQueryPanel";
import { ConnectionInfoSlot } from "../workbench/ConnectionInfoSlot";
import { ConnectionResolvedDockPane } from "../workspace/ConnectionResolvedDockPane";
import { useDbMysqlLogNavStore } from "../stores/dbMysqlLogNavStore";
import { yieldToMain } from "../../../lib/yieldToMain";
import {
  applyTablePreviewDataProgressive,
  bumpTablePreviewApplyGeneration } from "../workspace/applyTablePreviewData";
import { buildDatabaseSchemaContextMenuItems } from "./buildDatabaseSchemaContextMenu";
import { useDatabasePanelSql } from "./useDatabasePanelSql";
import { useDatabasePanelTablePreview } from "./useDatabasePanelTablePreview";
import { useDatabasePanelDockTabs } from "./useDatabasePanelDockTabs";
import { useDatabasePanelConnections } from "./useDatabasePanelConnections";
import { useDatabasePanelMysqlTransfer } from "./useDatabasePanelMysqlTransfer";
import {
  useDatabasePanelCsvExport,
  writeToClipboard,
} from "./useDatabasePanelCsvExport";
import { useActionStore } from "../../../stores/actionStore";
import { useDbSchemaFilterStore } from "../../../stores/dbSchemaFilterStore";
import { useResourceProfileNavStore } from "../../../lib/resource/resourceProfileNavStore";
import { useUiFollowConsumer } from "../../../lib/ai/uiFollow";
import { useDbSchemaTreeExpandedStore } from "../../../stores/dbSchemaTreeExpandedStore";
import { useDbSchemaCacheStore } from "../../../stores/dbSchemaCacheStore";
import { usePoolConnectionRegistration, type PoolKind } from "../../../stores/connectionPoolStore";
import { useConnectionStore } from "../../../stores/connectionStore";
import { usePluginRuntimeStore } from "../../../stores/pluginRuntimeStore";
import { getVisibleNames, makeTableFilterKey, mergeFilter } from "../schema/DatabaseFilterDialog";
import { useI18n } from "../../../i18n";
import { showToast } from "../../../stores/toastStore";
import { quickInput } from "../../../lib/quickInput";
import { useModuleRouteActive } from "../../../lib/useModuleRouteActive";
import {
  getDatabaseSessionService } from "../databaseSessionService";
import type { DbSqlFileNode } from "../../../stores/dbSqlFileStore";
import { resolveSqlTabStateFromFile, useDbSqlFileStore } from "../../../stores/dbSqlFileStore";
import {
  formatTreeChartFileLabel,
  useDbTreeChartFileStore,
  type DbTreeChartFileNode } from "../../../stores/dbTreeChartFileStore";
import { useDbScratchQueryStore } from "../../../stores/dbScratchQueryStore";
import {
  fetchTableDdl,
  introspectTable,
  listDatabases,
  isMysqlConnectionInfoCapable,
  isConnectionEnabled,
  isSqlCapableConnection,
  isRedisConnection,
  isToolboxCapableConnection,
  type DbConnectionConfig } from "../api";
import { ensureCatalogEngines, ensureEngineForDbType } from "../ensureCatalogEngines";
import { isEngineReady } from "../engineRegistry";
import { buildDatabaseSchema, introspectToTableSchemas } from "../sqlEditor/language/completionItems";
import { sqlRequiresDatabaseContext } from "../sqlIntel/connectionLevelSql";
import { fetchAndApplyTableColumnMeta } from "../shared/columnMetaUtils";
import { buildRedisColumnMeta } from "../redis/redisTableMeta";
import { getCachedDatabaseNames, getCachedTableColumns } from "../schema/schemaCacheMerge";
import type { SchemaCacheConnectionEntry } from "../schema/schemaCache";
import { submitSchemaCacheRefresh, probeDbConnectionRuntime, isSchemaCacheEntryOk } from "../schema/schemaCacheBackgroundTasks";
import { takeBootstrappedDbConnections } from "../schema/initDbSchemaUiStores";
import { warmPrioritySchemaConnections } from "../schema/schemaWarmPriority";
import { useDbConnectionRuntimeStore } from "../../../stores/dbConnectionRuntimeStore";
import { createSchemaCacheRefreshReporter } from "../schema/schemaCacheStatusLog";
import { type SlowLogAvailability } from "../mysqlSlowQueryLog";
import { type BinlogAvailability } from "../mysqlBinlog";
import { parseDatabaseNodeId, parseTableNodeId } from "../schema/schemaTreeIds";
import type { DatabaseSchema } from "../types";
import {
  makeSqlTabId,
  makeTableTabId,
  makeDatabaseTabId,
  makeDatabaseTabKey,
  findTabIdForDatabase,
  findTabIdForConnection,
  findTabIdForSqlFile,
  findTabIdForTreeChartFile,
  makeTableTabLabel,
  makeTableTabKey,
  findTabIdForTable,
  findTabIdForDesigner,
  findTabIdForRedisQuery,
  findTabIdForSlowQueryLog,
  findTabIdForBinlog,
  findPreviewDockTab,
  makeDesignerTabId,
  makeConnectionInfoTabId,
  makeSlowQueryLogTabId,
  makeBinlogTabId,
  makeRedisQueryTabId,
  isModuleDockTab,
  isToolboxTab,
  makeSyncTaskWorkspaceTab,
  makeTableDesignerTabLabel,
  makeSqlTabLabel,
  makeTreeChartTabId,
  makeTreeChartTabLabel,
  makeDatabaseListTabLabel,
  makeConnectionTabLabel,
  makeConnectionScopedTabLabel,
  SCRATCH_SQL_TAB_ID,
  findScratchSqlTabId,
  type SchemaDockOpenMode,
  type ConnectionInfoWorkspaceTab,
  type SlowQueryLogWorkspaceTab,
  type BinlogWorkspaceTab,
  type DbWorkspaceTab,
  type RedisQueryWorkspaceTab,
  type SqlWorkspaceTab,
  type TableDesignerWorkspaceTab,
  type TablePreviewWorkspaceTab,
  type TreeChartWorkspaceTab,
} from "../workspace/workspaceTabs";
import { TreeChartPanel } from "../treeChart/TreeChartPanel";
import { DatabaseToolbox } from "../toolbox/DatabaseToolbox";
import { TableDesignerDockPane } from "../tableDesigner/TableDesignerDockPane";
import { supportsTableDesign, resolveTableDesignerDriver } from "../tableDesigner/resolveTableDesignerDriver";
import { useDbSyncTaskStore } from "../../../stores/dbSyncTaskStore";
import {
  createDefaultSqlTabState,
  createDefaultTablePreviewState,
  resolveSqlTabConnectionId,
  rowsToRecord,
  tabModeToEditorOpenMode,
  normalizeSortStates,
  type SqlTabState,
  type TableDesignerTabState,
  type TablePreviewState,
} from "../workspace/dbWorkspaceState";
import {
  buildDatabasePanelContentKeysByTab,
  buildSqlTabPanelKeySeed,
  selectTablePreviewTabIdKey,
} from "../workspace/databasePanelTabKeys";
import { DbPanelSurface } from "../workspace/DbPanelSurface";
import { DbTablePreviewSurface } from "../workspace/DbTablePreviewSurface";
import { DbDockTabActive, DbDockTabVisible } from "../workspace/DbDockTabActive";
import { collectOpenTabNodeIds } from "../schema/resolveDbSidebarLinkage";
import { useDbSidebarLinkageStore } from "../../../stores/dbSidebarLinkageStore";
import { buildSelectAllFromTableSql } from "../grid/tablePreviewFilter";
import { resolveSqlQueryBindingContext } from "../sql/resolveSqlQueryBindingContext";
import { fetchTablePreviewPage } from "../grid/tablePreviewQuery";
import { patchDockTabPreviewMeta } from "../../../components/dock/dockTabLiveMeta";
import type {
  DbWorkspaceMirrorContextValue,
  DbWorkspaceSharedContextValue,
} from "../../../contexts/DbWorkspaceContext.types";
import { useDbDockLayoutStore } from "../../../stores/dbDockLayoutStore";
import {
  schedulePersistWorkspaceSession,
  flushPersistWorkspaceSession,
  useDbWorkspaceSessionStore,
} from "../../../stores/dbWorkspaceSessionStore";
import {
  buildWorkspaceSessionSnapshot,
  restoreTableDesignerStateFromSnapshot,
  sanitizeWorkspaceSession,
  tablePreviewStateFromSnapshot,
} from "../workspace/dbWorkspaceSession";
import { useWorkspaceBottomDockStore } from "../../../stores/workspaceBottomDockStore";
import { publishDbWorkspaceMirror } from "../../../stores/dbWorkspaceMirrorStore";
import {
  EMPTY_TAB_DIRTY_ROWS,
  selectDbTabWorkspaceMirrorSlice,
  useDbWorkspaceTabStore,
} from "../../../stores/dbWorkspaceTabStore";
import { usePersistedModuleTab } from "../../../hooks/usePersistedModuleTab";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { useDbWorkspaceDockTabsStore } from "../../../stores/dbWorkspaceDockTabsStore";
import {
  applyDefaultWorkspaceSession,
  restoreSqlTabStateFromSnapshot,
  tabMatchesConnectionSelection,
  tabMatchesDatabaseSelection,
  tabMatchesTableSelection,
} from "../workspace/dbWorkspaceTabHelpers";
import { connectionNodeId } from "../schema/schemaTreeExpanded";
import type { NavicatImportPreviewItem } from "../navicatImport/types";

type DbModuleTab = "query" | "dataSync" | "schemaSync";
const DB_MODULE_TABS: DbModuleTab[] = ["query", "dataSync", "schemaSync"];
const EMPTY_DOCKED_DATABASE_TABS: string[] = [];


export function useDatabasePanelModel() {
  const { t } = useI18n();
  usePluginRuntimeStore((s) => s.items);
  const schemaCacheReporter = useMemo(() => createSchemaCacheRefreshReporter(t), [t]);
  const { isActiveRoute, moduleLive } = useModuleRouteActive("database");
  const [moduleTab, setModuleTab] = usePersistedModuleTab(
    "database-workspace",
    "query",
    DB_MODULE_TABS,
  );

  useEffect(() => {
    try {
      const raw = localStorage.getItem("omnipanel-module-tabs.v1");
      if (!raw) return;
      const data = JSON.parse(raw) as { state?: { byModule?: Record<string, string> } };
      if (data?.state?.byModule?.["database-workspace"] === "transfer") {
        setModuleTab("dataSync");
      }
    } catch {
      // ignore invalid persisted tab state
    }
  }, [setModuleTab]);
  const enqueueAction = useActionStore((s) => s.enqueueAction);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<{
    fileName: string;
    items: NavicatImportPreviewItem[];
  } | null>(null);
  const [editingConnection, setEditingConnection] = useState<DbConnectionConfig | null>(null);
  const [schemaRefreshToken, setSchemaRefreshToken] = useState(0);

  const [connections, setConnections] = useState<DbConnectionConfig[]>(() => {
    return takeBootstrappedDbConnections() ?? [];
  });
  const tagAllowedIds = useModuleTagFilter("database", CONNECTION_TAG_KINDS);
  const sidebarConnections = useMemo(
    () => connections.filter((conn) => passTagFilter(tagAllowedIds, conn.id)),
    [connections, tagAllowedIds],
  );
  const [connectionsLoading, setConnectionsLoading] = useState(() => {
    return takeBootstrappedDbConnections() === null;
  });
  const sshConnections = useConnectionStore(
    useShallow((state) => state.connections.filter((conn) => conn.kind === "ssh")),
  );
  const [slowLogAvailabilityByConnId, setSlowLogAvailabilityByConnId] = useState<
    Record<string, SlowLogAvailability>
  >({});
  const [binlogAvailabilityByConnId, setBinlogAvailabilityByConnId] = useState<
    Record<string, BinlogAvailability>
  >({});
  const [activeConnId, setActiveConnId] = useState<string | null>(null);

  const setActiveConnIdIfChanged = useCallback((connId: string | null) => {
    setActiveConnId((prev) => (prev === connId ? prev : connId));
  }, []);

  const setSqlTabStates = useDbWorkspaceTabStore((state) => state.setSqlTabStates);
  const setTablePreviews = useDbWorkspaceTabStore((state) => state.setTablePreviews);
  const setTableColumnMeta = useDbWorkspaceTabStore((state) => state.setTableColumnMeta);
  const setTabModes = useDbWorkspaceTabStore((state) => state.setTabModes);
  const setTabDirtyRows = useDbWorkspaceTabStore((state) => state.setTabDirtyRows);
  const setCommittingTabs = useDbWorkspaceTabStore((state) => state.setCommittingTabs);
  const removeTabWorkspaceData = useDbWorkspaceTabStore((state) => state.removeTabWorkspaceData);

  const workspaceTabsRef = useRef<DbWorkspaceTab[]>([]);
  const openConnectionInfoTabRef = useRef<
    (connId: string, mode?: SchemaDockOpenMode, options?: { expandTree?: boolean }) => void
  >(() => {});
  const workspaceTabs = useDbWorkspaceDockTabsStore((s) => s.tabs);
  const setWorkspaceTabs = useDbWorkspaceDockTabsStore((s) => s.setTabs);
  const workspaceInitialized = useDbWorkspaceDockTabsStore((s) => s.initialized);
  const setWorkspaceInitialized = useDbWorkspaceDockTabsStore((s) => s.setInitialized);
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] = useState("");

  useEffect(() => {
    if (!moduleLive || !activeWorkspaceTabId) return;
    return getDatabaseSessionService().bindView(activeWorkspaceTabId, {
      push: () => {
        /* Tab 列表在 dockTabsStore；此处仅绑定 View 生命周期 */
      } });
  }, [moduleLive, activeWorkspaceTabId]);

  const recentClosedPanels = useDbWorkspaceSessionStore((s) => s.recentClosedPanels);
  const pushRecentClosedPanel = useDbWorkspaceSessionStore((s) => s.pushRecentClosedPanel);
  const removeRecentClosedPanel = useDbWorkspaceSessionStore((s) => s.removeRecentClosedPanel);
  /** SQL 工作区 Tab 未保存标记（按 tabId；与 store.dirtyFileIds 解耦，保证 Tab 头即时更新） */
  const [dirtySqlWorkspaceTabIds, setDirtySqlWorkspaceTabIds] = useState<Set<string>>(
    () => new Set(),
  );
  const tablePreviewRestoreDoneRef = useRef(false);
  const [tableDesignerStates, setTableDesignerStates] = useState<Record<string, TableDesignerTabState>>({});
  const [databasesByConnId, setDatabasesByConnId] = useState<Record<string, string[]>>({});
  const [schemaByKey, setSchemaByKey] = useState<Record<string, DatabaseSchema>>({});
  const [schemaLoadingKey] = useState<string | null>(null);
  const [rowEdit, setRowEdit] = useState<{
    tabId: string;
    column: string;
    row: Record<string, unknown>;
    isNewRow?: boolean;
  } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabId: string; index: number } | null>(null);
  const updateSchemaExpanded = useDbSchemaTreeExpandedStore((s) => s.updateExpanded);

  const [createDbDialog, setCreateDbDialog] = useState<
    | {
        connId: string;
      }
    | null
  >(null);
  // 勿订阅 savedLayout：切 Tab 会频繁写 layout，订阅会拖垮整页（侧栏+面板）
  const setDockLayout = useDbDockLayoutStore((s) => s.setSavedLayout);

  const referencedDatabaseTabIds = useWorkspaceBottomDockStore(
    useShallow((s) => {
      const ids = new Set<string>();
      for (const tabs of Object.values(s.tabsByWorkspace)) {
        for (const tab of tabs ?? []) {
          // payload kind: payload.module === "database" → payload.id
          if (tab.kind === "payload" && tab.payload?.module === "database") {
            ids.add(tab.payload.id);
          }
          // mirrored kind: originScope === "database" → originPanelId
          if (tab.kind === "mirrored" && tab.originScope === "database" && tab.originPanelId) {
            ids.add(tab.originPanelId);
          }
        }
      }
      if (ids.size === 0) return EMPTY_DOCKED_DATABASE_TABS;
      return [...ids].sort();
    }),
  );
  // Refs for workspace switch (access current state from event listener)
  workspaceTabsRef.current = workspaceTabs;
  const activeWorkspaceTabIdRef = useRef(activeWorkspaceTabId);
  activeWorkspaceTabIdRef.current = activeWorkspaceTabId;
  const activeSyncTaskTabRef = useRef("");
  const hasReconciledModuleTabRef = useRef(false);
  const tableDesignerStatesRef = useRef(tableDesignerStates);
  tableDesignerStatesRef.current = tableDesignerStates;

  const tablePreviewTabIdKey = useMemo(
    () => selectTablePreviewTabIdKey(useDbWorkspaceTabStore.getState(), workspaceTabs),
    [workspaceTabs],
  );
  const tablePreviewTabIds = useMemo(
    () => new Set(tablePreviewTabIdKey ? tablePreviewTabIdKey.split(",") : []),
    [tablePreviewTabIdKey],
  );
  const sqlTabPanelKeySeed = useDbWorkspaceTabStore((state) =>
    buildSqlTabPanelKeySeed(workspaceTabs, state),
  );

  const syncTasks = useDbSyncTaskStore((s) => s.tasks);

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
    () => connections.find((c) => c.id === activeConnId) ?? connections[0] ?? null,
    [connections, activeConnId],
  );

  const dbPoolKind: PoolKind =
    activeConn?.db_type?.toLowerCase() === "redis" ? "redis" : "database";
  usePoolConnectionRegistration(dbPoolKind, moduleLive ? activeConn?.id ?? null : null);

  const activeWorkspaceTab = useMemo(
    () => workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? null,
    [workspaceTabs, activeWorkspaceTabId],
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

  const closeWorkspaceTabsRef = useRef<(tabIds: string[]) => void>(() => {});
  const closeWorkspaceTabsViaRef = useCallback((tabIds: string[]) => {
    closeWorkspaceTabsRef.current(tabIds);
  }, []);

  const {
    refreshConnections,
    handleImportConnections,
    resolveSlowLogDisabledReason,
    resolveBinlogDisabledReason,
    ensureSlowLogAvailability,
    ensureBinlogAvailability,
    toggleConnectionEnabled,
    handleDeleteConnection } = useDatabasePanelConnections({
    connections,
    setConnections,
    setConnectionsLoading,
    setActiveConnId,
    setImportPreview,
    t,
    schemaRefreshToken,
    setSchemaRefreshToken,
    slowLogAvailabilityByConnId,
    setSlowLogAvailabilityByConnId,
    binlogAvailabilityByConnId,
    setBinlogAvailabilityByConnId,
    sshConnections,
    updateSchemaExpanded,
    workspaceTabsRef,
    closeWorkspaceTabs: closeWorkspaceTabsViaRef,
    setDatabasesByConnId,
    setCreateDbDialog,
    editingConnection,
    setEditingConnection,
    setDialogOpen });

  const {
    exportDialog,
    setExportDialog,
    exportSubmitting,
    importDialog,
    setImportDialog,
    importSubmitting,
    handleExportDatabase,
    handleConfirmExportDatabase,
    handleOpenImportDatabase,
    handleConfirmImportDatabase,
  } = useDatabasePanelMysqlTransfer({
    t,
    sshConnections,
    schemaCacheReporter,
    openConnectionInfoTabRef,
  });

  const {
    csvExportDialog,
    setCsvExportDialog,
    exportMenu,
    setExportMenu,
    buildExportMenuItems,
  } = useDatabasePanelCsvExport({
    connections,
    t,
  });

  useEffect(() => {
    void ensureCatalogEngines();
  }, []);


  // 工作区就绪后：仅对 Tab 引用的连接做真实连通探测（失败静默，不刷控制台）
  useEffect(() => {
    if (!workspaceInitialized || connectionsLoading) {
      return;
    }
    void warmPrioritySchemaConnections(schemaCacheReporter, {
      workspaceTabs: workspaceTabsRef.current }).catch(() => {
      // probe 已 quiet；避免进入模块就上报 IPC 错误
    });
    // 只在会话初始化后跑一次；之后靠打开连接/库/表时 probe
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional once after workspace init
  }, [workspaceInitialized, connectionsLoading, schemaCacheReporter]);

  useEffect(() => {
    if (!workspaceInitialized) {
      return;
    }
    const persist = () => {
      const tabs = workspaceTabsRef.current;
      const moduleTabs = tabs.filter(isModuleDockTab);
      if (moduleTabs.length === 0) {
        useDbDockLayoutStore.getState().setSavedLayout(null);
        schedulePersistWorkspaceSession(null);
        flushPersistWorkspaceSession();
        return;
      }
      const tabState = useDbWorkspaceTabStore.getState();
      const snapshot = buildWorkspaceSessionSnapshot({
        tabs,
        activeTabId: activeWorkspaceTabIdRef.current,
        sqlTabStates: tabState.sqlTabStates,
        tablePreviews: tabState.tablePreviews,
        tabModes: tabState.tabModes,
        tableDesignerStates: tableDesignerStatesRef.current });
      schedulePersistWorkspaceSession(snapshot.tabs.length > 0 ? snapshot : null);
    };
    persist();
    return useDbWorkspaceTabStore.subscribe(persist);
  }, [workspaceInitialized, workspaceTabs]);

  useEffect(() => {
    if (!workspaceInitialized) {
      hasReconciledModuleTabRef.current = false;
      return;
    }
    if (hasReconciledModuleTabRef.current) {
      return;
    }
    hasReconciledModuleTabRef.current = true;

    const activeTab = workspaceTabs.find((item) => item.id === activeWorkspaceTabId);
    if (activeTab && isToolboxTab(activeTab)) {
      setModuleTab((prev) => (prev === activeTab.toolboxTab ? prev : activeTab.toolboxTab));
      return;
    }
  }, [
    workspaceInitialized,
    workspaceTabs,
    activeWorkspaceTabId,
    moduleTab,
    setModuleTab,
  ]);

  useEffect(() => {
    if (!workspaceInitialized || !activeWorkspaceTabId) {
      return;
    }
    const tab = workspaceTabs.find((item) => item.id === activeWorkspaceTabId);
    const tabChanged = activeSyncTaskTabRef.current !== activeWorkspaceTabId;
    activeSyncTaskTabRef.current = activeWorkspaceTabId;

    if (isToolboxTab(tab)) {
      setModuleTab((prev) => (prev === tab.toolboxTab ? prev : tab.toolboxTab));
      if (tab.syncTaskId) {
        useDbSyncTaskStore.getState().setActiveTaskId(tab.syncTaskId);
        if (tabChanged) {
          useDbSyncTaskStore.getState().requestLoad(tab.syncTaskId, false);
        }
      }
      return;
    }
    setModuleTab((prev) => (prev === "query" ? prev : "query"));
  }, [workspaceInitialized, workspaceTabs, activeWorkspaceTabId, setModuleTab]);


  useEffect(() => {
    if (!workspaceInitialized) {
      return;
    }
    const taskIds = new Set(syncTasks.map((task) => task.id));
    setWorkspaceTabs((prev) => {
      const next = prev.filter(
        (tab) => tab.kind !== "toolbox" || !tab.syncTaskId || taskIds.has(tab.syncTaskId),
      );
      return next.length === prev.length ? prev : next;
    });
  }, [workspaceInitialized, syncTasks, setWorkspaceTabs]);

  useEffect(() => {
    if (!workspaceInitialized) {
      return;
    }
    setWorkspaceTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        if (tab.kind !== "toolbox" || !tab.syncTaskId) {
          return tab;
        }
        const task = syncTasks.find((item) => item.id === tab.syncTaskId);
        if (!task) {
          return tab;
        }
        const syncAction =
          task.kind === "schemaSync"
            ? t("database.workspace.tabAction.schemaSync")
            : t("database.workspace.tabAction.dataSync");
        const nextLabel = makeSyncTaskWorkspaceTab(task, syncAction).label;
        if (tab.label === nextLabel && tab.toolboxTab === task.kind) {
          return tab;
        }
        changed = true;
        return { ...tab, label: nextLabel, toolboxTab: task.kind };
      });
      return changed ? next : prev;
    });
  }, [workspaceInitialized, syncTasks, setWorkspaceTabs, t]);

  useEffect(() => {
    const flush = () => flushPersistWorkspaceSession();
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  useEffect(() => {
    if (!workspaceInitialized || connections.length === 0 || tablePreviewRestoreDoneRef.current) {
      return;
    }

    const session = sanitizeWorkspaceSession(useDbWorkspaceSessionStore.getState().session);
    const tableTabs = session?.tabs.filter((tab) => tab.kind === "table") ?? [];
    if (tableTabs.length === 0) {
      tablePreviewRestoreDoneRef.current = true;
      return;
    }

    tablePreviewRestoreDoneRef.current = true;

    for (const tab of tableTabs) {
      if (tab.kind !== "table") {
        continue;
      }
      const previewState = session!.tablePreviewStates[tab.id];
      const connection = connections.find((item) => item.id === tab.connId);
      if (!connection) {
        setTablePreviews((prev) => ({
          ...prev,
          [tab.id]: tablePreviewStateFromSnapshot(previewState, tab, {
            loading: false,
            error: "Connection not found" }) }));
        continue;
      }

      void introspectTable(connection, tab.dbName, tab.tableName)
        .then((schema) => {
          if (connection.db_type !== "redis") {
            setTableColumnMeta((prev) => ({ ...prev, [tab.id]: schema.columns }));
          }
        })
        .catch(() => {});

      const sort = normalizeSortStates(previewState?.sort);
      const filter = previewState?.filter ?? null;
      const columnRelations = previewState?.columnRelations ?? {};
      const hiddenColumns = previewState?.hiddenColumns ? [...previewState.hiddenColumns] : [];
      const transposed = previewState?.transposed ?? false;
      const page = previewState?.page ?? 0;
      const pageSize = previewState?.pageSize ?? createDefaultTablePreviewState().pageSize;
      const applyGeneration = bumpTablePreviewApplyGeneration(tab.id);
      void fetchTablePreviewPage({
        connection,
        connId: tab.connId,
        tableName: tab.tableName,
        dbName: tab.dbName,
        page,
        pageSize,
        sort,
        filter,
        columnMeta: useDbWorkspaceTabStore.getState().tableColumnMeta[tab.id],
        columnRelations })
        .then(async ({ data, totalRows = 0 }) => {
          if (connection.db_type === "redis") {
            setTableColumnMeta((prev) => ({
              ...prev,
              [tab.id]: buildRedisColumnMeta(data.columns) }));
          }
          await yieldToMain();
          await applyTablePreviewDataProgressive({
            tabId: tab.id,
            data,
            totalRows,
            page,
            pageSize,
            setTablePreviews,
            generation: applyGeneration,
            canvasMode: true });
          setTablePreviews((prev) => ({
            ...prev,
            [tab.id]: {
              ...(prev[tab.id] ?? createDefaultTablePreviewState()),
              loading: false,
              error: null,
              connId: tab.connId,
              dbName: tab.dbName,
              tableName: tab.tableName,
              sort,
              filter,
              hiddenColumns,
              transposed,
              columnRelations,
              totalRows,
              page,
              pageSize } }));
        })
        .catch((error) => {
          bumpTablePreviewApplyGeneration(tab.id);
          setTablePreviews((prev) => ({
            ...prev,
            [tab.id]: {
              ...(prev[tab.id] ?? createDefaultTablePreviewState()),
              loading: false,
              error: typeof error === "string" ? error : String(error),
              connId: tab.connId,
              dbName: tab.dbName,
              tableName: tab.tableName,
              page,
              pageSize,
              sort,
              filter,
              hiddenColumns,
              transposed,
              columnRelations } }));
        });
    }
  }, [workspaceInitialized, connections]);

  useEffect(() => {
    setActiveConnId((prev) => {
      if (prev && connections.some((item) => item.id === prev)) {
        return prev;
      }
      return connections[0]?.id ?? null;
    });
  }, [connections]);

  const activeSqlTabId =
    activeWorkspaceTab?.kind === "sql" ? activeWorkspaceTab.id : null;

  const activeSqlTabConnDb = useDbWorkspaceTabStore(
    useShallow((state) => {
      if (!activeSqlTabId) return null;
      const connId = resolveSqlTabConnectionId(
        activeSqlTabId,
        state.sqlTabStates,
        state.tablePreviews,
      );
      const database = state.sqlTabStates[activeSqlTabId]?.database?.trim() ?? "";
      return connId && database ? { connId, database } : null;
    }),
  );

  const toolboxSeed = useMemo(() => {
    if (!activeSqlTabConnDb) {
      return { connId: null as string | null, database: "" };
    }
    const conn = connections.find((item) => item.id === activeSqlTabConnDb.connId);
    if (!conn || !isSqlCapableConnection(conn)) {
      return { connId: null, database: "" };
    }
    return { connId: activeSqlTabConnDb.connId, database: activeSqlTabConnDb.database };
  }, [activeSqlTabConnDb, connections]);

  const sqlTabConnFingerprint = useDbWorkspaceTabStore((state) => {
    const parts: string[] = [];
    for (const tab of workspaceTabs) {
      if (tab.kind !== "sql") continue;
      const connId = resolveSqlTabConnectionId(tab.id, state.sqlTabStates, state.tablePreviews);
      if (connId) parts.push(`${tab.id}:${connId}`);
    }
    return parts.sort().join(",");
  });

  const referencedSqlConnIds = useMemo(() => {
    const { sqlTabStates, tablePreviews } = useDbWorkspaceTabStore.getState();
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
  }, [activeConn, workspaceTabs, sqlTabConnFingerprint]);

  const resolveSqlTabConnection = useCallback(
    (tabId: string): DbConnectionConfig | null => {
      const { sqlTabStates, tablePreviews } = useDbWorkspaceTabStore.getState();
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
    [connections],
  );

  const databaseFilters = useDbSchemaFilterStore((s) => s.databaseFilters);
  const hydrateSchemaFilters = useDbSchemaFilterStore((s) => s.hydrate);
  const setDatabaseFilters = useDbSchemaFilterStore((s) => s.setDatabaseFilters);
  const setTableFilters = useDbSchemaFilterStore((s) => s.setTableFilters);
  const filtersHydrated = useDbSchemaFilterStore((s) => s.hydrated);
  const hydrateSchemaCache = useDbSchemaCacheStore((s) => s.hydrate);
  const cacheHydrated = useDbSchemaCacheStore((s) => s.hydrated);
  const schemaRevision = useDbSchemaCacheStore((s) => s.revision);

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
    (tabId: string, sql?: string): DbConnectionConfig | null => {
      const conn = resolveSqlTabConnection(tabId);
      if (!conn) {
        return null;
      }
      const database = useDbWorkspaceTabStore.getState().sqlTabStates[tabId]?.database.trim() ?? "";
      if (database) {
        return { ...conn, database };
      }
      const probe = sql?.trim();
      if (probe && !sqlRequiresDatabaseContext(probe)) {
        return { ...conn, database: conn.database?.trim() ?? "" };
      }
      return null;
    },
    [resolveSqlTabConnection],
  );

  const getSqlCompletionSchemas = useCallback(
    (tabId: string): DatabaseSchema[] => {
      const conn = resolveSqlTabConnection(tabId);
      const database = useDbWorkspaceTabStore.getState().sqlTabStates[tabId]?.database.trim() ?? "";
      if (!conn || !database) {
        return [];
      }
      const key = `${conn.id}:${database}`;
      const cached = schemaByKey[key];
      if (cached) {
        return [
          {
            ...cached,
            connectionName: cached.connectionName ?? conn.name,
            dbType: cached.dbType ?? conn.db_type },
        ];
      }
      return [
        buildDatabaseSchema(database, [], {
          connectionName: conn.name,
          dbType: conn.db_type }),
      ];
    },
    [resolveSqlTabConnection, schemaByKey],
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
    const schemaSnapshot = useDbSchemaCacheStore.getState().snapshot;
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
        [connId]: mergeFilter(prev[connId], names) }));
    }
  }, [referencedSqlConnIds, cacheHydrated, schemaRevision, setDatabaseFilters]);

  useEffect(() => {
    if (!cacheHydrated) {
      return;
    }
    let cancelled = false;
    const schemaSnapshot = useDbSchemaCacheStore.getState().snapshot;
    for (const connId of referencedSqlConnIds) {
      const connection = connections.find((item) => item.id === connId);
      if (!connection || !isConnectionEnabled(connection)) {
        continue;
      }
      const cachedNames = getCachedDatabaseNames(schemaSnapshot, connId);
      if (cachedNames.length > 0) {
        continue;
      }
      void listDatabases(connection, { quiet: true })
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
            [connId]: mergeFilter(prev[connId], names) }));
        })
        .catch(() => {
          // 忽略：用户可在 Schema 侧栏手动刷新
        });
    }
    return () => {
      cancelled = true;
    };
  }, [referencedSqlConnIds, cacheHydrated, schemaRevision, connections, setDatabaseFilters]);

  useEffect(() => {
    if (!cacheHydrated) {
      return;
    }
    const schemaSnapshot = useDbSchemaCacheStore.getState().snapshot;
    for (const tab of workspaceTabs) {
      if (tab.kind !== "sql") {
        continue;
      }
      const conn = resolveSqlTabConnection(tab.id);
      const database = useDbWorkspaceTabStore.getState().sqlTabStates[tab.id]?.database.trim() ?? "";
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
      const tables = [
        ...introspectToTableSchemas(dbEntry.tables, "table"),
        ...introspectToTableSchemas(dbEntry.views ?? [], "view"),
      ];
      setSchemaByKey((prev) => ({
        ...prev,
        [key]: buildDatabaseSchema(database, tables, {
          connectionName: conn.name,
          dbType: conn.db_type }) }));
    }
  }, [
    workspaceTabs,
    sqlTabPanelKeySeed,
    resolveSqlTabConnection,
    schemaByKey,
    cacheHydrated,
    schemaRevision,
  ]);

  const {
    loadTablePreview,
    refreshTablePreview,
    goToPage,
    setTablePageSize,
    setTableFilter,
    undoTabDirty,
    redoTabDirty,
    refreshTabPreviewNow,
    goToPageNow,
    setTableSort,
    commitTabDirty,
    rollbackTabDirty,
    setTableGridView,
    handleRowEdit,
    handleRowPaste,
    handleRowsDelete,
    handleRowNew,
    handleCellSetNull,
    handleCellCommit,
    handleRowSave } = useDatabasePanelTablePreview({
    connections,
    setTablePreviews,
    setTableColumnMeta,
    setTabDirtyRows,
    setCommittingTabs,
    setRowEdit,
    rowEdit,
    t });


  const {
    syncConnForTabId,
    activateWorkspaceTab,
    handleOpenSyncTask,
    handleRunSyncTask,
    promotePreviewTab,
    activateExistingDockTab,
    handleDockTabDoubleClick,
    replacePreviewDockTab,
    closeWorkspaceTabs,
    reopenRecentClosedPanel,
    requestTabAction,
    performMoveTabToWorkspace,
    handlePanelTransferredToWorkspace,
    handleContextAction,
    handleDockTabContextMenu,
    handleCloseDockTab } = useDatabasePanelDockTabs({
    setActiveConnIdIfChanged,
    workspaceTabsRef,
    setActiveWorkspaceTabId,
    setWorkspaceTabs,
    t,
    removeTabWorkspaceData,
    setTableDesignerStates,
    setTabDirtyRows,
    setCommittingTabs,
    pushRecentClosedPanel,
    removeRecentClosedPanel,
    setDirtySqlWorkspaceTabIds,
    activeWorkspaceTabIdRef,
    tableDesignerStatesRef,
    setSqlTabStates,
    setTablePreviews,
    connections,
    loadTablePreview,
    refreshTabPreviewNow,
    goToPageNow,
    setTablePageSize,
    setTableSort,
    setTableFilter,
    commitTabDirty,
    rollbackTabDirty,
    workspaceTabs,
    setDockLayout,
    ctxMenu,
    setCtxMenu,
    setTabModes });
  closeWorkspaceTabsRef.current = closeWorkspaceTabs;


  useEffect(() => {
    const bootstrapWorkspace = () => {
      const session = sanitizeWorkspaceSession(useDbWorkspaceSessionStore.getState().session);
      if (!session) {
        applyDefaultWorkspaceSession(
          setWorkspaceTabs,
          activateWorkspaceTab,
          () => useDbWorkspaceTabStore.getState().resetTabWorkspace(),
        );
        useDbDockLayoutStore.getState().setSavedLayout(null);
        setWorkspaceInitialized(true);
        return;
      }

      setWorkspaceTabs(session.tabs);

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
      for (const tab of session.tabs) {
        if (tab.kind !== "table") {
          continue;
        }
        const previewState = session.tablePreviewStates[tab.id];
        restoredPreviews[tab.id] = tablePreviewStateFromSnapshot(previewState, tab);
      }
      setTablePreviews(restoredPreviews);

      const restoredDesigner: Record<string, TableDesignerTabState> = {};
      for (const [tabId, snap] of Object.entries(session.tableDesignerStates ?? {})) {
        restoredDesigner[tabId] = restoreTableDesignerStateFromSnapshot(snap);
      }
      setTableDesignerStates(restoredDesigner);

      activateWorkspaceTab(session.activeTabId);

      setWorkspaceInitialized(true);
    };

    if (useDbWorkspaceSessionStore.persist.hasHydrated()) {
      bootstrapWorkspace();
      return;
    }

    return useDbWorkspaceSessionStore.persist.onFinishHydration(bootstrapWorkspace);
  }, []);

  useEffect(() => {
    if (!workspaceInitialized || !activeWorkspaceTabId) {
      return;
    }
    if (workspaceTabs.some((tab) => tab.id === activeWorkspaceTabId)) {
      return;
    }
    const fallback = workspaceTabs.find((tab) => isModuleDockTab(tab))?.id ?? "";
    activateWorkspaceTab(fallback);
  }, [workspaceInitialized, workspaceTabs, activeWorkspaceTabId, activateWorkspaceTab]);

  const resolveConnection = useCallback(
    (connId: string) => connections.find((c) => c.id === connId) ?? null,
    [connections],
  );


  const copyNameForTable = useCallback((selection: SchemaTableSelection) => {
    void writeToClipboard(`\`${selection.dbName}\`.\`${selection.tableName}\``);
  }, []);

  const copyDdlForTable = useCallback((selection: SchemaTableSelection) => {
    fetchTableDdl(selection.connection, selection.dbName, selection.tableName)
      .then((ddl) => writeToClipboard(ddl))
      .catch((err) => console.error("[db.copyDdl] fetchTableDdl failed", err));
  }, []);

  const handleDesignTable = useCallback(
    (selection: SchemaTableSelection) => {
      if (!supportsTableDesign(selection.connection)) {
        return;
      }

      const isNewTable = !selection.tableName.trim();
      if (!isNewTable) {
        const existingTabId = findTabIdForDesigner(
          workspaceTabs,
          selection.connId,
          selection.dbName,
          selection.tableName,
        );
        if (existingTabId) {
          activateWorkspaceTab(existingTabId);
          return;
        }
      }

      const tabId = makeDesignerTabId();
      const tab: TableDesignerWorkspaceTab = {
        id: tabId,
        kind: "designer",
        label: isNewTable
          ? makeTableDesignerTabLabel(
              t("database.tablesPanel.newTable"),
              selection.dbName,
              selection.connection.name,
            )
          : makeTableDesignerTabLabel(
              selection.tableName,
              selection.dbName,
              selection.connection.name,
            ),
        connId: selection.connId,
        dbName: selection.dbName,
        tableName: selection.tableName };
      setWorkspaceTabs((prev) => [...prev, tab]);
      activateWorkspaceTab(tabId);
    },
    [activateWorkspaceTab, t, workspaceTabs],
  );

  const openTableQuery = useCallback(
    (selection: SchemaTableSelection) => {
      const { connId, dbName, tableName, connection } = selection;
      const sql = buildSelectAllFromTableSql(connection.db_type, tableName);
      const tabId = makeSqlTabId();
      const tab: SqlWorkspaceTab = {
        id: tabId,
        kind: "sql",
        label: makeSqlTabLabel({
          table: tableName,
          database: dbName,
          connection: connection.name }) };
      setSqlTabStates((prev) => ({
        ...prev,
        [tabId]: {
          ...createDefaultSqlTabState(dbName, connId),
          sql,
          cursorOffset: sql.length } }));
      setWorkspaceTabs((prev) => [...prev, tab]);
      activateWorkspaceTab(tabId);
      setTabModes((prev) => ({ ...prev, [tabId]: "sql" }));
      setActiveConnIdIfChanged(connId);
    },
    [activateWorkspaceTab, setActiveConnIdIfChanged, setSqlTabStates, setTabModes],
  );

  /**
   * 打开 SQL 草稿 tab（空白或预填 SQL），供 AI Follow openSqlDraft 意图调用。
   * 参考 openTableQuery 的结构，去掉 buildSelectAllFromTableSql。
   * @returns 新建 tabId；连接不存在时返回 null
   */
  const openSqlDraftTab = useCallback(
    (connId: string, dbName?: string | null, sql?: string | null): string | null => {
      const connection = connections.find((c) => c.id === connId);
      if (!connection) return null;
      const db = dbName ?? connection.database ?? "";
      const tabId = makeSqlTabId();
      const tab: SqlWorkspaceTab = {
        id: tabId,
        kind: "sql",
        label: makeSqlTabLabel({
          database: db,
          connection: connection.name }) };
      const initialSql = sql?.trim() ?? "";
      setSqlTabStates((prev) => ({
        ...prev,
        [tabId]: {
          ...createDefaultSqlTabState(db, connId),
          sql: initialSql,
          cursorOffset: initialSql.length } }));
      setWorkspaceTabs((prev) => [...prev, tab]);
      activateWorkspaceTab(tabId);
      setTabModes((prev) => ({ ...prev, [tabId]: "sql" }));
      setActiveConnIdIfChanged(connId);
      return tabId;
    },
    [activateWorkspaceTab, connections, setActiveConnIdIfChanged, setSqlTabStates, setTabModes],
  );

  /** 快捷启动 / follow：打开草稿后自动执行 */
  const pendingSqlAutoRunRef = useRef<{ tabId: string; sql: string } | null>(null);
  const [sqlAutoRunNonce, setSqlAutoRunNonce] = useState(0);

  const {
    syncSqlFileTabHeaderMeta,
    updateSqlTabState,
    closeSqlResultSession,
    setSqlResultSessionPinned,
    setSqlTabConnection,
    runQuery,
    cancelQuery,
    setSqlAutoCommit,
    commitSqlTransaction,
    rollbackSqlTransaction,
    goToQueryResultPage,
    isSqlTabDirty,
    saveSqlTab } = useDatabasePanelSql({
    workspaceTabsRef,
    activeWorkspaceTabIdRef,
    setSqlTabStates,
    setDirtySqlWorkspaceTabIds,
    dirtySqlWorkspaceTabIds,
    syncConnForTabId,
    activeWorkspaceTab,
    activeWorkspaceTabId,
    connectionForSqlTab,
    resolveSqlTabConnection,
    enqueueAction,
    t,
    resolveConnection,
    setWorkspaceTabs,
    isActiveRoute,
    sqlAutoRunNonce,
    pendingSqlAutoRunRef });

  const openSlowQueryLogTab = useCallback(
    (connection: DbConnectionConfig, availability: SlowLogAvailability) => {
      if (!availability.enabled || !availability.sshConnectionId || !availability.logFilePath) {
        return;
      }
      setActiveConnIdIfChanged(connection.id);
      const moduleTabs = workspaceTabsRef.current.filter(isModuleDockTab);
      const existingTabId = findTabIdForSlowQueryLog(moduleTabs, connection.id);
      if (existingTabId) {
        activateWorkspaceTab(existingTabId);
        return;
      }
      const tabId = makeSlowQueryLogTabId();
      const tab: SlowQueryLogWorkspaceTab = {
        id: tabId,
        kind: "slow-query",
        label: makeConnectionScopedTabLabel(
          t("database.workspace.tabAction.slowQuery"),
          connection.name,
        ),
        connId: connection.id,
        sshConnectionId: availability.sshConnectionId,
        logFilePath: availability.logFilePath,
        deploymentKind: availability.deploymentKind,
        containerId: availability.containerId };
      setWorkspaceTabs((prev) => [...prev, tab]);
      activateWorkspaceTab(tabId);
    },
    [activateWorkspaceTab, setActiveConnIdIfChanged, setWorkspaceTabs, t],
  );

  const openDialectSlowQueryTab = useCallback(
    (connection: DbConnectionConfig) => {
      setActiveConnIdIfChanged(connection.id);
      const moduleTabs = workspaceTabsRef.current.filter(isModuleDockTab);
      const existingTabId = findTabIdForSlowQueryLog(moduleTabs, connection.id);
      if (existingTabId) {
        activateWorkspaceTab(existingTabId);
        return;
      }
      const tabId = makeSlowQueryLogTabId();
      const tab: SlowQueryLogWorkspaceTab = {
        id: tabId,
        kind: "slow-query",
        label: makeConnectionScopedTabLabel(
          t("database.workspace.tabAction.slowQuery"),
          connection.name,
        ),
        connId: connection.id,
        dialect: true };
      setWorkspaceTabs((prev) => [...prev, tab]);
      activateWorkspaceTab(tabId);
    },
    [activateWorkspaceTab, setActiveConnIdIfChanged, setWorkspaceTabs, t],
  );

  const openBinlogTab = useCallback(
    (connection: DbConnectionConfig, availability: BinlogAvailability) => {
      if (!availability.enabled || !availability.sshConnectionId) {
        return;
      }
      setActiveConnIdIfChanged(connection.id);
      const moduleTabs = workspaceTabsRef.current.filter(isModuleDockTab);
      const existingTabId = findTabIdForBinlog(moduleTabs, connection.id);
      if (existingTabId) {
        activateWorkspaceTab(existingTabId);
        return;
      }
      const tabId = makeBinlogTabId();
      const tab: BinlogWorkspaceTab = {
        id: tabId,
        kind: "binlog",
        label: makeConnectionScopedTabLabel(
          t("database.workspace.tabAction.binlog"),
          connection.name,
        ),
        connId: connection.id,
        sshConnectionId: availability.sshConnectionId,
        deploymentKind: availability.deploymentKind,
        containerId: availability.containerId,
        logBinBasename: availability.logBinBasename,
        binlogFormat: availability.binlogFormat,
        binlogRowImage: availability.binlogRowImage,
        flashbackCapable: availability.flashbackCapable };
      setWorkspaceTabs((prev) => [...prev, tab]);
      activateWorkspaceTab(tabId);
    },
    [activateWorkspaceTab, setActiveConnIdIfChanged, setWorkspaceTabs, t],
  );

  useEffect(() => {
    return useDbMysqlLogNavStore.subscribe((state, prev) => {
      if (!state.pending || state.pending === prev.pending) {
        return;
      }
      const req = useDbMysqlLogNavStore.getState().consume();
      if (!req) return;
      const connection = connections.find((c) => c.id === req.connId);
      if (!connection || !isMysqlConnectionInfoCapable(connection)) {
        showToast(t("database.contextMenu.binlogDisabled.notMysql"));
        return;
      }
      if (req.kind === "slow-query") {
        void (async () => {
          const availability = await ensureSlowLogAvailability(connection);
          if (!availability.enabled) {
            showToast(resolveSlowLogDisabledReason(availability));
            return;
          }
          openSlowQueryLogTab(connection, availability);
        })();
        return;
      }
      void (async () => {
        const availability = await ensureBinlogAvailability(connection);
        if (!availability.enabled) {
          showToast(resolveBinlogDisabledReason(availability));
          return;
        }
        openBinlogTab(connection, availability);
      })();
    });
  }, [
    connections,
    ensureSlowLogAvailability,
    ensureBinlogAvailability,
    openSlowQueryLogTab,
    openBinlogTab,
    resolveSlowLogDisabledReason,
    resolveBinlogDisabledReason,
    t,
  ]);

  const openProfile = useResourceProfileNavStore((s) => s.openProfile);

  const buildSchemaContextMenuItems = useCallback(
    (item: SchemaTreeItem, context: SchemaContextMenuContext) =>
      buildDatabaseSchemaContextMenuItems(
        {
          t,
          handleExportDatabase,
          handleOpenImportDatabase,
          handleDesignTable,
          copyNameForTable,
          copyDdlForTable,
          ensureSlowLogAvailability,
          ensureBinlogAvailability,
          resolveSlowLogDisabledReason,
          resolveBinlogDisabledReason,
          openSlowQueryLogTab,
          openDialectSlowQueryTab,
          openBinlogTab,
          toggleConnectionEnabled,
          setEditingConnection,
          setDialogOpen,
          setCreateDbDialog,
          openProfile,
          handleDeleteConnection },
        item,
        context,
      ),
    [
      copyDdlForTable,
      copyNameForTable,
      handleDesignTable,
      handleDeleteConnection,
      handleExportDatabase,
      handleOpenImportDatabase,
      openSlowQueryLogTab,
      openDialectSlowQueryTab,
      openBinlogTab,
      ensureSlowLogAvailability,
      ensureBinlogAvailability,
      resolveSlowLogDisabledReason,
      resolveBinlogDisabledReason,
      t,
      toggleConnectionEnabled,
      openProfile,
    ],
  );

  const handleSchemaCacheConnectionPatched = useCallback(
    (connId: string, entry: SchemaCacheConnectionEntry) => {
      const names = entry.databases.map((db) => db.name);
      setDatabasesByConnId((prev) => ({ ...prev, [connId]: names }));
      setDatabaseFilters((prev) => ({
        ...prev,
        [connId]: mergeFilter(prev[connId], names) }));
      // 库内新建表刷新后，同步表过滤可见集，避免侧栏仍按旧名单隐藏新表
      setTableFilters((prev) => {
        const next = { ...prev };
        for (const db of entry.databases) {
          if (db.tables.length === 0) {
            continue;
          }
          const key = makeTableFilterKey(connId, db.name);
          next[key] = mergeFilter(
            prev[key],
            db.tables.map((table) => table.name),
            { showAll: true },
          );
        }
        return next;
      });
    },
    [setDatabaseFilters, setTableFilters],
  );

  const refreshConnDatabases = useCallback(
    (connId: string) => {
      const conn = connections.find((c) => c.id === connId);
      if (!conn || !isConnectionEnabled(conn)) {
        return;
      }
      void submitSchemaCacheRefresh([connId], schemaCacheReporter).catch((err) => {
        schemaCacheReporter.onError?.(String(err));
      });
    },
    [connections, schemaCacheReporter],
  );

  const handleSelectTable = useCallback(
    (selection: SchemaTableSelection, mode: SchemaDockOpenMode = "permanent") => {
      setActiveConnIdIfChanged(selection.connId);
      // 勿 probeDbConnectionRuntime：表已从 schema 缓存列出，连接必然可用。
      // 点击瞬间同步 markConnecting 会触发 connection TreeNode 重渲 + 一次 testConnection IPC，
      // 纯属冗余且阻塞点击响应。连接探测由"打开连接节点"和"刷新 Schema"路径负责。

      // 勿包 startTransition：双击会先点出 preview 再 permanent，
      // 异步调度下两条路径可能都看不到对方刚建的 Tab，从而各建一个。
      const moduleTabs = workspaceTabsRef.current.filter(isModuleDockTab);
      const { connId, dbName, tableName, connection } = selection;

      const warmColumnMetaFromCache = (tabId: string) => {
        if (connection.db_type === "redis") {
          return false;
        }
        const columns = getCachedTableColumns(
          useDbSchemaCacheStore.getState().snapshot,
          connId,
          dbName,
          tableName,
        );
        if (!columns?.length) {
          return false;
        }
        setTableColumnMeta((prev) => {
          if (prev[tabId]?.length) {
            return prev;
          }
          return { ...prev, [tabId]: columns };
        });
        return true;
      };

      const ensureTablePreview = (tabId: string) => {
        const cachedColumns =
          connection.db_type === "redis"
            ? null
            : getCachedTableColumns(
                useDbSchemaCacheStore.getState().snapshot,
                connId,
                dbName,
                tableName,
              );
        useDbWorkspaceTabStore.setState((state) => {
          const nextColumnMeta = { ...state.tableColumnMeta };
          if (cachedColumns?.length) {
            nextColumnMeta[tabId] = cachedColumns;
          } else {
            delete nextColumnMeta[tabId];
          }
          return {
            tableColumnMeta: nextColumnMeta,
            tablePreviews: {
              ...state.tablePreviews,
              [tabId]: {
                ...createDefaultTablePreviewState(),
                loading: true,
                connId,
                dbName,
                tableName } } };
        });
        void loadTablePreview(tabId, connection, dbName, tableName);
      };

      const existingTabId = findTabIdForTable(moduleTabs, connId, dbName, tableName);
      if (existingTabId) {
        activateExistingDockTab(existingTabId, mode);
        if (connection.db_type !== "redis") {
          warmColumnMetaFromCache(existingTabId);
          fetchAndApplyTableColumnMeta(existingTabId, connection, dbName, tableName, (columns) => {
            setTableColumnMeta((prev) => ({ ...prev, [existingTabId]: columns }));
          });
        }
        return;
      }

      const previewTab = findPreviewDockTab(moduleTabs);
      const tabTemplate: TablePreviewWorkspaceTab = {
        id: "",
        kind: "table",
        label: makeTableTabLabel(tableName, dbName, connection.name),
        connId,
        dbName,
        tableName };

      if (mode === "permanent") {
        // 含预览 Tab（findTabIdForTable 只查常驻）
        const matchingPreview =
          previewTab && tabMatchesTableSelection(previewTab, connId, dbName, tableName)
            ? previewTab
            : moduleTabs.find(
                (tab) => tab.preview && tabMatchesTableSelection(tab, connId, dbName, tableName),
              );
        if (matchingPreview) {
          promotePreviewTab(matchingPreview.id);
          activateWorkspaceTab(matchingPreview.id);
          return;
        }

        const tabId = makeTableTabId();
        setWorkspaceTabs((prev) => {
          // 兜底：去掉同表残留预览，避免竞态留下双 Tab
          const withoutDupPreview = prev.filter(
            (tab) =>
              !(
                tab.preview &&
                isModuleDockTab(tab) &&
                tabMatchesTableSelection(tab, connId, dbName, tableName)
              ),
          );
          return [...withoutDupPreview, { ...tabTemplate, id: tabId }];
        });
        activateWorkspaceTab(tabId);
        ensureTablePreview(tabId);
        return;
      }

      if (previewTab && tabMatchesTableSelection(previewTab, connId, dbName, tableName)) {
        activateWorkspaceTab(previewTab.id);
        return;
      }

      if (previewTab) {
        const tabId = replacePreviewDockTab(previewTab.id, tabTemplate);
        ensureTablePreview(tabId);
        return;
      }

      const tabId = makeTableTabId();
      patchDockTabPreviewMeta(tabId, true);
      setWorkspaceTabs((prev) => [...prev, { ...tabTemplate, id: tabId, preview: true }]);
      // 同步更新 ref，便于紧随其后的双击 permanent 能看到预览 Tab
      workspaceTabsRef.current = [
        ...workspaceTabsRef.current,
        { ...tabTemplate, id: tabId, preview: true },
      ];
      activateWorkspaceTab(tabId);
      ensureTablePreview(tabId);
    },
    [
      activateExistingDockTab,
      loadTablePreview,
      promotePreviewTab,
      replacePreviewDockTab,
      setActiveConnIdIfChanged,
      setTableColumnMeta,
      setTablePreviews,
      activateWorkspaceTab,
      setWorkspaceTabs,
    ],
  );

  const activeSqlSidebarSeed = useDbWorkspaceTabStore(
    useShallow((state) => {
      if (!activeWorkspaceTab || activeWorkspaceTab.kind !== "sql") return null;
      const tabId = activeWorkspaceTab.id;
      const preview = state.tablePreviews[tabId];
      const sqlState = state.sqlTabStates[tabId];
      return {
        previewConn: preview?.connId,
        previewDb: preview?.dbName,
        previewTable: preview?.tableName,
        sqlConn: sqlState?.connId,
        sqlDb: sqlState?.database };
    }),
  );

  const activeDatabaseKey = useMemo(() => {
    if (!activeWorkspaceTab) {
      return null;
    }
    if (activeWorkspaceTab.kind === "table") {
      return makeDatabaseTabKey(activeWorkspaceTab.connId, activeWorkspaceTab.dbName);
    }
    if (activeWorkspaceTab.kind === "database" || activeWorkspaceTab.kind === "designer") {
      return makeDatabaseTabKey(activeWorkspaceTab.connId, activeWorkspaceTab.dbName);
    }
    if (activeWorkspaceTab.kind === "sql" && activeSqlSidebarSeed) {
      if (activeSqlSidebarSeed.previewConn && activeSqlSidebarSeed.previewDb && activeSqlSidebarSeed.previewTable) {
        return makeDatabaseTabKey(activeSqlSidebarSeed.previewConn, activeSqlSidebarSeed.previewDb);
      }
      if (activeSqlSidebarSeed.sqlConn && activeSqlSidebarSeed.sqlDb) {
        return makeDatabaseTabKey(activeSqlSidebarSeed.sqlConn, activeSqlSidebarSeed.sqlDb);
      }
    }
    return null;
  }, [activeWorkspaceTab, activeSqlSidebarSeed]);

  const activeTableKey = useMemo<string | null>(() => {
    if (!activeWorkspaceTab) {
      return null;
    }
    if (activeWorkspaceTab.kind === "sql" && activeSqlSidebarSeed) {
      const { previewConn, previewDb, previewTable } = activeSqlSidebarSeed;
      if (previewConn && previewDb && previewTable) {
        return makeTableTabKey(previewConn, previewDb, previewTable);
      }
      return null;
    }
    if (activeWorkspaceTab.kind === "table") {
      return makeTableTabKey(
        activeWorkspaceTab.connId,
        activeWorkspaceTab.dbName,
        activeWorkspaceTab.tableName,
      );
    }
    if (activeWorkspaceTab.kind === "designer") {
      return makeTableTabKey(
        activeWorkspaceTab.connId,
        activeWorkspaceTab.dbName,
        activeWorkspaceTab.tableName,
      );
    }
    return null;
  }, [activeWorkspaceTab, activeSqlSidebarSeed]);

  const handleNewSqlQuery = useCallback(() => {
    const binding = resolveSqlQueryBindingContext({
      connections,
      activeWorkspaceTab,
      activeConnId,
      activeDatabaseKey,
      activeTableKey,
      sqlTabConnDb: activeSqlTabConnDb });
    if (!binding) {
      return;
    }
    openSqlDraftTab(binding.connId, binding.database);
  }, [
    activeConnId,
    activeDatabaseKey,
    activeTableKey,
    activeWorkspaceTab,
    activeSqlTabConnDb,
    connections,
    openSqlDraftTab,
  ]);

  /** 侧栏「查询」：单例 SQL 编辑器，不落文件；关闭后再打开恢复上次内容。 */
  const handleOpenScratchQuery = useCallback(() => {
    const existingId = findScratchSqlTabId(workspaceTabsRef.current);
    if (existingId) {
      activateWorkspaceTab(existingId);
      return;
    }

    const draft = useDbScratchQueryStore.getState();
    const binding = resolveSqlQueryBindingContext({
      connections,
      activeWorkspaceTab,
      activeConnId,
      activeDatabaseKey,
      activeTableKey,
      sqlTabConnDb: activeSqlTabConnDb });

    const draftConnValid =
      Boolean(draft.connId) &&
      connections.some(
        (conn) =>
          conn.id === draft.connId &&
          isSqlCapableConnection(conn) &&
          isConnectionEnabled(conn),
      );
    const connId = draftConnValid ? draft.connId : (binding?.connId ?? "");
    const database = draftConnValid ? draft.database : (binding?.database ?? "");
    const connection = connections.find((c) => c.id === connId);
    const sql = draft.sql ?? "";
    const cursorOffset = Math.max(0, Math.min(draft.cursorOffset ?? 0, sql.length));
    const tabId = SCRATCH_SQL_TAB_ID;
    const tab: SqlWorkspaceTab = {
      id: tabId,
      kind: "sql",
      scratchQuery: true,
      label: makeSqlTabLabel({
        action: t("database.workspace.scratchQuery"),
        database,
        connection: connection?.name ?? null }) };

    setSqlTabStates((prev) => ({
      ...prev,
      [tabId]: {
        ...createDefaultSqlTabState(database, connId),
        sql,
        cursorOffset } }));
    setWorkspaceTabs((prev) => [...prev, tab]);
    activateWorkspaceTab(tabId);
    setTabModes((prev) => ({ ...prev, [tabId]: "sql" }));
    if (connId) {
      setActiveConnIdIfChanged(connId);
    }
    syncSqlFileTabHeaderMeta(tabId, false, false);
  }, [
    activateWorkspaceTab,
    activeConnId,
    activeDatabaseKey,
    activeTableKey,
    activeWorkspaceTab,
    activeSqlTabConnDb,
    connections,
    setActiveConnIdIfChanged,
    setSqlTabStates,
    setTabModes,
    setWorkspaceTabs,
    syncSqlFileTabHeaderMeta,
    t,
  ]);

  const sqlQueryBindingContext = useMemo(
    () =>
      resolveSqlQueryBindingContext({
        connections,
        activeWorkspaceTab,
        activeConnId,
        activeDatabaseKey,
        activeTableKey,
        sqlTabConnDb: activeSqlTabConnDb }),
    [
      connections,
      activeWorkspaceTab,
      activeConnId,
      activeDatabaseKey,
      activeTableKey,
      activeSqlTabConnDb,
    ],
  );

  const handleSelectDatabase = useCallback(
    (selection: SchemaDatabaseSelection, mode: SchemaDockOpenMode = "permanent") => {
      setActiveConnIdIfChanged(selection.connId);
      // 勿 probeDbConnectionRuntime：库已从 schema 缓存列出，连接必然可用（同 handleSelectTable）
      const moduleTabs = workspaceTabsRef.current.filter(isModuleDockTab);
      const { connId, dbName, connection } = selection;
      const isRedis = isRedisConnection(connection);

      const existingTabId = isRedis
        ? findTabIdForRedisQuery(moduleTabs, connId, dbName)
        : findTabIdForDatabase(moduleTabs, connId, dbName);
      if (existingTabId) {
        activateExistingDockTab(existingTabId, mode);
        return;
      }

      const previewTab = findPreviewDockTab(moduleTabs);
      const tabTemplate: DbWorkspaceTab = isRedis
        ? {
            id: "",
            kind: "redis-query",
            label: makeDatabaseListTabLabel(dbName, connection.name),
            connId,
            dbName }
        : {
            id: "",
            kind: "database",
            label: makeDatabaseListTabLabel(dbName, connection.name),
            connId,
            dbName };

      const matchesSelection = (tab: DbWorkspaceTab) =>
        tabMatchesDatabaseSelection(tab, connId, dbName, isRedis);

      if (mode === "permanent") {
        if (previewTab && matchesSelection(previewTab)) {
          promotePreviewTab(previewTab.id);
          activateWorkspaceTab(previewTab.id);
          return;
        }

        const tabId = isRedis ? makeRedisQueryTabId() : makeDatabaseTabId();
        setWorkspaceTabs((prev) => [...prev, { ...tabTemplate, id: tabId } as DbWorkspaceTab]);
        activateWorkspaceTab(tabId);
        return;
      }

      if (previewTab && matchesSelection(previewTab)) {
        activateWorkspaceTab(previewTab.id);
        return;
      }

      if (previewTab) {
        replacePreviewDockTab(previewTab.id, tabTemplate);
        return;
      }

      const tabId = isRedis ? makeRedisQueryTabId() : makeDatabaseTabId();
      patchDockTabPreviewMeta(tabId, true);
      setWorkspaceTabs((prev) => [
        ...prev,
        { ...tabTemplate, id: tabId, preview: true } as DbWorkspaceTab,
      ]);
      activateWorkspaceTab(tabId);
    },
    [
      activateExistingDockTab,
      activateWorkspaceTab,
      promotePreviewTab,
      replacePreviewDockTab,
      setActiveConnIdIfChanged,
      t,
    ],
  );

  const openSqlFile = useCallback(
    (file: DbSqlFileNode) => {
      const existingTabId = findTabIdForSqlFile(workspaceTabs, file.id);
      if (existingTabId) {
        activateWorkspaceTab(existingTabId);
        syncSqlFileTabHeaderMeta(
          existingTabId,
          dirtySqlWorkspaceTabIds.has(existingTabId),
        );
        return;
      }
      const tabId = makeSqlTabId();
      const connName = file.connId
        ? connections.find((item) => item.id === file.connId)?.name ?? file.connId
        : "";
      const fileAction = file.name.replace(/\.sql$/i, "") || t("database.workspace.tabAction.sql");
      const tab: SqlWorkspaceTab = {
        id: tabId,
        kind: "sql",
        label: makeSqlTabLabel({
          action: fileAction,
          database: file.database,
          connection: connName || null }),
        sqlFileId: file.id };
      setSqlTabStates((prev) => ({
        ...prev,
        [tabId]: {
          ...createDefaultSqlTabState(file.database ?? "", file.connId ?? ""),
          sql: file.sql ?? "" } }));
      setWorkspaceTabs((prev) => [...prev, tab]);
      activateWorkspaceTab(tabId);
      setTabModes((prev) => ({ ...prev, [tabId]: "sql" }));
      syncSqlFileTabHeaderMeta(tabId, false);
    },
    [workspaceTabs, dirtySqlWorkspaceTabIds, syncSqlFileTabHeaderMeta, connections, t],
  );

  const openTreeChartFile = useCallback(
    (file: DbTreeChartFileNode) => {
      const existingTabId = findTabIdForTreeChartFile(workspaceTabsRef.current, file.id);
      if (existingTabId) {
        activateWorkspaceTab(existingTabId);
        return;
      }
      const tabId = makeTreeChartTabId();
      const tab: TreeChartWorkspaceTab = {
        id: tabId,
        kind: "tree-chart",
        label: makeTreeChartTabLabel(
          t("database.workspace.tabAction.treeChart"),
          formatTreeChartFileLabel(file.name),
        ),
        treeChartFileId: file.id };
      setWorkspaceTabs((prev) => [...prev, tab]);
      activateWorkspaceTab(tabId);
    },
    [activateWorkspaceTab, setWorkspaceTabs, t],
  );

  const openTreeChartTab = useCallback(async () => {
    const name = await quickInput({
      title: t("database.treeChart.newFileTitle"),
      placeholder: t("database.treeChart.fileNamePlaceholder"),
      defaultValue: t("database.treeChart.defaultFileName"),
      validate: (value) => (value.trim() ? null : t("database.treeChart.nameRequired")) });
    if (!name) {
      return;
    }
    const store = useDbTreeChartFileStore.getState();
    const file = store.addFile(name.trim());
    await store.flushToDisk();
    openTreeChartFile(file);
  }, [openTreeChartFile, t]);

  const activeWorkspaceId = useWorkspaceStore((state) => state.workspace.id);
  const workspaces = useWorkspaceStore((state) => state.workspaces);

  // @ts-ignore
  const openRedisQueryTab = useCallback(
    (connId: string, dbName: string | undefined, _label: string, mode: SchemaDockOpenMode = "permanent") => {
      const moduleTabs = workspaceTabsRef.current.filter(isModuleDockTab);
      const existingTabId = findTabIdForRedisQuery(moduleTabs, connId, dbName);
      if (existingTabId) {
        activateExistingDockTab(existingTabId, mode);
        return;
      }

      const connName = connections.find((item) => item.id === connId)?.name ?? connId;
      const previewTab = findPreviewDockTab(moduleTabs);
      const tabTemplate: RedisQueryWorkspaceTab = {
        id: "",
        kind: "redis-query",
        label: dbName
          ? makeDatabaseListTabLabel(dbName, connName)
          : makeConnectionTabLabel(connName),
        connId,
        dbName };
      const matchesSelection = (tab: DbWorkspaceTab) =>
        dbName === undefined
          ? tabMatchesConnectionSelection(tab, connId, true)
          : tabMatchesDatabaseSelection(tab, connId, dbName, true);

      if (mode === "permanent") {
        if (previewTab && matchesSelection(previewTab)) {
          promotePreviewTab(previewTab.id);
          activateWorkspaceTab(previewTab.id);
          return;
        }

        const tabId = makeRedisQueryTabId();
        setWorkspaceTabs((prev) => [...prev, { ...tabTemplate, id: tabId }]);
        activateWorkspaceTab(tabId);
        return;
      }

      if (previewTab && matchesSelection(previewTab)) {
        activateWorkspaceTab(previewTab.id);
        return;
      }

      if (previewTab) {
        replacePreviewDockTab(previewTab.id, tabTemplate);
        return;
      }

      const tabId = makeRedisQueryTabId();
      patchDockTabPreviewMeta(tabId, true);
      setWorkspaceTabs((prev) => [...prev, { ...tabTemplate, id: tabId, preview: true }]);
      activateWorkspaceTab(tabId);
    },
    [
      activateExistingDockTab,
      activateWorkspaceTab,
      promotePreviewTab,
      replacePreviewDockTab,
      connections,
      t,
    ],
  );

  const handleSelectConnection = useCallback(
    (
      connId: string,
      mode: SchemaDockOpenMode = "permanent",
      options?: { expandTree?: boolean },
    ) => {
      // 联动定位必须同步更新，不能包在 startTransition 里（否则侧栏会等低优先级任务）
      setActiveConnIdIfChanged(connId);
      const conn = connections.find((item) => item.id === connId);
      if (!conn) return;

      // 单击 preview 不展开树（秒开预览）；常驻打开默认展开，双击收起传 expandTree:false
      // Redis 无「库」页签，预览也要展开才能在侧栏看到 db0..N
      const shouldExpandTree =
        options?.expandTree ??
        (mode !== "preview" || isRedisConnection(conn));
      if (shouldExpandTree) {
        updateSchemaExpanded((prev) => {
          const next = new Set(prev);
          next.add(connectionNodeId(connId));
          return next;
        });
      }

      if (isConnectionEnabled(conn)) {
        // 连通探测只更新状态点，不拉库表
        void probeDbConnectionRuntime(conn);
        // Schema：仅无有效缓存时浅加载；有缓存不刷新（留给专门刷新按钮）
        // Redis 空库列表视为无效缓存（历史失败会留下 []，显示「0 DB」）
        const entry = useDbSchemaCacheStore.getState().snapshot.connections?.[connId];
        const refreshing = Boolean(
          useDbSchemaCacheStore.getState().refreshingConnectionIds[connId],
        );
        const redisNeedsDbList =
          isRedisConnection(conn) &&
          (!entry?.databases || entry.databases.length === 0);
        if ((!isSchemaCacheEntryOk(entry) || redisNeedsDbList) && !refreshing) {
          const loadSchema = () => {
            void submitSchemaCacheRefresh([connId], schemaCacheReporter).catch((err) => {
              schemaCacheReporter.onError?.(String(err));
            });
          };
          if (isEngineReady(conn.db_type)) {
            loadSchema();
          } else {
            void ensureEngineForDbType(conn.db_type).then((result) => {
              if (
                result.status === "ready" ||
                result.status === "installed" ||
                result.status === "enabled"
              ) {
                loadSchema();
              }
            });
          }
        }
      } else {
        useDbConnectionRuntimeStore.getState().syncEnabled(connId, false);
      }

      if (isRedisConnection(conn)) {
        const moduleTabs = workspaceTabsRef.current.filter(isModuleDockTab);
        const existingTabId = findTabIdForConnection(moduleTabs, connId);
        if (existingTabId) {
          activateExistingDockTab(existingTabId, mode);
          return;
        }

        const previewTab = findPreviewDockTab(moduleTabs);
        const tabTemplate: ConnectionInfoWorkspaceTab = {
          id: "",
          kind: "connection",
          label: makeConnectionTabLabel(conn.name),
          connId };
        const matchesSelection = (tab: DbWorkspaceTab) =>
          tabMatchesConnectionSelection(tab, connId, true);

        if (mode === "permanent") {
          if (previewTab && matchesSelection(previewTab)) {
            promotePreviewTab(previewTab.id);
            activateWorkspaceTab(previewTab.id);
            return;
          }

          const tabId = makeConnectionInfoTabId();
          setWorkspaceTabs((prev) => [...prev, { ...tabTemplate, id: tabId }]);
          activateWorkspaceTab(tabId);
          return;
        }

        if (previewTab && matchesSelection(previewTab)) {
          activateWorkspaceTab(previewTab.id);
          return;
        }

        if (previewTab) {
          replacePreviewDockTab(previewTab.id, tabTemplate);
          return;
        }

        const tabId = makeConnectionInfoTabId();
        patchDockTabPreviewMeta(tabId, true);
        setWorkspaceTabs((prev) => [...prev, { ...tabTemplate, id: tabId, preview: true }]);
        activateWorkspaceTab(tabId);
        return;
      }

      const moduleTabs = workspaceTabsRef.current.filter(isModuleDockTab);
      const existingTabId = findTabIdForConnection(moduleTabs, connId);
      if (existingTabId) {
        activateExistingDockTab(existingTabId, mode);
        return;
      }

      const previewTab = findPreviewDockTab(moduleTabs);
      const tabTemplate: ConnectionInfoWorkspaceTab = {
        id: "",
        kind: "connection",
        label: makeConnectionTabLabel(conn.name),
        connId };
      const matchesSelection = (tab: DbWorkspaceTab) =>
        tabMatchesConnectionSelection(tab, connId, false);

      if (mode === "permanent") {
        if (previewTab && matchesSelection(previewTab)) {
          promotePreviewTab(previewTab.id);
          activateWorkspaceTab(previewTab.id);
          return;
        }

        const tabId = makeConnectionInfoTabId();
        setWorkspaceTabs((prev) => [...prev, { ...tabTemplate, id: tabId }]);
        activateWorkspaceTab(tabId);
        return;
      }

      if (previewTab && matchesSelection(previewTab)) {
        activateWorkspaceTab(previewTab.id);
        return;
      }

      if (previewTab) {
        replacePreviewDockTab(previewTab.id, tabTemplate);
        return;
      }

      const tabId = makeConnectionInfoTabId();
      patchDockTabPreviewMeta(tabId, true);
      setWorkspaceTabs((prev) => [...prev, { ...tabTemplate, id: tabId, preview: true }]);
      activateWorkspaceTab(tabId);
    },
    [
      connections,
      activateExistingDockTab,
      activateWorkspaceTab,
      promotePreviewTab,
      replacePreviewDockTab,
      setActiveConnIdIfChanged,
      setWorkspaceTabs,
      updateSchemaExpanded,
      schemaCacheReporter,
      t,
    ],
  );
  openConnectionInfoTabRef.current = handleSelectConnection;

  // === AI Follow 消费者注册 ===
  // 处理来自 AI 工具完成的 follow intent：openSqlDraft / selectTable / selectDatabase / openConnection
  // 必须在 handleSelectConnection/handleSelectTable/handleSelectDatabase 定义之后注册，
  // 否则 TDZ（暂时性死区）错误。
  useUiFollowConsumer("database", useCallback((intent) => {
    switch (intent.type) {
      case "openSqlDraft": {
        const tabId = openSqlDraftTab(intent.connectionId, intent.database, intent.sql);
        if (intent.autoRun && tabId && intent.sql?.trim()) {
          pendingSqlAutoRunRef.current = { tabId, sql: intent.sql.trim() };
          setSqlAutoRunNonce((n) => n + 1);
        }
        return tabId != null;
      }
      case "openSqlFile": {
        const file = useDbSqlFileStore.getState().getNode(intent.fileId);
        if (!file || file.type !== "file") return false;
        openSqlFile(file);
        return true;
      }
      case "selectTable": {
        const connection = connections.find((c) => c.id === intent.connectionId);
        if (!connection) return false;
        handleSelectTable(
          { connId: intent.connectionId, dbName: intent.database, tableName: intent.table, connection },
          "permanent",
        );
        return true;
      }
      case "selectDatabase": {
        const connection = connections.find((c) => c.id === intent.connectionId);
        if (!connection) return false;
        handleSelectDatabase(
          { connId: intent.connectionId, dbName: intent.database, connection },
          "permanent",
        );
        return true;
      }
      case "openConnection": {
        handleSelectConnection(intent.resourceId, "permanent");
        return true;
      }
      default:
        return false;
    }
  }, [
    connections,
    handleSelectConnection,
    handleSelectDatabase,
    handleSelectTable,
    openSqlDraftTab,
    openSqlFile,
  ]));


  const workspaceStateValue: DbWorkspaceSharedContextValue = useMemo(
    () => ({
        tabs: workspaceTabs,
        closeTab: (tabId: string) => requestTabAction({ kind: "close", tabId }),
        runQuery,
        cancelQuery,
        setSqlAutoCommit,
        commitSqlTransaction,
        rollbackSqlTransaction,
        goToQueryResultPage,
        updateSqlTabState,
        closeSqlResultSession,
        setSqlResultSessionPinned,
        refreshTablePreview,
        goToPage,
        requestTabAction,
        setTableSort,
        setTableFilter,
        setTableGridView,
        handleCellCommit,
        handleRowEdit,
        handleCellSetNull,
        handleRowNew,
        handleRowPaste,
        handleRowsDelete,
        resolveConnection,
        connectionsLoading,
        selectTable: handleSelectTable,
        selectDatabase: handleSelectDatabase,
        openTableDesigner: handleDesignTable,
        openTableQuery,
        setTabMode: (id: string, mode: "data" | "sql") =>
          useDbWorkspaceTabStore.getState().setTabMode(id, mode),
        commitTabDirty,
        rollbackTabDirty,
        undoTabDirty,
        redoTabDirty,
        openExportMenu: (x: number, y: number, tabId: string, sessionId?: string) =>
          setExportMenu({ x, y, tabId, sessionId }),
        sqlConnections,
        groupConnections: connections,
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
        isSqlTabDirty }),
    [
    workspaceTabs,
    requestTabAction,
    runQuery,
    cancelQuery,
    setSqlAutoCommit,
    commitSqlTransaction,
    rollbackSqlTransaction,
    updateSqlTabState,
    closeSqlResultSession,
    setSqlResultSessionPinned,
    refreshTablePreview,
    goToPage,
    setTableFilter,
    setTableGridView,
    handleCellCommit,
    handleRowEdit,
    handleCellSetNull,
    handleRowNew,
    handleRowPaste,
    handleRowsDelete,
    resolveConnection,
    connectionsLoading,
    handleSelectTable,
    handleSelectDatabase,
    handleDesignTable,
    openTableQuery,
    commitTabDirty,
    rollbackTabDirty,
    undoTabDirty,
    redoTabDirty,
    sqlConnections,
    connections,
    databasesByConnId,
    schemaByKey,
    schemaLoadingKey,
    resolveSqlTabConnection,
    getSqlTabDatabases,
    getSqlCompletionSchemas,
    connectionForSqlTab,
    setSqlTabConnection,
    saveSqlTab,
    isSqlTabDirty,
  ]);

  const activeTabContextValue = useMemo(
    () => ({
      activeTabId: activeWorkspaceTabId,
      setActiveTabId: activateWorkspaceTab }),
    [activeWorkspaceTabId, activateWorkspaceTab],
  );

  const workspaceStateValueRef = useRef(workspaceStateValue);
  workspaceStateValueRef.current = workspaceStateValue;
  const activeTabContextValueRef = useRef(activeTabContextValue);
  activeTabContextValueRef.current = activeTabContextValue;
  const activeTableKeyRef = useRef(activeTableKey);
  activeTableKeyRef.current = activeTableKey;

  const mirrorRevisionsRef = useRef(new Map<string, string>());

  useEffect(() => {
    if (referencedDatabaseTabIds.length === 0) {
      return;
    }

    let cancelled = false;
    let frame = 0;

    const publishMirror = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (cancelled) return;
        const context: DbWorkspaceMirrorContextValue = {
          ...workspaceStateValueRef.current,
          ...selectDbTabWorkspaceMirrorSlice(useDbWorkspaceTabStore.getState()),
          ...activeTabContextValueRef.current,
          activeTableKey: activeTableKeyRef.current };
        mirrorRevisionsRef.current = publishDbWorkspaceMirror(
          context,
          referencedDatabaseTabIds,
          mirrorRevisionsRef.current,
        );
      });
    };

    publishMirror();
    const unsubscribe = useDbWorkspaceTabStore.subscribe(publishMirror);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [referencedDatabaseTabIds, workspaceStateValue, activeTabContextValue, activeTableKey]);

  const dockTabs = useMemo(
    () =>
      workspaceTabs
        .filter((tab) => !tab.workspaceOnly)
        .map((tab) => {
          const preview = Boolean(tab.preview);
          if (tab.kind === "database") {
            return {
              id: tab.id,
              label: tab.label,
              panelType: "database-list",
              icon: "database" as const,
              tooltip: tab.label,
              closable: true,
              preview };
          }
          if (tab.kind === "connection") {
            return {
              id: tab.id,
              label: tab.label,
              panelType: "database-connection",
              icon: "database" as const,
              tooltip: t("database.connectionInfo.subtitle"),
              closable: true,
              preview };
          }
          if (tab.kind === "redis-query") {
            return {
              id: tab.id,
              label: tab.label,
              panelType: "database-redis",
              icon: "database" as const,
              tooltip: t("database.redisQuery.search"),
              closable: true,
              preview };
          }
          if (tab.kind === "slow-query") {
            return {
              id: tab.id,
              label: tab.label,
              panelType: "database-slow-query",
              icon: "database" as const,
              tooltip: t("database.slowQueryLog.tabTooltip", { name: tab.label }),
              closable: true,
              preview };
          }
          if (tab.kind === "binlog") {
            return {
              id: tab.id,
              label: tab.label,
              panelType: "database-binlog",
              icon: "database" as const,
              tooltip: t("database.binlog.tabTooltip", { name: tab.label }),
              closable: true,
              preview };
          }
          if (tab.kind === "toolbox") {
            return {
              id: tab.id,
              label: tab.label,
              panelType: tab.toolboxTab === "dataSync" ? "database-data-sync" : "database-toolbox",
              icon: tab.toolboxTab === "dataSync" ? ("table" as const) : ("database" as const),
              tooltip: tab.label,
              closable: true,
              preview };
          }
          if (tab.kind === "designer") {
            const dirty = isDesignerTabDirty(tab.id);
            return {
              id: tab.id,
              label: tab.label,
              panelType: "database-designer",
              type: "file" as const,
              dirty,
              saved: !dirty,
              icon: "table" as const,
              tooltip: t("database.tableDesigner.tabTooltip", { label: tab.label }),
              closable: true,
              preview };
          }
          if (tab.kind === "tree-chart") {
            return {
              id: tab.id,
              label: tab.label,
              panelType: "database-tree-chart",
              type: "file" as const,
              saved: true,
              icon: "database" as const,
              tooltip: t("database.treeChart.tabTooltip"),
              closable: true,
              preview };
          }
          const isTableTab = tablePreviewTabIds.has(tab.id);
          const dirty = isTableTab ? false : dirtySqlWorkspaceTabIds.has(tab.id);
          const saved = tab.kind === "sql" && Boolean(tab.sqlFileId) && !dirty;
          return {
            id: tab.id,
            label: tab.label,
            panelType: isTableTab ? "database-table" : "database-sql",
            ...(!isTableTab
              ? { type: "file" as const, dirty, saved }
              : {}),
            icon: isTableTab ? ("table" as const) : ("sql" as const),
            tooltip: tab.label,
            closable: true,
            preview };
        }),
    [workspaceTabs, tablePreviewTabIds, dirtySqlWorkspaceTabIds, isDesignerTabDirty, t],
  );

  const recentClosedActionItems = useMemo(
    () =>
      [...recentClosedPanels]
        .sort((a, b) => b.closedAt - a.closedAt)
        .slice(0, 5)
        .map((entry) => ({
          id: entry.tab.id,
          label: entry.tab.label,
          meta: new Date(entry.closedAt).toLocaleString(),
          onClick: () => reopenRecentClosedPanel(entry) })),
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
                connection };
              return (
                // 库列表按「可见」隐藏：分屏后非聚焦 group 的面板也要显示
                <DbDockTabVisible tabId={tab.id}>
                  {(visible) => (
                    <div
                      className="db-workspace-pane db-dock-pane"
                      style={visible ? undefined : { display: "none" }}
                      aria-hidden={!visible}
                    >
                      <DatabaseTablesPanel
                        selection={selection}
                        onDesignTable={handleDesignTable}
                        onOpenTableData={(tableSelection) =>
                          handleSelectTable(tableSelection, "permanent")
                        }
                        onExportDatabase={
                          isMysqlConnectionInfoCapable(connection)
                            ? (dbSelection) => {
                                void handleExportDatabase(
                                  dbSelection.connection,
                                  dbSelection.dbName,
                                );
                              }
                            : undefined
                        }
                        onImportDatabase={
                          isMysqlConnectionInfoCapable(connection)
                            ? (dbSelection) => {
                                handleOpenImportDatabase(
                                  dbSelection.connection,
                                  dbSelection.dbName,
                                );
                              }
                            : undefined
                        }
                      />
                    </div>
                  )}
                </DbDockTabVisible>
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
                <DbDockTabActive tabId={tab.id}>
                  {(active) => (
                    <ConnectionInfoSlot connection={connection} active={active} />
                  )}
                </DbDockTabActive>
              </div>
            )}
          </ConnectionResolvedDockPane>
        );
      }

      if (tab.kind === "redis-query") {
        return (
          <ConnectionResolvedDockPane connId={tab.connId}>
            {(connection) => (
              <div className="db-workspace-pane db-dock-pane">
                <RedisQueryPanel connection={connection} fixedDbName={tab.dbName} />
              </div>
            )}
          </ConnectionResolvedDockPane>
        );
      }

      if (tab.kind === "slow-query") {
        return (
          <ConnectionResolvedDockPane connId={tab.connId}>
            {(connection) => (
              <div className="db-workspace-pane db-dock-pane db-workspace-pane--slow-log">
                <DbDockTabActive tabId={tab.id}>
                  {(active) =>
                    tab.dialect || !tab.logFilePath ? (
                      <DialectSlowQueryPanel connection={connection} active={active} />
                    ) : (
                      <DatabaseSlowQueryLogPanel
                        connection={connection}
                        sshConnectionId={tab.sshConnectionId ?? ""}
                        logFilePath={tab.logFilePath}
                        deploymentKind={tab.deploymentKind}
                        containerId={tab.containerId}
                        active={active}
                      />
                    )
                  }
                </DbDockTabActive>
              </div>
            )}
          </ConnectionResolvedDockPane>
        );
      }

      if (tab.kind === "binlog") {
        return (
          <ConnectionResolvedDockPane connId={tab.connId}>
            {(connection) => (
              <div className="db-workspace-pane db-dock-pane db-workspace-pane--binlog">
                <DbDockTabActive tabId={tab.id}>
                  {(active) => (
                    <DatabaseBinlogPanel
                      connection={connection}
                      sshConnectionId={tab.sshConnectionId}
                      deploymentKind={tab.deploymentKind}
                      containerId={tab.containerId}
                      logBinBasename={tab.logBinBasename}
                      binlogFormat={tab.binlogFormat}
                      binlogRowImage={tab.binlogRowImage}
                      flashbackCapable={tab.flashbackCapable}
                      active={active}
                    />
                  )}
                </DbDockTabActive>
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
                  onTableCreated={(createdTableName) => {
                    setWorkspaceTabs((prev) =>
                      prev.map((item) => {
                        if (item.id !== tab.id || item.kind !== "designer") {
                          return item;
                        }
                        return {
                          ...item,
                          tableName: createdTableName,
                          label: makeTableDesignerTabLabel(
                            createdTableName,
                            item.dbName,
                            connection.name,
                          ) };
                      }),
                    );
                  }}
                />
              </div>
            )}
          </ConnectionResolvedDockPane>
        );
      }

      if (tab.kind === "table") {
        return (
          <div className="db-workspace-pane db-dock-pane">
            <DbTablePreviewSurface tab={tab} />
          </div>
        );
      }

      if (tab.kind === "sql") {
        return (
          <div className="db-workspace-pane db-dock-pane">
            <DbPanelSurface tab={tab} />
          </div>
        );
      }

      if (tab.kind === "tree-chart") {
        return (
          <div className="db-workspace-pane db-dock-pane db-workspace-pane--tree-chart">
            <TreeChartPanel
              connections={connections.filter(isSqlCapableConnection)}
              fileId={tab.treeChartFileId}
            />
          </div>
        );
      }

      if (tab.kind === "toolbox") {
        return (
          <div className="db-workspace-pane db-dock-pane db-module-transfer">
            <DbDockTabActive tabId={tab.id}>
              {(active) => (
                <DatabaseToolbox
                  active={active}
                  syncTaskId={tab.syncTaskId}
                  tab={tab.toolboxTab}
                  connections={toolboxConnections}
                  initialSourceConnectionId={
                    toolboxSeed.connId ??
                    (activeConn && isToolboxCapableConnection(activeConn) ? activeConn.id : null)
                  }
                  initialSourceDatabase={toolboxSeed.database}
                />
              )}
            </DbDockTabActive>
          </div>
        );
      }

      return null;
    },
    [
      workspaceTabs,
      handleSelectTable,
      handleDesignTable,
      tableDesignerStates,
      updateTableDesignerState,
      tablePreviewTabIdKey,
      toolboxConnections,
      toolboxSeed,
      activeConn,
      t,
    ],
  );

  useEffect(() => {
    if (isActiveRoute) return;
    setCtxMenu(null);


    setExportMenu(null);
  }, [isActiveRoute]);

  // 勿绑 activeTabId / moduleLive / 整份 tabs：
  // 切 Tab 由 DockableWorkspace 局部 soft bump；路由切走保活由 ModuleSegmentDock hasBeenLive 处理。
  const moduleSoftRefreshKey = useMemo(
    () =>
      [
        connectionsLoading ? "1" : "0",
        connections.map((c) => c.id).join(","),
      ].join("|"),
    [connections, connectionsLoading],
  );

  const activeTreeChartFileId = useMemo(() => {
    const tab = workspaceTabs.find((item) => item.id === activeWorkspaceTabId);
    return tab?.kind === "tree-chart" ? tab.treeChartFileId : null;
  }, [workspaceTabs, activeWorkspaceTabId]);

  const handleCreateConnection = useCallback(() => {
    setEditingConnection(null);
    setDialogOpen(true);
  }, []);

  const handleImportNavicat = useCallback(() => {
    void handleImportConnections();
  }, [handleImportConnections]);

  const handleNewTreeChart = useCallback(() => {
    void openTreeChartTab();
  }, [openTreeChartTab]);


  const sidebarLinkageConnId = useMemo(() => {
    if (activeTableKey) {
      const parsed = parseTableNodeId(activeTableKey);
      if (parsed) {
        return parsed.connId;
      }
    }
    if (activeDatabaseKey) {
      const parsed = parseDatabaseNodeId(activeDatabaseKey);
      if (parsed) {
        return parsed.connId;
      }
    }
    return activeConnId;
  }, [activeTableKey, activeDatabaseKey, activeConnId]);

  // 兜底同步：树点击 / SQL seed 变化等未走 activateWorkspaceTab 的路径。
  // setLinkage 自身去重；transition 未 commit 时 deps 不变，不会用旧 key 覆盖 store。
  useEffect(() => {
    useDbSidebarLinkageStore.getState().setLinkage({
      activeConnId: sidebarLinkageConnId,
      activeDatabaseKey,
      activeTableKey });
  }, [sidebarLinkageConnId, activeDatabaseKey, activeTableKey]);

  // 同步所有已打开 Tab 对应的树节点 id 集合到 store，用于连接树标记"已打开 Tab"的节点。
  // workspaceTabs 变化（增删 Tab）或 sqlTabPanelKeySeed 变化（SQL tab 切库/切表）时重算。
  useEffect(() => {
    const tabState = useDbWorkspaceTabStore.getState();
    const ids = collectOpenTabNodeIds(workspaceTabs, {
      sqlTabStates: tabState.sqlTabStates,
      tablePreviews: tabState.tablePreviews });
    useDbSidebarLinkageStore.getState().setOpenTabNodeIds(ids);
  }, [workspaceTabs, sqlTabPanelKeySeed, tablePreviewTabIdKey]);

  const panelContentKeysByTab = useMemo(() => {
    const tabState = useDbWorkspaceTabStore.getState();
    return buildDatabasePanelContentKeysByTab({
      workspaceTabs,
      sqlTabStates: tabState.sqlTabStates,
      tablePreviews: tabState.tablePreviews,
      tableDesignerStates,
      connections });
  }, [workspaceTabs, tableDesignerStates, connections, sqlTabPanelKeySeed, tablePreviewTabIdKey]);

  const schemaContextValue = useMemo(
    () => ({
      databasesByConnId,
      schemaByKey,
      schemaLoadingKey }),
    [databasesByConnId, schemaByKey, schemaLoadingKey],
  );

  const databaseModuleContext = useMemo(() => {
    const { sqlTabStates, tablePreviews } = useDbWorkspaceTabStore.getState();
    return resolveDatabaseModuleContext(
      connections,
      activeConnId,
      activeWorkspaceTab,
      sqlTabStates,
      tablePreviews,
    );
  }, [connections, activeConnId, activeWorkspaceTab, activeSqlSidebarSeed]);

  const editorHostTabId = rowEdit?.tabId ?? null;
  const editorTableColumnMeta = useDbWorkspaceTabStore((state) =>
    editorHostTabId ? state.tableColumnMeta[editorHostTabId] : undefined,
  );
  const editorTabDirtyRows = useDbWorkspaceTabStore((state) =>
    editorHostTabId
      ? state.tabDirtyRows[editorHostTabId] ?? EMPTY_TAB_DIRTY_ROWS
      : EMPTY_TAB_DIRTY_ROWS,
  );
  return {
    activeTabContextValue,
    activeTreeChartFileId,
    activeWorkspaceId,
    activeWorkspaceTab,
    buildExportMenuItems,
    buildSchemaContextMenuItems,
    connections,
    connectionsLoading,
    createDbDialog,
    csvExportDialog,
    ctxMenu,
    databaseModuleContext,
    dialogOpen,
    dockTabs,
    editingConnection,
    editorHostTabId,
    editorTabDirtyRows,
    editorTableColumnMeta,
    exportDialog,
    exportMenu,
    exportSubmitting,
    handleCloseDockTab,
    handleConfirmExportDatabase,
    handleConfirmImportDatabase,
    handleContextAction,
    handleCreateConnection,
    handleDeleteConnection,
    handleDockTabContextMenu,
    handleDockTabDoubleClick,
    handleImportNavicat,
    handleNewSqlQuery,
    handleNewTreeChart,
    handleOpenScratchQuery,
    handleOpenSyncTask,
    handlePanelTransferredToWorkspace,
    handleRowSave,
    handleRunSyncTask,
    handleSchemaCacheConnectionPatched,
    handleSelectConnection,
    handleSelectDatabase,
    handleSelectTable,
    importDialog,
    importPreview,
    importSubmitting,
    isActiveRoute,
    moduleLive,
    moduleSoftRefreshKey,
    openSqlFile,
    openTreeChartFile,
    panelContentKeysByTab,
    performMoveTabToWorkspace,
    recentClosedActionItems,
    refreshConnDatabases,
    refreshConnections,
    renderDockPanel,
    rowEdit,
    schemaContextValue,
    schemaRefreshToken,
    setActiveConnId,
    setCreateDbDialog,
    setCsvExportDialog,
    setCtxMenu,
    setDialogOpen,
    setEditingConnection,
    setExportDialog,
    setExportMenu,
    setImportDialog,
    setImportPreview,
    setRowEdit,
    setSchemaRefreshToken,
    sidebarConnections,
    sqlQueryBindingContext,
    t,
    workspaceInitialized,
    workspaceStateValue,
    workspaceTabs,
    workspaces };
}
