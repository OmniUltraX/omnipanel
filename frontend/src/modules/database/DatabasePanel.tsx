import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  startTransition,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { ModuleWorkspaceLayout } from "../../components/workspace";
import type { SchemaDatabaseSelection, SchemaTableSelection, SchemaContextMenuContext } from "./schema/SchemaBrowser";
import type { SchemaTreeItem } from "./schema/schemaTreeItem";
import type { ContextMenuItem } from "../../components/ui/ContextMenu";
import { DatabaseSchemaSidebar } from "./schema/DatabaseSchemaSidebar";
import {
  DatabaseModuleContextBridge,
  resolveDatabaseModuleContext,
} from "./ai";
import { DatabaseTablesPanel } from "./workspace/DatabaseTablesPanel";
import { DatabaseConnectionInfoPanel } from "./workspace/DatabaseConnectionInfoPanel";
import { RedisConnectionInfoPanel } from "./workspace/RedisConnectionInfoPanel";
import { DatabaseSlowQueryLogPanel } from "./workspace/DatabaseSlowQueryLogPanel";
import { RedisQueryPanel } from "./redis/RedisQueryPanel";
import { ConnectionResolvedDockPane } from "./workspace/ConnectionResolvedDockPane";
import { DbSchemaProvider } from "./schema/DbSchemaContext";
import { ConnectionDialog } from "./connection/ConnectionDialog";
import { ConnectionImportPreviewDialog } from "./connection/ConnectionImportPreviewDialog";
import { ContextMenu } from "../../components/ui/ContextMenu";
import { appConfirm } from "../../lib/appConfirm";
import { appAlert } from "../../lib/appAlert";
import { IconDropdownButton } from "../../components/ui/IconDropdownButton";
import { buildTabCloseMenuItems, type TabContextMenuAction } from "../../components/ui/menu";
import { useActionStore } from "../../stores/actionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useDbGroupStore } from "../../stores/dbGroupStore";
import { useDbSchemaFilterStore } from "../../stores/dbSchemaFilterStore";
import { useDbSchemaTreeExpandedStore } from "../../stores/dbSchemaTreeExpandedStore";
import { useDbSchemaCacheStore } from "../../stores/dbSchemaCacheStore";
import { usePoolConnectionRegistration, type PoolKind } from "../../stores/connectionPoolStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useSshConnectionStore } from "../../stores/sshConnectionStore";
import { getVisibleNames, mergeFilter } from "./schema/DatabaseFilterDialog";
import { useI18n } from "../../i18n";
import { showToast } from "../../stores/toastStore";
import { quickInput } from "../../lib/quickInput";
import { useModuleSuspended } from "../../lib/moduleVisibility";
import { isSqlEditorFocused, sqlAtOffset } from "./sqlIntel/sqlStatement";
import { makeQueryRunId, isQueryCancelledError } from "./sql/queryRun";
import type { DbSqlFileNode } from "../../stores/dbSqlFileStore";
import { resolveSqlTabStateFromFile, useDbSqlFileStore } from "../../stores/dbSqlFileStore";
import {
  formatTreeChartFileLabel,
  useDbTreeChartFileStore,
  type DbTreeChartFileNode,
} from "../../stores/dbTreeChartFileStore";
import { useDbDataDictionaryStore, type DataDictionaryEntry } from "../../stores/dbDataDictionaryStore";
import {
  connectionMatchesGroup,
  normalizeConnectionGroup,
  countTable,
  fetchTableDdl,
  introspectTable,
  listConnections,
  listDatabases,
  deleteConnection,
  loadSchemaCache,
  loadSchemaFilters,
  loadSchemaTreeExpanded,
  isMysqlConnectionInfoCapable,
  previewTable,
  saveConnection,
  isConnectionEnabled,
  isSqlCapableConnection,
  isRedisConnection,
  isToolboxCapableConnection,
  type DbColumnMeta,
  type DbConnectionConfig,
} from "./api";
import { buildDatabaseSchema, introspectToTableSchemas } from "./sqlEditor/language/completionItems";
import { formatSql } from "./sqlIntel/sqlFormat";
import { sqlRequiresDatabaseContext } from "./sqlIntel/connectionLevelSql";
import { toCsv } from "./shared/csvExport";
import { fetchAndApplyTableColumnMeta, isAutoIncrementColumn } from "./shared/columnMetaUtils";
import { isSameCellValue, shouldUseInlineCellEdit } from "./cell_editor";
import { buildRedisColumnMeta, buildRedisUpdateCommands } from "./redis/redisTableMeta";
import { getCachedDatabaseNames, getCachedTableColumns } from "./schema/schemaCacheMerge";
import { snapshotToFilterStates } from "./schema/schemaFilters";
import type { SchemaCacheConnectionEntry } from "./schema/schemaCache";
import { submitSchemaCacheRefresh, probeDbConnectionRuntime, isSchemaCacheEntryOk } from "./schema/schemaCacheBackgroundTasks";
import { takeBootstrappedDbConnections } from "./schema/initDbSchemaUiStores";
import { warmPrioritySchemaConnections } from "./schema/schemaWarmPriority";
import { useDbConnectionRuntimeStore } from "../../stores/dbConnectionRuntimeStore";
import { createSchemaCacheRefreshReporter } from "./schema/schemaCacheStatusLog";
import { CreateDatabaseDialog } from "./workspace/CreateDatabaseDialog";
import {
  probeMysqlDeployment,
} from "./mysqlDeploymentDetect";
import { readMysqlDeploymentCache } from "./mysqlDeploymentCache";
import {
  resolveMysqlExportDeployment,
  beginWatchMysqlExportTask,
  submitDbMysqlExport,
} from "./mysqlExport";
import {
  beginWatchMysqlImportTask,
  submitDbMysqlImport,
  type MysqlImportSource,
} from "./mysqlImport";
import { MysqlImportDialog } from "./workspace/MysqlImportDialog";
import { parseDatabaseNodeId, parseTableNodeId } from "./schema/schemaTreeIds";
import type { DatabaseSchema } from "./types";
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
  findPreviewDockTab,
  makeDesignerTabId,
  makeConnectionInfoTabId,
  makeSlowQueryLogTabId,
  makeRedisQueryTabId,
  isModuleDockTab,
  isToolboxTab,
  makeSyncTaskWorkspaceTab,
  findTabIdForSyncTask,
  syncTaskDockTabId,
  makeTableDesignerTabLabel,
  makeSqlTabLabel,
  makeTreeChartTabId,
  type SchemaDockOpenMode,
  type ConnectionInfoWorkspaceTab,
  type SlowQueryLogWorkspaceTab,
  type DbWorkspaceTab,
  type RedisQueryWorkspaceTab,
  type SqlWorkspaceTab,
  type TableDesignerWorkspaceTab,
  type TablePreviewWorkspaceTab,
  type ToolboxWorkspaceTab,
  type TreeChartWorkspaceTab,
} from "./workspace/workspaceTabs";
import { TreeChartPanel } from "./treeChart/TreeChartPanel";
import { DatabaseToolbox } from "./toolbox/DatabaseToolbox";
import { TableDesignerDockPane } from "./tableDesigner/TableDesignerDockPane";
import { DataDictionaryDialog } from "./workspace/DataDictionaryDialog";
import { supportsTableDesign, resolveTableDesignerDriver } from "./tableDesigner/resolveTableDesignerDriver";
import { DatabaseTableEditorHost } from "./workspace/DatabaseTableEditorHost";
import type { SyncTask } from "./toolbox/types";
import { useDbSyncTaskStore } from "../../stores/dbSyncTaskStore";
import {
  createDefaultSqlTabState,
  createDefaultTablePreviewState,
  createSqlResultSession,
  findTemporarySqlResultSession,
  reuseTemporarySqlResultSession,
  type SqlResultSession,
  estimateTablePreviewTotalRows,
  NEW_ROW_KEY_PREFIX,
  DELETED_ROW_KEY_PREFIX,
  PENDING_INSERT_ROW_KEY,
  resolveSqlTabConnectionId,
  rowsToRecord,
  tabModeToEditorOpenMode,
  type SortState,
  type SqlTabState,
  type TableDesignerTabState,
  type TablePreviewState,
  type QueryResult,
  resolveConnIdForWorkspaceTab,
} from "./workspace/dbWorkspaceState";
import { DatabaseWorkspaceDock } from "./workspace/DatabaseWorkspaceDock";
import {
  buildDatabasePanelContentKeysByTab,
  buildSqlTabPanelKeySeed,
  selectTablePreviewTabIdKey,
} from "./workspace/databasePanelTabKeys";
import { DbPanelSurface } from "./workspace/DbPanelSurface";
import { DbTablePreviewSurface } from "./workspace/DbTablePreviewSurface";
import { DbSidebarLinkageProvider } from "./schema/DbSidebarLinkageContext";
import { buildSelectAllFromTableSql } from "./grid/tablePreviewFilter";
import { fetchTablePreviewPage } from "./grid/tablePreviewQuery";
import {
  probeSlowLogAvailability,
  resolveSlowLogAvailabilitySync,
  type SlowLogAvailability,
} from "./mysqlSlowQueryLog";
import type { RuleGroupType } from "react-querybuilder";
import { patchDockTabFileMeta, patchDockTabPreviewMeta } from "../../components/dock/dockTabLiveMeta";
import { DbWorkspaceProviders } from "../../contexts/DbWorkspaceContext";
import type {
  DbWorkspaceMirrorContextValue,
  DbWorkspaceSharedContextValue,
} from "../../contexts/DbWorkspaceContext.types";
import { useDbDockLayoutStore, removeTabFromLayout } from "../../stores/dbDockLayoutStore";
import {
  schedulePersistWorkspaceSession,
  flushPersistWorkspaceSession,
  useDbWorkspaceSessionStore,
} from "../../stores/dbWorkspaceSessionStore";
import {
  buildClosedPanelEntry,
  buildWorkspaceSessionSnapshot,
  restoreTableDesignerStateFromSnapshot,
  sanitizeWorkspaceSession,
  tablePreviewStateFromSnapshot,
  type DbClosedPanelEntry,
  type DbSqlTabStateSnapshot,
} from "./workspace/dbWorkspaceSession";
import { useWorkspaceBottomDockStore } from "../../stores/workspaceBottomDockStore";
import { publishDbWorkspaceMirror } from "../../stores/dbWorkspaceMirrorStore";
import {
  EMPTY_TAB_DIRTY_ROWS,
  selectDbTabWorkspaceMirrorSlice,
  useDbWorkspaceTabStore,
} from "../../stores/dbWorkspaceTabStore";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { dbTabToSnapshot } from "../../lib/workspaceTabActions";
import { subscribeDockviewTransfer, relayoutDockviewInstances } from "../../lib/dockviewRegistry";
import { deliverSnapshotToWorkspace } from "../../lib/workspaceSnapshotDelivery";
import type { DbTabSnapshot } from "../../stores/workspaceTabStore";
import { connectionNodeId } from "./schema/schemaTreeExpanded";
import { loadNavicatImportPreview } from "./navicatImport/loadNavicatNcxFile";
import type { NavicatImportPreviewItem } from "./navicatImport/types";

type DbModuleTab = "query" | "dataSync" | "schemaSync";
const DB_MODULE_TABS: DbModuleTab[] = ["query", "dataSync", "schemaSync"];
const EMPTY_DOCKED_DATABASE_TABS: string[] = [];

function tabMatchesTableSelection(
  tab: DbWorkspaceTab,
  connId: string,
  dbName: string,
  tableName: string,
): boolean {
  return (
    tab.kind === "table" &&
    tab.connId === connId &&
    tab.dbName === dbName &&
    tab.tableName === tableName
  );
}

function tabMatchesDatabaseSelection(
  tab: DbWorkspaceTab,
  connId: string,
  dbName: string,
  isRedis: boolean,
): boolean {
  if (isRedis) {
    return tab.kind === "redis-query" && tab.connId === connId && tab.dbName === dbName;
  }
  return tab.kind === "database" && tab.connId === connId && tab.dbName === dbName;
}

function tabMatchesConnectionSelection(
  tab: DbWorkspaceTab,
  connId: string,
  _isRedis: boolean,
): boolean {
  return tab.kind === "connection" && tab.connId === connId;
}

function restoreSqlTabStateFromSnapshot(snap: DbSqlTabStateSnapshot): SqlTabState {
  return {
    ...createDefaultSqlTabState(snap.database, snap.connId ?? ""),
    sql: snap.sql,
    database: snap.database,
    connId: snap.connId ?? "",
    cursorOffset: snap.cursorOffset,
  };
}

function applyDefaultWorkspaceSession(
  setWorkspaceTabs: (tabs: DbWorkspaceTab[]) => void,
  activateTab: (id: string) => void,
): void {
  setWorkspaceTabs([]);
  activateTab("");
  useDbWorkspaceTabStore.getState().resetTabWorkspace();
}


/** 把行主键拼成的字符串（"col=val&col=val"）解析回单列值，rowKey 中空字符串表示 NULL */
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

export function DatabasePanel() {
  const { t } = useI18n();
  const schemaCacheReporter = useMemo(() => createSchemaCacheRefreshReporter(t), [t]);
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/database";
  const moduleSuspended = useModuleSuspended();
  const moduleLive = isActiveRoute && !moduleSuspended;
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
  const groups = useDbGroupStore((s) => s.groups);
  const activeGroupId = useDbGroupStore((s) => s.activeGroupId);
  const setActiveGroupId = useDbGroupStore((s) => s.setActiveGroupId);
  const getGroupName = useDbGroupStore((s) => s.getGroupName);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<{
    fileName: string;
    items: NavicatImportPreviewItem[];
  } | null>(null);
  const [editingConnection, setEditingConnection] = useState<DbConnectionConfig | null>(null);
  const [schemaRefreshToken, setSchemaRefreshToken] = useState(0);

  const dictionaries = useDbDataDictionaryStore((s) => s.dictionaries);
  const addDictionary = useDbDataDictionaryStore((s) => s.addDictionary);
  const updateDictionary = useDbDataDictionaryStore((s) => s.updateDictionary);
  const [dictDialogOpen, setDictDialogOpen] = useState(false);
  const [editingDictEntry, setEditingDictEntry] = useState<DataDictionaryEntry | null>(null);

  const [connections, setConnections] = useState<DbConnectionConfig[]>(() => {
    return takeBootstrappedDbConnections() ?? [];
  });
  const [connectionsLoading, setConnectionsLoading] = useState(() => {
    return takeBootstrappedDbConnections() === null;
  });
  const sshConnections = useConnectionStore(
    useShallow((state) => state.connections.filter((conn) => conn.kind === "ssh")),
  );
  const sshSessionActiveMap = useSshConnectionStore((state) => state.sessionActiveMap);
  const [slowLogAvailabilityByConnId, setSlowLogAvailabilityByConnId] = useState<
    Record<string, SlowLogAvailability>
  >({});
  const slowLogProbeGenRef = useRef(0);
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
  const openConnectionInfoTabRef = useRef<(connId: string, mode?: SchemaDockOpenMode) => void>(() => {});
  const [workspaceTabs, setWorkspaceTabsState] = useState<DbWorkspaceTab[]>([]);
  const setWorkspaceTabs = useCallback(
    (update: DbWorkspaceTab[] | ((prev: DbWorkspaceTab[]) => DbWorkspaceTab[])) => {
      setWorkspaceTabsState((prev) => {
        const next = typeof update === "function" ? update(prev) : update;
        workspaceTabsRef.current = next;
        return next;
      });
    },
    [],
  );
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

  const handleOpenDictDialog = (entry?: DataDictionaryEntry | null) => {
    setEditingDictEntry(entry ?? null);
    setDictDialogOpen(true);
  };

  const handleDictSubmit = (name: string, data: string) => {
    if (editingDictEntry) {
      updateDictionary(editingDictEntry.id, name, data);
    } else {
      addDictionary(name, data);
    }
    setDictDialogOpen(false);
    setEditingDictEntry(null);
  };

  const [createDbDialog, setCreateDbDialog] = useState<
    | {
        connId: string;
      }
    | null
  >(null);
  const [importDialog, setImportDialog] = useState<{
    connection: DbConnectionConfig;
    databaseName: string;
  } | null>(null);
  const [importSubmitting, setImportSubmitting] = useState(false);
  const dockLayout = useDbDockLayoutStore((s) => s.savedLayout);
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

  const syncConnForTabId = useCallback((tabId: string) => {
    if (!tabId) {
      setActiveConnIdIfChanged(null);
      return;
    }
    const tab = workspaceTabsRef.current.find((item) => item.id === tabId);
    const connId = resolveConnIdForWorkspaceTab(tab, useDbWorkspaceTabStore.getState());
    if (connId) {
      setActiveConnIdIfChanged(connId);
    }
  }, [setActiveConnIdIfChanged]);

  const activateWorkspaceTab = useCallback(
    (tabId: string) => {
      // 同步更新：侧栏联动依赖 activeWorkspaceTab / activeConnId，不能丢进 transition
      setActiveWorkspaceTabId((prev) => (prev === tabId ? prev : tabId));
      syncConnForTabId(tabId);
    },
    [syncConnForTabId],
  );

  const syncTasks = useDbSyncTaskStore((s) => s.tasks);

  const openSyncTaskTab = useCallback(
    (task: SyncTask, runAfterLoad = false) => {
      const tabId =
        findTabIdForSyncTask(workspaceTabsRef.current, task.id) ?? syncTaskDockTabId(task.id);
      const existing = workspaceTabsRef.current.find((item) => item.id === tabId);
      if (!existing) {
        const tab = makeSyncTaskWorkspaceTab(task);
        setWorkspaceTabs((prev) => (prev.some((item) => item.id === tab.id) ? prev : [...prev, tab]));
      } else if (existing.label !== task.name || (existing as ToolboxWorkspaceTab).toolboxTab !== task.kind) {
        setWorkspaceTabs((prev) =>
          prev.map((item) =>
            item.id === tabId
              ? { ...item, label: task.name, toolboxTab: task.kind } as DbWorkspaceTab
              : item,
          ),
        );
      }
      activateWorkspaceTab(tabId);
      useDbSyncTaskStore.getState().setActiveTaskId(task.id);
      useDbSyncTaskStore.getState().requestLoad(task.id, runAfterLoad);
    },
    [activateWorkspaceTab, setWorkspaceTabs],
  );

  const handleOpenSyncTask = useCallback(
    (task: SyncTask) => {
      openSyncTaskTab(task, false);
    },
    [openSyncTaskTab],
  );

  const handleRunSyncTask = useCallback(
    (task: SyncTask) => {
      openSyncTaskTab(task, true);
    },
    [openSyncTaskTab],
  );

  const clearPreviewTabSlotData = useCallback(
    (tabId: string) => {
      removeTabWorkspaceData(tabId);
      setTableDesignerStates((prev) => {
        if (!(tabId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
    },
    [removeTabWorkspaceData],
  );

  const promotePreviewTab = useCallback(
    (tabId: string) => {
      // 去掉 flushSync：升格预览不再强制同步阻塞开 Tab 帧
      startTransition(() => {
        setWorkspaceTabs((prev) =>
          prev.map((tab) => (tab.id === tabId ? { ...tab, preview: undefined } : tab)),
        );
      });
      patchDockTabPreviewMeta(tabId, false);
    },
    [setWorkspaceTabs],
  );

  /** 激活已有 Dock Tab；双击树节点时若当前为预览 Tab 则升格为常驻。 */
  const activateExistingDockTab = useCallback(
    (tabId: string, mode: SchemaDockOpenMode = "permanent") => {
      if (mode === "permanent") {
        const tab = workspaceTabsRef.current.find((item) => item.id === tabId);
        if (tab?.preview) {
          promotePreviewTab(tabId);
        }
      }
      activateWorkspaceTab(tabId);
    },
    [activateWorkspaceTab, promotePreviewTab],
  );

  const handleDockTabDoubleClick = useCallback(
    (tabId: string) => {
      const tab = workspaceTabsRef.current.find((item) => item.id === tabId);
      if (!tab?.preview) {
        return;
      }
      promotePreviewTab(tabId);
      activateWorkspaceTab(tabId);
    },
    [promotePreviewTab, activateWorkspaceTab],
  );

  const replacePreviewDockTab = useCallback(
    (previewTabId: string, nextTab: DbWorkspaceTab) => {
      const prevTab = workspaceTabsRef.current.find((tab) => tab.id === previewTabId);
      const inPlaceTableSwap = prevTab?.kind === "table" && nextTab.kind === "table";

      if (inPlaceTableSwap) {
        setTabDirtyRows((prev) => {
          if (!(previewTabId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[previewTabId];
          return next;
        });
        setCommittingTabs((prev) => {
          if (!prev.has(previewTabId)) {
            return prev;
          }
          const next = new Set(prev);
          next.delete(previewTabId);
          return next;
        });
      } else {
        clearPreviewTabSlotData(previewTabId);
      }
      patchDockTabPreviewMeta(previewTabId, true);
      setWorkspaceTabs((prev) =>
        prev.map((tab) =>
          tab.id === previewTabId ? { ...nextTab, id: previewTabId, preview: true } : tab,
        ),
      );
      activateWorkspaceTab(previewTabId);
      return previewTabId;
    },
    [
      clearPreviewTabSlotData,
      setWorkspaceTabs,
      activateWorkspaceTab,
      setTabDirtyRows,
      setCommittingTabs,
    ],
  );

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
      if (!tab || useDbWorkspaceTabStore.getState().tablePreviews[tab.id]?.tableName) {
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

    if (
      (patch.connId !== undefined || patch.database !== undefined) &&
      activeWorkspaceTabIdRef.current === tabId
    ) {
      syncConnForTabId(tabId);
    }
  }, [persistSqlFileState, syncSqlFileTabHeaderMeta, syncConnForTabId]);

  const updateSqlResultSession = useCallback(
    (sqlTabId: string, sessionId: string, patch: Partial<SqlResultSession>) => {
      setSqlTabStates((prev) => {
        const tab = prev[sqlTabId] ?? createDefaultSqlTabState();
        const sessions = tab.resultSessions ?? [];
        return {
          ...prev,
          [sqlTabId]: {
            ...tab,
            resultSessions: sessions.map((session) =>
              session.id === sessionId ? { ...session, ...patch } : session,
            ),
          },
        };
      });
    },
    [setSqlTabStates],
  );

  const closeSqlResultSession = useCallback(
    (sqlTabId: string, sessionId: string) => {
      setSqlTabStates((prev) => {
        const tab = prev[sqlTabId] ?? createDefaultSqlTabState();
        const sessions = (tab.resultSessions ?? []).filter((item) => item.id !== sessionId);
        const activeResultSessionId =
          tab.activeResultSessionId === sessionId
            ? sessions[sessions.length - 1]?.id ?? null
            : tab.activeResultSessionId;
        return {
          ...prev,
          [sqlTabId]: {
            ...tab,
            resultSessions: sessions,
            activeResultSessionId,
          },
        };
      });
    },
    [setSqlTabStates],
  );

  const setSqlResultSessionPinned = useCallback(
    (sqlTabId: string, sessionId: string, pinned: boolean) => {
      setSqlTabStates((prev) => {
        const tab = prev[sqlTabId] ?? createDefaultSqlTabState();
        let sessions = tab.resultSessions ?? [];
        const target = sessions.find((item) => item.id === sessionId);
        if (!target || Boolean(target.pinned) === pinned) {
          return prev;
        }

        if (!pinned) {
          const otherTemp = sessions.find((item) => !item.pinned && item.id !== sessionId);
          if (otherTemp) {
            sessions = sessions.map((item) =>
              item.id === otherTemp.id ? { ...item, pinned: true } : item,
            );
          }
        }

        sessions = sessions.map((item) =>
          item.id === sessionId ? { ...item, pinned } : item,
        );

        return {
          ...prev,
          [sqlTabId]: {
            ...tab,
            resultSessions: sessions,
          },
        };
      });
    },
    [setSqlTabStates],
  );

  const setSqlTabConnection = useCallback(
    (tabId: string, connId: string | null) => {
      const nextConnId = connId ?? "";
      const prevConnId =
        useDbWorkspaceTabStore.getState().sqlTabStates[tabId]?.connId ?? "";
      if (nextConnId === prevConnId) {
        return;
      }
      updateSqlTabState(tabId, { connId: nextConnId, database: "" });
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
    // 已有列表时不进入全屏 loading，避免刷新时把侧栏树卸掉
    if (connections.length === 0) {
      setConnectionsLoading(true);
    }
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
  }, [activeGroupName, connections.length]);

  const handleImportConnections = useCallback(async () => {
    try {
      const preview = await loadNavicatImportPreview(connections);
      if (!preview) {
        return;
      }
      setImportPreview(preview);
    } catch (error) {
      const message =
        String(error).includes("EMPTY")
          ? t("database.connectionImport.emptyFile")
          : t("database.connectionImport.parseFailed", { error: String(error) });
      await appAlert(message, t("database.connectionImport.previewTitle"));
    }
  }, [connections, t]);

  useEffect(() => {
    void refreshConnections();
  }, [schemaRefreshToken, refreshConnections]);

  const resolveSlowLogDisabledReason = useCallback(
    (availability: SlowLogAvailability): string => {
      switch (availability.reason) {
        case "not_mysql":
          return t("database.contextMenu.slowQueryLogDisabled.notMysql");
        case "no_ssh":
          return t("database.contextMenu.slowQueryLogDisabled.noSsh");
        case "ssh_not_connected":
          return t("database.contextMenu.slowQueryLogDisabled.sshNotConnected");
        case "connection_disabled":
          return t("database.contextMenu.slowQueryLogDisabled.connectionDisabled");
        case "checking":
          return t("database.contextMenu.slowQueryLogDisabled.checking");
        case "slow_log_off":
          return t("database.contextMenu.slowQueryLogDisabled.slowLogOff");
        case "slow_log_file_missing":
          return t("database.contextMenu.slowQueryLogDisabled.slowLogFileMissing");
        default:
          return t("database.contextMenu.slowQueryLogDisabled.probeFailed");
      }
    },
    [t],
  );

  useEffect(() => {
    const mysqlConnections = connections.filter(isMysqlConnectionInfoCapable);
    if (mysqlConnections.length === 0) {
      setSlowLogAvailabilityByConnId({});
      return;
    }

    const gen = ++slowLogProbeGenRef.current;
    const syncMap: Record<string, SlowLogAvailability> = {};
    for (const conn of mysqlConnections) {
      syncMap[conn.id] = resolveSlowLogAvailabilitySync(conn, sshConnections);
    }
    setSlowLogAvailabilityByConnId(syncMap);

    void (async () => {
      for (const conn of mysqlConnections) {
        const sync = syncMap[conn.id];
        if (!sync || sync.reason !== "checking") {
          continue;
        }
        if (!isConnectionEnabled(conn)) {
          if (slowLogProbeGenRef.current !== gen) return;
          setSlowLogAvailabilityByConnId((prev) => ({
            ...prev,
            [conn.id]: {
              enabled: false,
              reason: "connection_disabled",
              sshConnectionId: sync.sshConnectionId,
            },
          }));
          continue;
        }
        const result = await probeSlowLogAvailability(conn, sshConnections);
        if (slowLogProbeGenRef.current !== gen) return;
        setSlowLogAvailabilityByConnId((prev) => ({ ...prev, [conn.id]: result }));
      }
    })();
  }, [connections, sshConnections, sshSessionActiveMap]);

  useEffect(() => {
    const bootstrapWorkspace = () => {
      const session = sanitizeWorkspaceSession(useDbWorkspaceSessionStore.getState().session);
      if (!session) {
        applyDefaultWorkspaceSession(setWorkspaceTabs, activateWorkspaceTab);
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

  // 工作区就绪后：仅对 Tab 引用的连接做真实连通探测（本地缓存不标绿点）
  useEffect(() => {
    if (!workspaceInitialized || connectionsLoading) {
      return;
    }
    void warmPrioritySchemaConnections(schemaCacheReporter, {
      workspaceTabs: workspaceTabsRef.current,
    }).catch((err) => {
      schemaCacheReporter.onError?.(String(err));
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
        tableDesignerStates: tableDesignerStatesRef.current,
      });
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
    if (!workspaceInitialized || !activeWorkspaceTabId) {
      return;
    }
    if (workspaceTabs.some((tab) => tab.id === activeWorkspaceTabId)) {
      return;
    }
    const fallback = workspaceTabs.find((tab) => isModuleDockTab(tab))?.id ?? "";
    activateWorkspaceTab(fallback);
  }, [workspaceInitialized, workspaceTabs, activeWorkspaceTabId, activateWorkspaceTab]);

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
        if (!task || (tab.label === task.name && tab.toolboxTab === task.kind)) {
          return tab;
        }
        changed = true;
        return { ...tab, label: task.name, toolboxTab: task.kind };
      });
      return changed ? next : prev;
    });
  }, [workspaceInitialized, syncTasks, setWorkspaceTabs]);

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
            error: "Connection not found",
          }),
        }));
        continue;
      }

      void introspectTable(connection, tab.dbName, tab.tableName)
        .then((schema) => {
          if (connection.db_type !== "redis") {
            setTableColumnMeta((prev) => ({ ...prev, [tab.id]: schema.columns }));
          }
        })
        .catch(() => {});

      const sort = previewState?.sort ?? null;
      const filter = previewState?.filter ?? null;
      const columnRelations = previewState?.columnRelations ?? {};
      const hiddenColumns = previewState?.hiddenColumns ? [...previewState.hiddenColumns] : [];
      const transposed = previewState?.transposed ?? false;
      const page = previewState?.page ?? 0;
      const pageSize = previewState?.pageSize ?? createDefaultTablePreviewState().pageSize;
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
        columnRelations,
      })
        .then(({ data, totalRows = 0 }) => {
          if (connection.db_type === "redis") {
            setTableColumnMeta((prev) => ({
              ...prev,
              [tab.id]: buildRedisColumnMeta(data.columns),
            }));
          }
          setTablePreviews((prev) => ({
            ...prev,
            [tab.id]: {
              ...(prev[tab.id] ?? createDefaultTablePreviewState()),
              loading: false,
              error: null,
              data,
              totalRows,
              page,
              pageSize,
              connId: tab.connId,
              dbName: tab.dbName,
              tableName: tab.tableName,
              sort,
              filter,
              hiddenColumns,
              transposed,
              columnRelations,
            },
          }));
        })
        .catch((error) => {
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
              columnRelations,
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
            dbType: cached.dbType ?? conn.db_type,
          },
        ];
      }
      return [
        buildDatabaseSchema(database, [], {
          connectionName: conn.name,
          dbType: conn.db_type,
        }),
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
        [connId]: mergeFilter(prev[connId], names),
      }));
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
          dbType: conn.db_type,
        }),
      }));
    }
  }, [
    workspaceTabs,
    sqlTabPanelKeySeed,
    resolveSqlTabConnection,
    schemaByKey,
    cacheHydrated,
    schemaRevision,
  ]);

  const loadTablePreview = useCallback(
    async (tabId: string, connection: DbConnectionConfig, dbName: string, tableName: string) => {
      const connForSchema = { ...connection, database: dbName };
      const defaultState = createDefaultTablePreviewState();
      const pageSize =
        useDbWorkspaceTabStore.getState().tablePreviews[tabId]?.pageSize ?? defaultState.pageSize;

      setTablePreviews((prevMap) => ({
        ...prevMap,
        [tabId]: {
          ...(prevMap[tabId] ?? defaultState),
          connId: connection.id,
          dbName,
          tableName,
          loading: true,
          error: null,
        },
      }));

      if (connection.db_type !== "redis") {
        const cachedColumns = getCachedTableColumns(
          useDbSchemaCacheStore.getState().snapshot,
          connection.id,
          dbName,
          tableName,
        );
        if (cachedColumns?.length) {
          setTableColumnMeta((prevMeta) => {
            if (prevMeta[tabId]?.length) {
              return prevMeta;
            }
            return { ...prevMeta, [tabId]: cachedColumns };
          });
        }
        fetchAndApplyTableColumnMeta(tabId, connection, dbName, tableName, (columns) => {
          setTableColumnMeta((prevMeta) => ({ ...prevMeta, [tabId]: columns }));
        });
      }

      const countPromise = countTable(connForSchema, tableName, dbName).catch(() => null);

      try {
        const data = await previewTable(connForSchema, tableName, pageSize, 0);
        const rowCount = data.rows.length;
        const estimatedTotal = estimateTablePreviewTotalRows(0, pageSize, rowCount);
        setTablePreviews((prevMap) => ({
          ...prevMap,
          [tabId]: {
            ...(prevMap[tabId] ?? defaultState),
            loading: false,
            error: null,
            data,
            totalRows: estimatedTotal,
            page: 0,
            pageSize,
          },
        }));
        if (connection.db_type === "redis") {
          setTableColumnMeta((prev) => ({
            ...prev,
            [tabId]: buildRedisColumnMeta(data.columns),
          }));
        }

        void countPromise.then((totalRows) => {
          if (totalRows == null) {
            return;
          }
          setTablePreviews((prevMap) => {
            const cur = prevMap[tabId];
            if (!cur) {
              return prevMap;
            }
            return { ...prevMap, [tabId]: { ...cur, totalRows } };
          });
        });
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
    [setTablePreviews, setTableColumnMeta],
  );

  const refreshTablePreview = useCallback(
    (tabId: string, connId: string, dbName: string, tableName: string) => {
      const connection = connections.find((c) => c.id === connId);
      if (!connection) return;

      setTablePreviews((prev) => {
        const existing = prev[tabId] ?? createDefaultTablePreviewState();
        const pageSize = existing.pageSize;
        const page = existing.page;
        const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
        const columnRelations = existing.columnRelations ?? {};

        void fetchTablePreviewPage({
          connection,
          connId,
          tableName,
          dbName,
          page,
          pageSize,
          sort: existing.sort,
          filter: existing.filter,
          columnMeta: colMeta,
          columnRelations,
        })
          .then(({ data, totalRows = 0 }) => {
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
      setTablePreviews((prev) => {
        const existing = prev[tabId] ?? createDefaultTablePreviewState();
        const pageSize = existing.pageSize;
        const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
        const columnRelations = existing.columnRelations ?? {};

        void fetchTablePreviewPage({
          connection,
          connId,
          tableName,
          dbName,
          page,
          pageSize,
          sort: existing.sort,
          filter: existing.filter,
          columnMeta: colMeta,
          columnRelations,
          skipCount: true,
        })
          .then(({ data }) => {
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

  const setTableFilter = useCallback(
    (tabId: string, filter: RuleGroupType | null) => {
      const preview = useDbWorkspaceTabStore.getState().tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      const connId = preview.connId;
      const connection = connections.find((c) => c.id === connId);
      if (!connection) return;

      setTablePreviews((prev) => {
        const existing = prev[tabId] ?? createDefaultTablePreviewState();
        const pageSize = existing.pageSize;
        const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
        const columnRelations = existing.columnRelations ?? {};

        void fetchTablePreviewPage({
          connection,
          connId,
          tableName: preview.tableName!,
          dbName: preview.dbName!,
          page: 0,
          pageSize,
          sort: existing.sort,
          filter,
          columnMeta: colMeta,
          columnRelations,
        })
          .then(({ data, totalRows = 0 }) => {
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
                  filter,
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
                  filter,
                },
              };
            });
          });

        return { ...prev, [tabId]: { ...existing, loading: true, filter } };
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
      const preview = useDbWorkspaceTabStore.getState().tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      refreshTablePreview(tabId, preview.connId, preview.dbName, preview.tableName);
    },
    [refreshTablePreview],
  );

  const goToPageNow = useCallback(
    (tabId: string, page: number) => {
      const preview = useDbWorkspaceTabStore.getState().tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      goToPage(tabId, preview.connId, preview.dbName, preview.tableName, page);
    },
    [goToPage],
  );

  const setTableSort = useCallback(
    (tabId: string, sort: SortState | null) => {
      const preview = useDbWorkspaceTabStore.getState().tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      const connId = preview.connId;
      const connection = connections.find((c) => c.id === connId);
      if (!connection) return;

      setTablePreviews((prev) => {
        const existing = prev[tabId] ?? createDefaultTablePreviewState();
        const pageSize = existing.pageSize;
        const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
        const columnRelations = existing.columnRelations ?? {};

        void fetchTablePreviewPage({
          connection,
          connId,
          tableName: preview.tableName!,
          dbName: preview.dbName!,
          page: 0,
          pageSize,
          sort,
          filter: existing.filter,
          columnMeta: colMeta,
          columnRelations,
        })
          .then(({ data, totalRows = 0 }) => {
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
    [connections],
  );

  const commitTabDirty = useCallback(
    async (
      tabId: string,
      snapshot?: {
        dirty: Record<string, Record<string, unknown>>;
        preview: { connId: string; dbName: string; tableName: string };
        colMeta: DbColumnMeta[];
        connection: DbConnectionConfig;
      },
    ) => {
      const tabState = useDbWorkspaceTabStore.getState();
      const dirty = snapshot?.dirty ?? tabState.tabDirtyRows[tabId];
      if (!dirty) return;
      const preview = snapshot?.preview ?? tabState.tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      const connection =
        snapshot?.connection ?? connections.find((c) => c.id === preview.connId);
      if (!connection) return;
      const colMeta = snapshot?.colMeta ?? tabState.tableColumnMeta[tabId];
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
          if (rowKey.startsWith(DELETED_ROW_KEY_PREFIX)) {
            const originalKey = rowKey.slice(DELETED_ROW_KEY_PREFIX.length);
            const pkValues = pkNames.map((n) => {
              const v = readRowKeyValue(originalKey, n);
              return v === "" ? `\`${n}\` IS NULL` : `\`${n}\` = ${escape(v)}`;
            });
            sqls.push(`DELETE FROM \`${tableName}\` WHERE ${pkValues.join(" AND ")} LIMIT 1`);
            continue;
          }
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
          await invoke("db_execute_query", {
            connection: connForSchema,
            sql,
            runId: makeQueryRunId(),
          });
        }
        clearTabDirty(tabId);
        // Tab 可能已关闭：仅在仍存在预览态时刷新
        if (useDbWorkspaceTabStore.getState().tablePreviews[tabId]) {
          refreshTabPreviewNow(tabId);
        }
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
    [connections, clearTabDirty, refreshTabPreviewNow],
  );

  const rollbackTabDirty = useCallback(
    (tabId: string) => {
      clearTabDirty(tabId);
      refreshTabPreviewNow(tabId);
    },
    [clearTabDirty, refreshTabPreviewNow],
  );

  const closeWorkspaceTabs = useCallback(
    (tabIds: string[]) => {
      const uniqueIds = [...new Set(tabIds.filter(Boolean))];
      if (uniqueIds.length === 0) return;

      const idSet = new Set(uniqueIds);
      const tabStoreSnapshot = useDbWorkspaceTabStore.getState();
      let closedAtSeq = Date.now();
      for (const tab of workspaceTabsRef.current) {
        if (!idSet.has(tab.id)) continue;
        pushRecentClosedPanel(
          buildClosedPanelEntry({
            tab,
            sqlTabStates: tabStoreSnapshot.sqlTabStates,
            tablePreviews: tabStoreSnapshot.tablePreviews,
            tableDesignerStates: tableDesignerStatesRef.current,
            closedAt: closedAtSeq++,
          }),
        );
      }

      setDirtySqlWorkspaceTabIds((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const tabId of uniqueIds) {
          if (next.delete(tabId)) changed = true;
        }
        return changed ? next : prev;
      });

      setWorkspaceTabs((prev) => {
        const nextTabs = prev.filter((item) => !idSet.has(item.id));
        const activeId = activeWorkspaceTabIdRef.current;
        if (activeId && idSet.has(activeId)) {
          const oldIdx = prev.findIndex((item) => item.id === activeId);
          const fallback = nextTabs[Math.min(oldIdx, Math.max(0, nextTabs.length - 1))];
          activateWorkspaceTab(fallback?.id ?? "");
        }
        return nextTabs;
      });

      for (const tabId of uniqueIds) {
        removeTabWorkspaceData(tabId);
      }

      // 同步清理工作区 dock 中的幽灵 tab：源 tab 关闭后 dock 中的对应 tab
      // （payload kind: payload.id === tabId, mirrored kind: originPanelId === tabId）
      // 会因镜像快照被删除而变为空白。主动从 dock store 移除以避免幽灵 tab。
      const dockStore = useWorkspaceBottomDockStore.getState();
      for (const [wsId, tabs] of Object.entries(dockStore.tabsByWorkspace)) {
        if (!tabs) continue;
        const ghostTabIds = tabs
          .filter((t) => {
            if (t.kind === "payload" && t.payload?.module === "database") {
              return uniqueIds.includes(t.payload.id);
            }
            if (t.kind === "mirrored" && t.originScope === "database") {
              return t.originPanelId && uniqueIds.includes(t.originPanelId);
            }
            return false;
          })
          .map((t) => t.id);
        for (const ghostId of ghostTabIds) {
          const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === wsId);
          if (ws) {
            dockStore.removeTab(wsId, ws, ghostId, { skipRecentClosed: true });
          }
        }
      }

      setTableDesignerStates((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const tabId of uniqueIds) {
          if (tabId in next) {
            delete next[tabId];
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      const remainingModuleTabs = workspaceTabsRef.current.filter(isModuleDockTab);
      if (remainingModuleTabs.length === 0) {
        useDbDockLayoutStore.getState().setSavedLayout(null);
        schedulePersistWorkspaceSession(null);
        flushPersistWorkspaceSession();
      }
    },
    [pushRecentClosedPanel, activateWorkspaceTab, removeTabWorkspaceData],
  );

  const closeWorkspaceTab = useCallback(
    (tabId: string) => {
      closeWorkspaceTabs([tabId]);
    },
    [closeWorkspaceTabs],
  );

  const reopenRecentClosedPanel = useCallback(
    (entry: DbClosedPanelEntry) => {
      const { tab } = entry;

      if (tab.kind === "sql" && tab.sqlFileId) {
        const existing = findTabIdForSqlFile(workspaceTabsRef.current, tab.sqlFileId);
        if (existing) {
          activateWorkspaceTab(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
        const file = useDbSqlFileStore.getState().getNode(tab.sqlFileId);
        if (!file || file.type !== "file") {
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (tab.kind === "tree-chart" && tab.treeChartFileId) {
        const existing = findTabIdForTreeChartFile(workspaceTabsRef.current, tab.treeChartFileId);
        if (existing) {
          activateWorkspaceTab(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
        const file = useDbTreeChartFileStore.getState().getNode(tab.treeChartFileId);
        if (!file) {
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
          activateWorkspaceTab(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (tab.kind === "connection") {
        const existing = findTabIdForConnection(workspaceTabsRef.current, tab.connId);
        if (existing) {
          activateWorkspaceTab(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (tab.kind === "redis-query") {
        const existing = findTabIdForRedisQuery(
          workspaceTabsRef.current,
          tab.connId,
          tab.dbName,
        );
        if (existing) {
          activateWorkspaceTab(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (tab.kind === "slow-query") {
        const existing = findTabIdForSlowQueryLog(workspaceTabsRef.current, tab.connId);
        if (existing) {
          activateWorkspaceTab(existing);
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
          activateWorkspaceTab(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (tab.kind === "table") {
        const existing = findTabIdForTable(
          workspaceTabsRef.current.filter(isModuleDockTab),
          tab.connId,
          tab.dbName,
          tab.tableName,
        );
        if (existing) {
          activateWorkspaceTab(existing);
          removeRecentClosedPanel(entry.closedAt);
          return;
        }
      }

      if (workspaceTabsRef.current.some((item) => item.id === tab.id)) {
        activateWorkspaceTab(tab.id);
        removeRecentClosedPanel(entry.closedAt);
        return;
      }

      setWorkspaceTabs((prev) => [...prev, tab]);
      activateWorkspaceTab(tab.id);

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

      if (entry.tableDesignerState) {
        setTableDesignerStates((prev) => ({
          ...prev,
          [tab.id]: restoreTableDesignerStateFromSnapshot(entry.tableDesignerState!),
        }));
      }

      if (tab.kind === "table") {
        const previewState = entry.tablePreviewState;
        setTablePreviews((prev) => ({
          ...prev,
          [tab.id]: tablePreviewStateFromSnapshot(previewState, tab),
        }));
        const connection = connections.find((item) => item.id === tab.connId);
        if (connection) {
          void loadTablePreview(tab.id, connection, tab.dbName, tab.tableName);
        }
      }

      removeRecentClosedPanel(entry.closedAt);
    },
    [connections, loadTablePreview, removeRecentClosedPanel],
  );

  const hasDirty = useCallback(
    (tabId: string) =>
      Object.keys(useDbWorkspaceTabStore.getState().tabDirtyRows[tabId] ?? {}).length > 0,
    [],
  );

  const setTableGridView = useCallback(
    (
      tabId: string,
      patch: Partial<Pick<TablePreviewState, "hiddenColumns" | "transposed" | "columnRelations">>,
    ) => {
      setTablePreviews((prev) => {
        const existing = prev[tabId] ?? createDefaultTablePreviewState();
        return {
          ...prev,
          [tabId]: {
            ...existing,
            ...patch,
            ...(patch.hiddenColumns
              ? { hiddenColumns: [...patch.hiddenColumns] }
              : {}),
            ...(patch.columnRelations !== undefined
              ? {
                  columnRelations: Object.fromEntries(
                    Object.entries(patch.columnRelations).map(([column, relation]) => [
                      column,
                      {
                        tableName: relation.tableName,
                        fieldName: relation.fieldName,
                        ...(relation.displayFieldName?.trim()
                          ? { displayFieldName: relation.displayFieldName.trim() }
                          : {}),
                        ...(relation.alias?.trim() ? { alias: relation.alias.trim() } : {}),
                      },
                    ]),
                  ),
                }
              : {}),
          },
        };
      });
    },
    [],
  );

  const executeTabAction = useCallback(
    (action: {
      kind: "refresh" | "page" | "close" | "sort" | "filter";
      tabId: string;
      page?: number;
      sort?: SortState | null;
      filter?: RuleGroupType | null;
    }) => {
      if (action.kind === "refresh") {
        refreshTabPreviewNow(action.tabId);
      } else if (action.kind === "page") {
        goToPageNow(action.tabId, action.page ?? 0);
      } else if (action.kind === "sort") {
        setTableSort(action.tabId, action.sort ?? null);
      } else if (action.kind === "filter") {
        setTableFilter(action.tabId, action.filter ?? null);
      } else {
        closeWorkspaceTab(action.tabId);
      }
    },
    [refreshTabPreviewNow, goToPageNow, setTableSort, setTableFilter, closeWorkspaceTab],
  );

  const requestTabAction = useCallback(
    (action: {
      kind: "refresh" | "page" | "close" | "sort" | "filter";
      tabId: string;
      page?: number;
      sort?: SortState | null;
      filter?: RuleGroupType | null;
    }) => {
      void (async () => {
        if (action.kind === "close" && hasDirty(action.tabId)) {
          const tabState = useDbWorkspaceTabStore.getState();
          const dirty = tabState.tabDirtyRows[action.tabId];
          const preview = tabState.tablePreviews[action.tabId];
          const colMeta = tabState.tableColumnMeta[action.tabId];
          const dirtyCount = Object.keys(dirty ?? {}).length;
          const commit = await appConfirm(
            t("database.results.dirtyMessage", { count: dirtyCount }),
            t("database.results.dirtyTitle"),
            {
              confirmLabel: t("database.results.dirtyCommit"),
              cancelLabel: t("database.results.dirtyRollback"),
              kind: "warning",
            },
          );

          // 关 Tab 前拷贝提交所需快照（关闭后 store 数据会被清掉）
          const connection =
            preview?.connId != null
              ? connections.find((c) => c.id === preview.connId)
              : undefined;
          const commitSnapshot =
            commit && dirty && preview?.connId && preview.dbName && preview.tableName && colMeta && connection
              ? {
                  dirty: structuredClone(dirty),
                  preview: {
                    connId: preview.connId,
                    dbName: preview.dbName,
                    tableName: preview.tableName,
                  },
                  colMeta: [...colMeta],
                  connection,
                }
              : null;

          if (!commit) {
            rollbackTabDirty(action.tabId);
          }

          // 先关页面，再后台提交（避免卡在 dock 上）
          executeTabAction(action);

          if (commitSnapshot) {
            void commitTabDirty(action.tabId, commitSnapshot).catch((err) => {
              showToast(
                t("database.results.dirtyCommitFailed", {
                  message: err instanceof Error ? err.message : String(err),
                }),
              );
            });
          }
          return;
        }

        if (hasDirty(action.tabId) && action.kind !== "close") {
          const dirtyCount = Object.keys(
            useDbWorkspaceTabStore.getState().tabDirtyRows[action.tabId] ?? {},
          ).length;
          const commit = await appConfirm(
            t("database.results.dirtyMessage", { count: dirtyCount }),
            t("database.results.dirtyTitle"),
            {
              confirmLabel: t("database.results.dirtyCommit"),
              cancelLabel: t("database.results.dirtyRollback"),
              kind: "warning",
            },
          );
          if (commit) {
            try {
              await commitTabDirty(action.tabId);
            } catch {
              return;
            }
          } else {
            rollbackTabDirty(action.tabId);
          }
        }
        executeTabAction(action);
      })();
    },
    [hasDirty, executeTabAction, commitTabDirty, rollbackTabDirty, connections, t],
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

  const handleRowPaste = useCallback(
    (tabId: string, payload: { values: Record<string, unknown> }) => {
      const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
      if (!colMeta?.length) return;
      const pkCols = colMeta.filter((c) => c.isPk);
      const pkCount = pkCols.length;
      const rowKey = `${NEW_ROW_KEY_PREFIX}${crypto.randomUUID()}`;
      const changes: Record<string, unknown> = {};

      for (const col of colMeta) {
        if (isAutoIncrementColumn(col, pkCount)) {
          continue;
        }
        const raw = payload.values[col.name];
        if (raw === undefined) continue;
        if (col.isPk && (raw === null || raw === "")) continue;
        changes[col.name] = raw;
      }

      if (Object.keys(changes).length === 0) return;

      setTabDirtyRows((prev) => {
        const cur = { ...(prev[tabId] ?? {}) };
        cur[rowKey] = changes;
        return { ...prev, [tabId]: cur };
      });
    },
    [],
  );

  const handleRowsDelete = useCallback(
    (
      tabId: string,
      rowInfos: Array<{ rowIndex: number; row: Record<string, unknown> }>,
    ) => {
      if (rowInfos.length === 0) return;
      const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
      if (!colMeta?.length) return;
      const pkCols = colMeta.filter((c) => c.isPk);

      setTabDirtyRows((prev) => {
        const cur = { ...(prev[tabId] ?? {}) };
        for (const { row } of rowInfos) {
          const pendingKey = row[PENDING_INSERT_ROW_KEY];
          if (typeof pendingKey === "string") {
            delete cur[pendingKey];
            continue;
          }
          if (pkCols.length === 0) continue;
          const rowKey = pkCols
            .map((pk) => `${pk.name}=${row[pk.name] == null ? "" : String(row[pk.name])}`)
            .join("&");
          delete cur[rowKey];
          cur[`${DELETED_ROW_KEY_PREFIX}${rowKey}`] = {};
        }
        if (Object.keys(cur).length === 0) {
          const next = { ...prev };
          delete next[tabId];
          return next;
        }
        return { ...prev, [tabId]: cur };
      });
    },
    [],
  );

  const handleRowNew = useCallback(
    (tabId: string) => {
      const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
      if (!colMeta?.length) return;
      const formColumns = colMeta.filter((col) => !shouldUseInlineCellEdit(col.type));
      if (formColumns.length === 0) {
        const rowKey = `${NEW_ROW_KEY_PREFIX}${crypto.randomUUID()}`;
        setTabDirtyRows((prev) => {
          const cur = { ...(prev[tabId] ?? {}) };
          cur[rowKey] = {};
          return { ...prev, [tabId]: cur };
        });
        return;
      }
      const firstEditable = formColumns.find((c) => !c.isPk) ?? formColumns[0];
      setRowEdit({
        tabId,
        column: firstEditable.name,
        row: {},
        isNewRow: true,
      });
    },
    [],
  );

  const resolveConnection = useCallback(
    (connId: string) => connections.find((c) => c.id === connId) ?? null,
    [connections],
  );

  const commitCellDirtyChange = useCallback(
    (
      tabId: string,
      column: string,
      row: Record<string, unknown>,
      value: unknown,
    ) => {
      const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
      if (!colMeta) return;
      const meta = colMeta.find((c) => c.name === column);
      if (!meta) return;

      const pendingKey = row[PENDING_INSERT_ROW_KEY];
      const isPendingInsert = typeof pendingKey === "string";
      const pkCols = colMeta.filter((c) => c.isPk);
      const pkCount = pkCols.length;

      if (meta.isPk) {
        if (!isPendingInsert) return;
        if (isAutoIncrementColumn(meta, pkCount)) return;
      }

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
    [],
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

  const handleCellCommit = useCallback(
    (
      tabId: string,
      cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> },
      value: unknown,
    ) => {
      commitCellDirtyChange(tabId, cellInfo.column, cellInfo.row, value);
    },
    [commitCellDirtyChange],
  );

  const handleRowSave = useCallback(
    (changes: Record<string, unknown>) => {
      if (!rowEdit) return;
      const { tabId, row, isNewRow } = rowEdit;
      const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
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
    [rowEdit],
  );

  const toggleConnectionEnabled = useCallback(
    async (connId: string, enabled: boolean) => {
      const connection = connections.find((c) => c.id === connId);
      if (!connection) return;
      try {
        await saveConnection({ ...connection, enabled });
        useDbConnectionRuntimeStore.getState().syncEnabled(connId, enabled);
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

  const reloadSchemaSidecarAfterConnectionDelete = useCallback(async () => {
    const [filterSnap, expandedSnap, cacheSnap] = await Promise.all([
      loadSchemaFilters(),
      loadSchemaTreeExpanded(),
      loadSchemaCache(),
    ]);
    const loaded = snapshotToFilterStates(filterSnap);
    useDbSchemaFilterStore.setState({
      databaseFilters: loaded.databaseFilters,
      tableFilters: loaded.tableFilters,
      hydrated: true,
    });
    useDbSchemaTreeExpandedStore.setState({
      expandedNodeIds: new Set(expandedSnap.expandedNodeIds ?? []),
      hydrated: true,
    });
    useDbSchemaCacheStore.setState({
      snapshot: cacheSnap,
      hydrated: true,
    });
  }, []);

  const handleDeleteConnection = useCallback(
    async (connection: DbConnectionConfig | DbConnectionConfig[]) => {
      const targets = Array.isArray(connection) ? connection : [connection];
      if (targets.length === 0) return;

      const confirmed = await appConfirm(
        targets.length === 1
          ? t("database.contextMenu.deleteConnectionConfirm", { name: targets[0]!.name })
          : t("sidebarTree.confirmDeleteSelected", { count: String(targets.length) }),
        t("database.contextMenu.deleteConnectionTitle"),
        {
          confirmLabel: t("database.contextMenu.deleteConnection"),
          cancelLabel: t("common.cancel"),
          kind: "warning",
        },
      );
      if (!confirmed) {
        return;
      }

      for (const target of targets) {
        const connId = target.id;
        const tabStore = useDbWorkspaceTabStore.getState();
        const tabIdsToClose = workspaceTabsRef.current
          .filter((tab) => resolveConnIdForWorkspaceTab(tab, tabStore) === connId)
          .map((tab) => tab.id);
        if (tabIdsToClose.length > 0) {
          closeWorkspaceTabs(tabIdsToClose);
        }

        try {
          await deleteConnection(connId);
        } catch (err) {
          console.error("[DatabasePanel] deleteConnection failed", err);
          continue;
        }

        setDatabasesByConnId((prev) => {
          if (!(connId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[connId];
          return next;
        });
        setActiveConnId((prev) => (prev === connId ? null : prev));
        setCreateDbDialog((prev) => (prev?.connId === connId ? null : prev));
        if (editingConnection?.id === connId) {
          setEditingConnection(null);
          setDialogOpen(false);
        }
      }

      await reloadSchemaSidecarAfterConnectionDelete();
      setSchemaRefreshToken((token) => token + 1);
    },
    [
      t,
      closeWorkspaceTabs,
      editingConnection?.id,
      reloadSchemaSidecarAfterConnectionDelete,
    ],
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

  const copyNameForTable = useCallback((selection: SchemaTableSelection) => {
    void writeToClipboard(`\`${selection.dbName}\`.\`${selection.tableName}\``);
  }, []);

  const copyDdlForTable = useCallback((selection: SchemaTableSelection) => {
    fetchTableDdl(selection.connection, selection.dbName, selection.tableName)
      .then((ddl) => writeToClipboard(ddl))
      .catch((err) => console.error("[db.copyDdl] fetchTableDdl failed", err));
  }, []);

  const resolveTabExportData = useCallback(
    async (tabId: string, sessionId?: string) => {
      const { sqlTabStates, tablePreviews } = useDbWorkspaceTabStore.getState();
      const tabState = sqlTabStates[tabId] ?? createDefaultSqlTabState();
      const preview = tablePreviews[tabId];
      const connId = preview?.connId ?? sqlTabStates[tabId]?.connId;
      const baseConn = connId ? connections.find((c) => c.id === connId) : null;
      if (!baseConn || !tabState.database.trim()) {
        return null;
      }

      const sessions = tabState.resultSessions ?? [];
      const targetSession = sessionId
        ? sessions.find((item) => item.id === sessionId)
        : sessions.find((item) => item.id === tabState.activeResultSessionId) ??
          sessions[sessions.length - 1];

      if (targetSession?.result && targetSession.result.columns.length > 0) {
        const rows = rowsToRecord(targetSession.result.columns, targetSession.result.rows);
        const baseName = tabState.database.trim()
          ? `${tabState.database}_query`
          : "query";
        return { columns: targetSession.result.columns, rows, baseName };
      }

      const conn = { ...baseConn, database: tabState.database };
      if (tabState.sql.trim()) {
        try {
          const queryResult = await invoke<QueryResult>("db_execute_query", {
            connection: conn,
            sql: tabState.sql.trim(),
            runId: makeQueryRunId(),
          });
          if (queryResult.columns.length > 0) {
            const rows = rowsToRecord(queryResult.columns, queryResult.rows);
            const baseName =
              preview?.dbName && preview?.tableName
                ? `${preview.dbName}_${preview.tableName}`
                : tabState.database.trim()
                  ? `${tabState.database}_query`
                  : "query";
            return { columns: queryResult.columns, rows, baseName };
          }
        } catch {
          return null;
        }
      }

      return null;
    },
    [connections],
  );

  const exportTabResultToCsv = useCallback(
    async (tabId: string, sessionId?: string) => {
      const payload = await resolveTabExportData(tabId, sessionId);
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
    async (tabId: string, sessionId?: string) => {
      const payload = await resolveTabExportData(tabId, sessionId);
      if (!payload) return;
      const ok = await writeToClipboard(toCsv(payload.columns, payload.rows));
      if (ok) {
        showToast(t("common.copied"));
      }
    },
    [resolveTabExportData, t],
  );

  const [exportMenu, setExportMenu] = useState<
    { x: number; y: number; tabId: string; sessionId?: string } | null
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
          void copyTabResultToClipboard(tabId, exportMenu.sessionId);
        },
      },
      {
        id: "export-file",
        label: t("database.results.exportToFile"),
        icon: fileIcon,
        onClick: () => {
          const tabId = exportMenu?.tabId;
          if (!tabId) return;
          void exportTabResultToCsv(tabId, exportMenu.sessionId);
        },
      },
    ];
  }, [copyTabResultToClipboard, exportTabResultToCsv, exportMenu, t]);

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
        activateWorkspaceTab(existingTabId);
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
      activateWorkspaceTab(tabId);
    },
    [workspaceTabs],
  );

  const openTableQuery = useCallback(
    (selection: SchemaTableSelection) => {
      const { connId, dbName, tableName, connection } = selection;
      const sql = buildSelectAllFromTableSql(connection.db_type, tableName);
      const moduleTabs = workspaceTabsRef.current.filter(isModuleDockTab);
      const tabId = makeSqlTabId();
      const sqlTabCount = moduleTabs.filter((item) => item.kind === "sql").length + 1;
      const tab: SqlWorkspaceTab = {
        id: tabId,
        kind: "sql",
        label: makeSqlTabLabel(sqlTabCount),
      };
      setSqlTabStates((prev) => ({
        ...prev,
        [tabId]: {
          ...createDefaultSqlTabState(dbName, connId),
          sql,
          cursorOffset: sql.length,
        },
      }));
      setWorkspaceTabs((prev) => [...prev, tab]);
      activateWorkspaceTab(tabId);
      setTabModes((prev) => ({ ...prev, [tabId]: "sql" }));
      setActiveConnIdIfChanged(connId);
    },
    [activateWorkspaceTab, setActiveConnIdIfChanged, setSqlTabStates, setTabModes],
  );

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
        label: t("database.slowQueryLog.tabLabel"),
        connId: connection.id,
        sshConnectionId: availability.sshConnectionId,
        logFilePath: availability.logFilePath,
        deploymentKind: availability.deploymentKind,
        containerId: availability.containerId,
      };
      setWorkspaceTabs((prev) => [...prev, tab]);
      activateWorkspaceTab(tabId);
    },
    [activateWorkspaceTab, setActiveConnIdIfChanged, setWorkspaceTabs, t],
  );

  const handleExportDatabase = useCallback(
    async (connection: DbConnectionConfig, databaseName: string) => {
      if (!isConnectionEnabled(connection)) {
        showToast(t("database.export.connectionDisabled"));
        return;
      }
      let deployment = readMysqlDeploymentCache(connection);
      if (!deployment || deployment.kind === "unknown") {
        try {
          deployment = await probeMysqlDeployment(connection, sshConnections);
        } catch {
          deployment = deployment ?? null;
        }
      }
      const exportDeployment = resolveMysqlExportDeployment(deployment);
      const watch = await beginWatchMysqlExportTask(connection.id, (event) => {
        if (event.eventType !== "failed") {
          return;
        }
        const detail =
          event.error?.trim() ||
          event.export?.error?.trim() ||
          "";
        showToast(
          detail
            ? t("database.export.failedDetail", { error: detail })
            : t("database.connectionInfo.exports.statusFailed"),
        );
      });
      try {
        const taskId = await submitDbMysqlExport(connection, databaseName, exportDeployment);
        watch.bindTaskId(taskId);
        showToast(t("database.export.started", { database: databaseName }));
        openConnectionInfoTabRef.current(connection.id, "permanent");
      } catch (error) {
        watch.cancel();
        const message = error instanceof Error ? error.message : String(error);
        showToast(
          message
            ? t("database.export.failedDetail", { error: message })
            : t("database.export.failed"),
        );
      }
    },
    [sshConnections, t],
  );

  const handleOpenImportDatabase = useCallback(
    (connection: DbConnectionConfig, databaseName: string) => {
      if (!isConnectionEnabled(connection)) {
        showToast(t("database.import.connectionDisabled"));
        return;
      }
      setImportDialog({ connection, databaseName });
    },
    [t],
  );

  const handleConfirmImportDatabase = useCallback(
    async (source: MysqlImportSource) => {
      if (!importDialog) {
        return;
      }
      const { connection, databaseName } = importDialog;
      setImportSubmitting(true);
      try {
        let deployment = readMysqlDeploymentCache(connection);
        if (!deployment || deployment.kind === "unknown") {
          try {
            deployment = await probeMysqlDeployment(connection, sshConnections);
          } catch {
            deployment = deployment ?? null;
          }
        }
        const importDeployment = resolveMysqlExportDeployment(deployment);
        const watch = await beginWatchMysqlImportTask((task) => {
          if (task.status === "completed") {
            showToast(t("database.import.completed", { database: databaseName }));
            return;
          }
          if (task.status === "failed") {
            const detail = task.error?.trim() || "";
            showToast(
              detail
                ? t("database.import.failedDetail", { error: detail })
                : t("database.import.failed"),
            );
          }
        });
        try {
          const taskId = await submitDbMysqlImport(
            connection,
            databaseName,
            importDeployment,
            source,
          );
          watch.bindTaskId(taskId);
          showToast(t("database.import.started", { database: databaseName }));
          setImportDialog(null);
        } catch (error) {
          watch.cancel();
          const message = error instanceof Error ? error.message : String(error);
          showToast(
            message
              ? t("database.import.failedDetail", { error: message })
              : t("database.import.failed"),
          );
        }
      } finally {
        setImportSubmitting(false);
      }
    },
    [importDialog, sshConnections, t],
  );

  const buildSchemaContextMenuItems = useCallback(
    (item: SchemaTreeItem, context: SchemaContextMenuContext): ContextMenuItem[] => {
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
      const plusIcon = (
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M8 3v10M3 8h10" />
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
      const deleteIcon = (
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M2 4h12" />
          <path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
          <path d="M6 7v5M10 7v5" />
          <path d="M3 4l.7 9.1a1 1 0 0 0 1 .9h6.6a1 1 0 0 0 1-.9L13 4" />
        </svg>
      );
      const exportIcon = (
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M8 2v8" />
          <path d="M5 7l3 3 3-3" />
          <path d="M3 14h10" />
        </svg>
      );
      const importIcon = (
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M8 10V2" />
          <path d="M5 5l3-3 3 3" />
          <path d="M3 14h10" />
        </svg>
      );
      const slowLogIcon = (
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M3 2.5h10v11H3z" />
          <path d="M5 6h6M5 8.5h4M5 11h5" />
          <path d="M11 2.5V1.5H5v1" />
        </svg>
      );

      if (item.type === "database" && item.dbName && context.connection) {
        const connection = context.connection;
        if (!isMysqlConnectionInfoCapable(connection)) {
          return [];
        }
        const enabled = isConnectionEnabled(connection);
        return [
          {
            id: "export-database",
            label: t("database.contextMenu.exportDatabase"),
            icon: exportIcon,
            disabled: !enabled,
            onClick: () => {
              void handleExportDatabase(connection, item.dbName!);
            },
          },
          {
            id: "import-database",
            label: t("database.contextMenu.importDatabase"),
            icon: importIcon,
            disabled: !enabled,
            onClick: () => {
              handleOpenImportDatabase(connection, item.dbName!);
            },
          },
        ];
      }

      if (item.type === "table" && context.tableSelection) {
        const selection = context.tableSelection;
        const canDesign = supportsTableDesign(selection.connection);
        return [
          {
            id: "design-table",
            label: t("database.contextMenu.designTable"),
            icon: designIcon,
            disabled: !canDesign,
            onClick: () => handleDesignTable(selection),
          },
          {
            id: "copy",
            label: t("database.contextMenu.copy"),
            icon: copyIcon,
            children: [
              {
                id: "copy-name",
                label: t("database.contextMenu.copyName"),
                onClick: () => copyNameForTable(selection),
              },
              {
                id: "copy-ddl",
                label: t("database.contextMenu.copyDdl"),
                onClick: () => copyDdlForTable(selection),
              },
              {
                id: "copy-data",
                label: t("database.contextMenu.copyData"),
                disabled: true,
              },
            ],
          },
        ];
      }

      if (item.type === "connection" && context.connection) {
        const connection = context.connection;
        const connEnabled = isConnectionEnabled(connection);
        const slowLogItems: ContextMenuItem[] = [];
        if (isMysqlConnectionInfoCapable(connection)) {
          const availability =
            slowLogAvailabilityByConnId[connection.id] ??
            resolveSlowLogAvailabilitySync(connection, sshConnections);
          slowLogItems.push({
            id: "slow-query-log",
            label: t("database.contextMenu.slowQueryLog"),
            icon: slowLogIcon,
            disabled: !availability.enabled,
            disabledReason: !availability.enabled
              ? resolveSlowLogDisabledReason(availability)
              : undefined,
            onClick: () => {
              const latest =
                slowLogAvailabilityByConnId[connection.id] ?? availability;
              openSlowQueryLogTab(connection, latest);
            },
          });
        }
        return [
          {
            id: connEnabled ? "disable-connection" : "enable-connection",
            label: connEnabled
              ? t("database.contextMenu.closeConnection")
              : t("database.contextMenu.openConnection"),
            icon: connEnabled ? closeIcon : openIcon,
            onClick: () => {
              void toggleConnectionEnabled(connection.id, !connEnabled);
            },
          },
          ...slowLogItems,
          {
            id: "edit-connection",
            label: t("database.contextMenu.editConnection"),
            icon: editIcon,
            onClick: () => {
              setEditingConnection(connection);
              setDialogOpen(true);
            },
          },
          {
            id: "create-database",
            label: t("database.contextMenu.createDatabase"),
            icon: plusIcon,
            disabled: !connEnabled,
            onClick: () => setCreateDbDialog({ connId: connection.id }),
          },
          { id: "sep-delete-connection", label: "", separator: true },
          {
            id: "delete-connection",
            label: t("database.contextMenu.deleteConnection"),
            icon: deleteIcon,
            danger: true,
            onClick: () => {
              const targets =
                context.selectedConnections && context.selectedConnections.length > 0
                  ? context.selectedConnections
                  : [connection];
              void handleDeleteConnection(targets.length === 1 ? targets[0]! : targets);
            },
          },
        ];
      }

      return [];
    },
    [
      copyDdlForTable,
      copyNameForTable,
      handleDesignTable,
      handleDeleteConnection,
      handleExportDatabase,
      handleOpenImportDatabase,
      openSlowQueryLogTab,
      resolveSlowLogDisabledReason,
      slowLogAvailabilityByConnId,
      sshConnections,
      t,
      toggleConnectionEnabled,
    ],
  );

  const handleSchemaCacheConnectionPatched = useCallback(
    (connId: string, entry: SchemaCacheConnectionEntry) => {
      const names = entry.databases.map((db) => db.name);
      setDatabasesByConnId((prev) => ({ ...prev, [connId]: names }));
      setDatabaseFilters((prev) => ({
        ...prev,
        [connId]: mergeFilter(prev[connId], names),
      }));
    },
    [setDatabaseFilters],
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
      void probeDbConnectionRuntime(selection.connection);

      startTransition(() => {
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
        warmColumnMetaFromCache(tabId);
        setTablePreviews((prev) => ({
          ...prev,
          [tabId]: {
            ...createDefaultTablePreviewState(),
            loading: true,
            connId,
            dbName,
            tableName,
          },
        }));
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
        label: makeTableTabLabel(dbName, tableName),
        connId,
        dbName,
        tableName,
      };

      if (mode === "permanent") {
        if (previewTab && tabMatchesTableSelection(previewTab, connId, dbName, tableName)) {
          promotePreviewTab(previewTab.id);
          activateWorkspaceTab(previewTab.id);
          return;
        }

        const tabId = makeTableTabId();
        setWorkspaceTabs((prev) => [...prev, { ...tabTemplate, id: tabId }]);
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
      activateWorkspaceTab(tabId);
      ensureTablePreview(tabId);
      });
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
        sqlDb: sqlState?.database,
      };
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

  const handleSelectDatabase = useCallback(
    (selection: SchemaDatabaseSelection, mode: SchemaDockOpenMode = "permanent") => {
      setActiveConnIdIfChanged(selection.connId);
      void probeDbConnectionRuntime(selection.connection);
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
            label: `DB ${dbName}`,
            connId,
            dbName,
          }
        : {
            id: "",
            kind: "database",
            label: dbName,
            connId,
            dbName,
          };

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
    [activateExistingDockTab, activateWorkspaceTab, promotePreviewTab, replacePreviewDockTab, setActiveConnIdIfChanged],
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
      activateWorkspaceTab(tabId);
      setTabModes((prev) => ({ ...prev, [tabId]: "sql" }));
      syncSqlFileTabHeaderMeta(tabId, false);
    },
    [workspaceTabs, dirtySqlWorkspaceTabIds, syncSqlFileTabHeaderMeta],
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
        label: formatTreeChartFileLabel(file.name),
        treeChartFileId: file.id,
      };
      setWorkspaceTabs((prev) => [...prev, tab]);
      activateWorkspaceTab(tabId);
    },
    [activateWorkspaceTab, setWorkspaceTabs],
  );

  const openTreeChartTab = useCallback(async () => {
    const name = await quickInput({
      title: t("database.treeChart.newFileTitle"),
      placeholder: t("database.treeChart.fileNamePlaceholder"),
      defaultValue: t("database.treeChart.defaultFileName"),
      validate: (value) => (value.trim() ? null : t("database.treeChart.nameRequired")),
    });
    if (!name) {
      return;
    }
    const store = useDbTreeChartFileStore.getState();
    const file = store.addFile(name.trim());
    await store.flushToDisk();
    openTreeChartFile(file);
  }, [openTreeChartFile, t]);

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

  const activeWorkspaceId = useWorkspaceStore((state) => state.workspace.id);
  const workspaces = useWorkspaceStore((state) => state.workspaces);

  const performMoveTabToWorkspace = useCallback(
    (tabId: string, targetWorkspaceId: string) => {
      if (!targetWorkspaceId) return;
      const ctxTab = workspaceTabs.find((tab) => tab.id === tabId);
      if (!ctxTab || ctxTab.workspaceOnly) return;

      const prevTabs = workspaceTabsRef.current;
      const idx = prevTabs.findIndex((item) => item.id === ctxTab.id);
      const closingActive = activeWorkspaceTabIdRef.current === ctxTab.id;

      setWorkspaceTabs((prev) =>
        prev.map((t) => (t.id === ctxTab.id ? { ...t, workspaceOnly: true } : t)),
      );

      const currentLayout = useDbDockLayoutStore.getState().savedLayout;
      setDockLayout(removeTabFromLayout(currentLayout, ctxTab.id));

      if (closingActive) {
        const nextTabs = prevTabs.filter((item) => item.id !== ctxTab.id && !item.workspaceOnly);
        const fallback = nextTabs[Math.min(idx, Math.max(0, nextTabs.length - 1))];
        activateWorkspaceTab(fallback?.id ?? "");
      }

      const tabStoreState = useDbWorkspaceTabStore.getState();
      void deliverSnapshotToWorkspace(
        targetWorkspaceId,
        dbTabToSnapshot(ctxTab, tabStoreState.tabModes[ctxTab.id]),
      );
      setCtxMenu(null);
    },
    [workspaceTabs, setDockLayout, activateWorkspaceTab],
  );

  const handlePanelTransferredToWorkspace = useCallback(
    (tabId: string, targetScope: string) => {
      if (!targetScope.startsWith("workspace-bottom-")) return;
      const ctxTab = workspaceTabsRef.current.find((tab) => tab.id === tabId);
      if (!ctxTab) return;
      const prevTabs = workspaceTabsRef.current;
      const idx = prevTabs.findIndex((item) => item.id === ctxTab.id);
      const closingActive = activeWorkspaceTabIdRef.current === ctxTab.id;

      setWorkspaceTabs((prev) =>
        prev.map((t) => (t.id === ctxTab.id ? { ...t, workspaceOnly: true } : t)),
      );

      const currentLayout = useDbDockLayoutStore.getState().savedLayout;
      setDockLayout(removeTabFromLayout(currentLayout, ctxTab.id));

      if (closingActive) {
        const nextTabs = prevTabs.filter((item) => item.id !== ctxTab.id && !item.workspaceOnly);
        const fallback = nextTabs[Math.min(idx, Math.max(0, nextTabs.length - 1))];
        activateWorkspaceTab(fallback?.id ?? "");
      }
    },
    [activateWorkspaceTab, setDockLayout],
  );

  // 监听跨 dockview 实例拖拽转移：从工作区 dock 拖回数据库主面板时恢复 tab
  useEffect(() => {
    return subscribeDockviewTransfer((meta) => {
      if (!meta.newPanelId.startsWith("database:")) return;
      if (!meta.originScope.startsWith("workspace-bottom-")) return;

      // 从 originPanelId 中解析出原始数据库 tab id
      // workspace dock 中 panel id 格式: "workspace-bottom-{wsId}:{原始tabId}"
      const prefix = `${meta.originScope}:`;
      const originalTabId = meta.originPanelId.startsWith(prefix)
        ? meta.originPanelId.slice(prefix.length)
        : meta.originPanelId;

      const ctxTab = workspaceTabsRef.current.find((tab) => tab.id === originalTabId);
      if (!ctxTab) return;

      // 恢复 workspaceOnly = false，让 tab 重新在主面板可见
      if (ctxTab.workspaceOnly) {
        setWorkspaceTabs((prev) =>
          prev.map((t) => (t.id === originalTabId ? { ...t, workspaceOnly: false } : t)),
        );
      }
      activateWorkspaceTab(originalTabId);
      requestAnimationFrame(() => relayoutDockviewInstances("database"));
    });
  }, [activateWorkspaceTab, setWorkspaceTabs]);

  const handleContextAction = useCallback(
    (action: TabContextMenuAction) => {
      if (!ctxMenu) return;
      const { tabId } = ctxMenu;
      const visibleTabs = workspaceTabs.filter((tab) => !tab.workspaceOnly);
      const idx = visibleTabs.findIndex((tab) => tab.id === tabId);

      if (action === "rename") {
        setCtxMenu(null);
        void handleRenameTab(tabId);
        return;
      }

      if (action === "close") {
        closeWorkspaceTab(tabId);
      } else if (action === "closeLeft") {
        if (idx > 0) {
          closeWorkspaceTabs(visibleTabs.slice(0, idx).map((tab) => tab.id));
        }
      } else if (action === "closeRight") {
        if (idx >= 0 && idx < visibleTabs.length - 1) {
          closeWorkspaceTabs(visibleTabs.slice(idx + 1).map((tab) => tab.id));
        }
      } else if (action === "closeOthers") {
        if (idx >= 0) {
          closeWorkspaceTabs(visibleTabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id));
        }
      } else if (action === "closeAll") {
        closeWorkspaceTabs(visibleTabs.map((tab) => tab.id));
      }
      setCtxMenu(null);
    },
    [ctxMenu, workspaceTabs, closeWorkspaceTab, closeWorkspaceTabs, handleRenameTab, setDockLayout],
  );


  useEffect(() => {
    const handleCloseEvent = (e: Event) => {
      const customEvent = e as CustomEvent<string>;
      closeWorkspaceTab(customEvent.detail);
    };
    window.addEventListener("omnipanel:close-db-workspace-tab", handleCloseEvent);
    return () => {
      window.removeEventListener("omnipanel:close-db-workspace-tab", handleCloseEvent);
    };
  }, [closeWorkspaceTab]);

  useEffect(() => {
    const handleRestoreEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ snapshot: DbTabSnapshot }>).detail;
      const snapshot = detail?.snapshot;
      if (!snapshot || snapshot.module !== "database") return;

      const recentEntry = useDbWorkspaceSessionStore
        .getState()
        .recentClosedPanels.find((item) => item.tab.id === snapshot.id);
      if (recentEntry) {
        reopenRecentClosedPanel(recentEntry);
        return;
      }

      const tab = { ...snapshot.tab, workspaceOnly: true } as DbWorkspaceTab;
      if (workspaceTabsRef.current.some((item) => item.id === tab.id)) {
        activateWorkspaceTab(tab.id);
        return;
      }

      setWorkspaceTabs((prev) => [...prev, tab]);
      activateWorkspaceTab(tab.id);
      if (snapshot.tabMode) {
        setTabModes((prev) => ({ ...prev, [tab.id]: snapshot.tabMode! }));
      }
    };
    window.addEventListener("omnipanel:restore-db-workspace-tab", handleRestoreEvent);
    return () => {
      window.removeEventListener("omnipanel:restore-db-workspace-tab", handleRestoreEvent);
    };
  }, [reopenRecentClosedPanel, activateWorkspaceTab, setTabModes]);

  // @ts-ignore
  const openRedisQueryTab = useCallback(
    (connId: string, dbName: string | undefined, label: string, mode: SchemaDockOpenMode = "permanent") => {
      const moduleTabs = workspaceTabsRef.current.filter(isModuleDockTab);
      const existingTabId = findTabIdForRedisQuery(moduleTabs, connId, dbName);
      if (existingTabId) {
        activateExistingDockTab(existingTabId, mode);
        return;
      }

      const previewTab = findPreviewDockTab(moduleTabs);
      const tabTemplate: RedisQueryWorkspaceTab = {
        id: "",
        kind: "redis-query",
        label,
        connId,
        dbName,
      };
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
    [activateExistingDockTab, activateWorkspaceTab, promotePreviewTab, replacePreviewDockTab],
  );

  const handleSelectConnection = useCallback(
    (connId: string, mode: SchemaDockOpenMode = "permanent") => {
      // 联动定位必须同步更新，不能包在 startTransition 里（否则侧栏会等低优先级任务）
      setActiveConnIdIfChanged(connId);
      const conn = connections.find((item) => item.id === connId);
      if (!conn) return;

      updateSchemaExpanded((prev) => {
        const next = new Set(prev);
        next.add(connectionNodeId(connId));
        return next;
      });

      if (isConnectionEnabled(conn)) {
        void probeDbConnectionRuntime(conn);
        // 无 Schema 缓存时后台异步浅刷库名，不堵 UI
        const entry = useDbSchemaCacheStore.getState().snapshot.connections?.[connId];
        const refreshing = Boolean(
          useDbSchemaCacheStore.getState().refreshingConnectionIds[connId],
        );
        if (!isSchemaCacheEntryOk(entry) && !refreshing) {
          void submitSchemaCacheRefresh([connId], schemaCacheReporter).catch((err) => {
            schemaCacheReporter.onError?.(String(err));
          });
        }
      } else {
        useDbConnectionRuntimeStore.getState().syncEnabled(connId, false);
      }

      const normalized = normalizeConnectionGroup(conn.group);
      const group = groups.find((item) => item.name === normalized);
      if (group) {
        setActiveGroupId(group.id);
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
          label: conn.name,
          connId,
        };
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
        label: conn.name,
        connId,
      };
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
      groups,
      setActiveGroupId,
      activateExistingDockTab,
      activateWorkspaceTab,
      promotePreviewTab,
      replacePreviewDockTab,
      setActiveConnIdIfChanged,
      setWorkspaceTabs,
      updateSchemaExpanded,
      schemaCacheReporter,
    ],
  );
  openConnectionInfoTabRef.current = handleSelectConnection;

  const runQuery = useCallback(async (
    sqlOverride?: string,
    tabIdOverride?: string,
    options?: { resultPage?: number; sessionId?: string },
  ) => {
    const tabStore = useDbWorkspaceTabStore.getState();
    const pageSize = useSettingsStore.getState().databaseQueryPageSize;

    const tabId = tabIdOverride ?? activeWorkspaceTab?.id;
    const tab = tabId ? workspaceTabsRef.current.find((item) => item.id === tabId) : null;
    if (!tab || tab.kind !== "sql") {
      return;
    }
    const resolvedTabId = tab.id;
    const tabState = tabStore.sqlTabStates[resolvedTabId] ?? createDefaultSqlTabState();
    const sessions = tabState.resultSessions ?? [];

    if (options?.sessionId) {
      const session = sessions.find((item) => item.id === options.sessionId);
      if (!session) return;
      const sql = session.sql.trim();
      if (!sql) return;
      const conn = connectionForSqlTab(resolvedTabId, sql);
      if (!conn) {
        updateSqlResultSession(resolvedTabId, session.id, {
          error: resolveSqlTabConnection(resolvedTabId)
            ? t("database.workspace.selectDatabase")
            : t("database.results.noConnection"),
        });
        return;
      }

      const resultPage = Math.max(0, options.resultPage ?? 0);
      updateSqlResultSession(resolvedTabId, session.id, { running: true, error: null });
      const started = performance.now();
      const runId = makeQueryRunId();
      try {
        const res = await invoke<QueryResult>("db_execute_query", {
          connection: conn,
          sql,
          runId,
          limit: pageSize,
          offset: resultPage * pageSize,
        });
        const hasMore = res.columns.length > 0 && res.rows.length >= pageSize;
        updateSqlResultSession(resolvedTabId, session.id, {
          result: res,
          resultPage,
          resultHasMore: hasMore,
          elapsed: Math.round(performance.now() - started),
          running: false,
        });
      } catch (e) {
        updateSqlResultSession(resolvedTabId, session.id, {
          result: null,
          error: isQueryCancelledError(e)
            ? t("database.queryCancelled")
            : typeof e === "string"
              ? e
              : JSON.stringify(e),
          running: false,
        });
      }
      return;
    }

    const sql = (sqlOverride ?? tabState.sql).trim();

    if (!sql) {
      updateSqlTabState(resolvedTabId, { error: t("database.results.emptySql") });
      return;
    }

    const conn = connectionForSqlTab(resolvedTabId, sql);
    if (!conn) {
      updateSqlTabState(resolvedTabId, {
        error: resolveSqlTabConnection(resolvedTabId)
          ? t("database.workspace.selectDatabase")
          : t("database.results.noConnection"),
      });
      return;
    }

    const runId = makeQueryRunId();
    const tempSession = findTemporarySqlResultSession(sessions);
    if (tempSession && tabState.activeQueryRunId) {
      try {
        await invoke("db_cancel_query", { runId: tabState.activeQueryRunId });
      } catch {
        // 查询可能已结束
      }
    }

    const session = tempSession
      ? reuseTemporarySqlResultSession(tempSession, sql)
      : createSqlResultSession(sql);
    const nextSessions = tempSession
      ? sessions.map((item) => (item.id === tempSession.id ? session : item))
      : [...sessions, session];

    updateSqlTabState(resolvedTabId, {
      running: true,
      activeQueryRunId: runId,
      error: null,
      resultSessions: nextSessions,
      activeResultSessionId: session.id,
    });

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
        runId,
        limit: pageSize,
        offset: 0,
      });
      const hasMore = res.columns.length > 0 && res.rows.length >= pageSize;
      updateSqlResultSession(resolvedTabId, session.id, {
        result: res,
        resultPage: 0,
        resultHasMore: hasMore,
        elapsed: Math.round(performance.now() - started),
        running: false,
      });
      updateSqlTabState(resolvedTabId, { running: false, activeQueryRunId: null });
    } catch (e) {
      updateSqlResultSession(resolvedTabId, session.id, {
        result: null,
        error: isQueryCancelledError(e)
          ? t("database.queryCancelled")
          : typeof e === "string"
            ? e
            : JSON.stringify(e),
        running: false,
      });
      updateSqlTabState(resolvedTabId, { running: false, activeQueryRunId: null });
    }
  }, [
    connectionForSqlTab,
    resolveSqlTabConnection,
    activeWorkspaceTab,
    enqueueAction,
    t,
    updateSqlTabState,
    updateSqlResultSession,
  ]);

  const cancelQuery = useCallback(async (tabIdOverride?: string) => {
    const tabId = tabIdOverride ?? activeWorkspaceTab?.id;
    if (!tabId) return;

    const tabState = useDbWorkspaceTabStore.getState().sqlTabStates[tabId];
    const runId = tabState?.activeQueryRunId;
    if (!runId) return;

    try {
      await invoke("db_cancel_query", { runId });
    } catch {
      // 查询可能已结束
    }

    const activeSessionId = tabState.activeResultSessionId;
    if (activeSessionId) {
      updateSqlResultSession(tabId, activeSessionId, {
        running: false,
        error: t("database.queryCancelled"),
      });
    }
    updateSqlTabState(tabId, { running: false, activeQueryRunId: null });
  }, [activeWorkspaceTab, t, updateSqlResultSession, updateSqlTabState]);

  const goToQueryResultPage = useCallback(
    async (tabId: string, page: number, sessionId?: string) => {
      if (page < 0) return;
      const tabState = useDbWorkspaceTabStore.getState().sqlTabStates[tabId];
      const resolvedSessionId =
        sessionId ?? tabState?.activeResultSessionId ?? undefined;
      if (!resolvedSessionId) return;
      await runQuery(undefined, tabId, { sessionId: resolvedSessionId, resultPage: page });
    },
    [runQuery],
  );

  // 表预览（data）模式：编辑器常折叠且无焦点，在此统一处理 Ctrl+Enter 快捷键
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter" || e.shiftKey || e.altKey) {
        return;
      }
      if (isSqlEditorFocused()) return;

      const tabId = activeWorkspaceTabId;
      if (!tabId) return;
      const tabState = useDbWorkspaceTabStore.getState().sqlTabStates[tabId];
      if (!tabState) return;

      const statement = sqlAtOffset(tabState.sql, tabState.cursorOffset);
      if (!statement) return;

      e.preventDefault();
      e.stopPropagation();
      void runQuery(statement, tabId);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeWorkspaceTabId, runQuery]);

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

      const state = useDbWorkspaceTabStore.getState().sqlTabStates[tabId] ?? createDefaultSqlTabState();
      const store = useDbSqlFileStore.getState();
      const connection = resolveConnection(state.connId);
      const rawSql = state.sql;
      const sqlToSave =
        useSettingsStore.getState().formatSqlOnSave
          ? formatSql(rawSql, connection?.db_type ?? null)
          : rawSql;
      if (sqlToSave !== state.sql) {
        updateSqlTabState(tabId, { sql: sqlToSave });
      }

      if (tab.sqlFileId) {
        store.updateFileSql(tab.sqlFileId, sqlToSave);
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

      const file = store.addFile(null, name.trim(), sqlToSave);
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
    [activeWorkspaceTabId, t, syncSqlFileTabHeaderMeta, resolveConnection, updateSqlTabState],
  );

  useEffect(() => {
    if (!isActiveRoute) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s" || e.shiftKey || e.altKey) {
        return;
      }
      if (isSqlEditorFocused()) return;
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

  const workspaceStateValue: DbWorkspaceSharedContextValue = useMemo(
    () => ({
        tabs: workspaceTabs,
        closeTab: (tabId: string) => requestTabAction({ kind: "close", tabId }),
        runQuery,
        cancelQuery,
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
        openExportMenu: (x: number, y: number, tabId: string, sessionId?: string) =>
          setExportMenu({ x, y, tabId, sessionId }),
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
    }),
    [
    workspaceTabs,
    requestTabAction,
    runQuery,
    cancelQuery,
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
    saveSqlTab,
    isSqlTabDirty,
  ]);

  const activeTabContextValue = useMemo(
    () => ({
      activeTabId: activeWorkspaceTabId,
      setActiveTabId: activateWorkspaceTab,
    }),
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
          activeTableKey: activeTableKeyRef.current,
        };
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
              preview,
            };
          }
          if (tab.kind === "connection") {
            return {
              id: tab.id,
              label: tab.label,
              panelType: "database-connection",
              icon: "database" as const,
              tooltip: t("database.connectionInfo.subtitle"),
              closable: true,
              preview,
            };
          }
          if (tab.kind === "redis-query") {
            return {
              id: tab.id,
              label: tab.label,
              panelType: "database-redis",
              icon: "database" as const,
              tooltip: t("database.redisQuery.search"),
              closable: true,
              preview,
            };
          }
          if (tab.kind === "slow-query") {
            return {
              id: tab.id,
              label: tab.label,
              panelType: "database-slow-query",
              icon: "database" as const,
              tooltip: t("database.slowQueryLog.tabTooltip", { name: tab.label }),
              closable: true,
              preview,
            };
          }
          if (tab.kind === "toolbox") {
            return {
              id: tab.id,
              label: tab.label,
              panelType: tab.toolboxTab === "dataSync" ? "database-data-sync" : "database-toolbox",
              icon: tab.toolboxTab === "dataSync" ? ("table" as const) : ("database" as const),
              tooltip: tab.label,
              closable: true,
              preview,
            };
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
              preview,
            };
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
              preview,
            };
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
            preview,
          };
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
                    onDesignTable={handleDesignTable}
                    onOpenTableData={(tableSelection) =>
                      handleSelectTable(tableSelection, "permanent")
                    }
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
                {isRedisConnection(connection) ? (
                  <RedisConnectionInfoPanel
                    connection={connection}
                    active={tab.id === activeWorkspaceTabId}
                  />
                ) : (
                  <DatabaseConnectionInfoPanel
                    connection={connection}
                    active={tab.id === activeWorkspaceTabId}
                  />
                )}
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
                <DatabaseSlowQueryLogPanel
                  connection={connection}
                  sshConnectionId={tab.sshConnectionId}
                  logFilePath={tab.logFilePath}
                  deploymentKind={tab.deploymentKind}
                  containerId={tab.containerId}
                  active={tab.id === activeWorkspaceTabId}
                />
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
            <DatabaseToolbox
              active={tab.id === activeWorkspaceTabId}
              syncTaskId={tab.syncTaskId}
              tab={tab.toolboxTab}
              connections={toolboxConnections}
              initialSourceConnectionId={
                toolboxSeed.connId ??
                (activeConn && isToolboxCapableConnection(activeConn) ? activeConn.id : null)
              }
              initialSourceDatabase={toolboxSeed.database}
            />
          </div>
        );
      }

      return null;
    },
    [
      workspaceTabs,
      activeWorkspaceTabId,
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

  const handleDockTabContextMenu = useCallback(
    (event: ReactMouseEvent, tabId: string, index: number) => {
      setCtxMenu({ x: event.clientX, y: event.clientY, tabId, index });
    },
    [],
  );



  useEffect(() => {
    if (isActiveRoute) return;
    setCtxMenu(null);


    setExportMenu(null);
  }, [isActiveRoute]);

  // 勿绑 activeTabId / 整份 tabs；切 Tab 由 DockableWorkspace 局部 soft bump
  const moduleSoftRefreshKey = useMemo(
    () =>
      [
        moduleLive ? "1" : "0",
        connectionsLoading ? "1" : "0",
        connections.map((c) => c.id).join(","),
      ].join("|"),
    [moduleLive, connections, connectionsLoading],
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

  const handleCloseDockTab = useCallback(
    (tabId: string) => requestTabAction({ kind: "close", tabId }),
    [requestTabAction],
  );

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

  const sidebarLinkageValue = useMemo(
    () => ({
      activeConnId: sidebarLinkageConnId,
      activeDatabaseKey,
      activeTableKey,
    }),
    [sidebarLinkageConnId, activeDatabaseKey, activeTableKey],
  );

  const panelContentKeysByTab = useMemo(() => {
    const tabState = useDbWorkspaceTabStore.getState();
    return buildDatabasePanelContentKeysByTab({
      workspaceTabs,
      sqlTabStates: tabState.sqlTabStates,
      tablePreviews: tabState.tablePreviews,
      tableDesignerStates,
      connections,
    });
  }, [workspaceTabs, tableDesignerStates, connections, sqlTabPanelKeySeed, tablePreviewTabIdKey]);

  const schemaContextValue = useMemo(
    () => ({
      groupConnections,
      databasesByConnId,
      schemaByKey,
      schemaLoadingKey,
    }),
    [groupConnections, databasesByConnId, schemaByKey, schemaLoadingKey],
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
  return (
    <>
    <DatabaseModuleContextBridge active={moduleLive} context={databaseModuleContext} />
    <DbSidebarLinkageProvider value={sidebarLinkageValue}>
    <DbWorkspaceProviders state={workspaceStateValue} activeTab={activeTabContextValue}>
    <DbSchemaProvider value={schemaContextValue}>
    <ModuleWorkspaceLayout
      className="db-module-layout"
      leftColumnTitle={t("routes.database")}
      leftPreset="schema"
      leftIconRail={
        <IconDropdownButton
          title={t("database.dataDictionary.title")}
          ariaLabel={t("database.dataDictionary.title")}
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
              <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
              <line x1="3" y1="9" x2="21" y2="9" />
              <line x1="9" y1="3" x2="9" y2="9" />
            </svg>
          }
          items={[
            {
              id: "new",
              label: t("database.dataDictionary.new"),
              onSelect: () => handleOpenDictDialog(null),
            },
            ...dictionaries.map((entry) => ({
              id: entry.id,
              label: entry.name,
              onSelect: () => handleOpenDictDialog(entry),
            })),
          ]}
        />
      }
      leftSidebar={
          <DatabaseSchemaSidebar
            onCreateConnection={handleCreateConnection}
            onImportNavicat={handleImportNavicat}
            onSelectConnection={handleSelectConnection}
            onOpenSqlFile={openSqlFile}
            onNewTreeChart={handleNewTreeChart}
            onOpenTreeChartFile={openTreeChartFile}
            activeTreeChartFileId={activeTreeChartFileId}
            onOpenSyncTask={handleOpenSyncTask}
            onRunSyncTask={handleRunSyncTask}
            onSelectTable={handleSelectTable}
            onSelectDatabase={handleSelectDatabase}
            buildSchemaContextMenuItems={buildSchemaContextMenuItems}
            onSchemaCacheConnectionPatched={handleSchemaCacheConnectionPatched}
            refreshToken={schemaRefreshToken}
            connectionConfigs={connections}
            connectionsReady={!connectionsLoading || connections.length > 0}
          />
      }
    >
      <div className="db-workspace-drop-zone">
        {!workspaceInitialized ? null : (
          <DatabaseWorkspaceDock
            workspaceInitialized={workspaceInitialized}
            dockTabs={dockTabs}
            moduleTitle={t("routes.database")}
            enabled={moduleLive}
            windowControl
            onCloseTab={handleCloseDockTab}
            dockLayout={dockLayout}
            onDockLayoutChange={setDockLayout}
            renderDockPanel={renderDockPanel}
            softRefreshKey={moduleSoftRefreshKey}
            panelContentKeysByTab={panelContentKeysByTab}
            onTabContextMenu={handleDockTabContextMenu}
            onTabDoubleClick={handleDockTabDoubleClick}
            onPanelTransferredOut={handlePanelTransferredToWorkspace}
            recentClosedActionItems={recentClosedActionItems}
            emptyPrompt={t("database.workspace.emptyTabs")}
            recentClosedTitle={t("database.workspace.recentClosed")}
          />
        )}
      </div>
    </ModuleWorkspaceLayout>
    </DbSchemaProvider>
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
    <MysqlImportDialog
      open={importDialog !== null}
      connection={importDialog?.connection ?? null}
      databaseName={importDialog?.databaseName ?? ""}
      submitting={importSubmitting}
      onClose={() => {
        if (!importSubmitting) {
          setImportDialog(null);
        }
      }}
      onConfirm={(source) => {
        void handleConfirmImportDatabase(source);
      }}
    />
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
      initialConnection={editingConnection}
    />
    <ConnectionImportPreviewDialog
      open={importPreview !== null}
      fileName={importPreview?.fileName ?? ""}
      items={importPreview?.items ?? []}
      existingConnections={connections}
      onClose={() => setImportPreview(null)}
      onImported={() => {
        setSchemaRefreshToken((token) => token + 1);
        void refreshConnections();
      }}
    />
    <DataDictionaryDialog
      open={dictDialogOpen}
      entry={editingDictEntry}
      onCancel={() => {
        setDictDialogOpen(false);
        setEditingDictEntry(null);
      }}
      onSubmit={handleDictSubmit}
    />
    </DbWorkspaceProviders>
    </DbSidebarLinkageProvider>
    <DatabaseTableEditorHost
      rowEdit={rowEdit}
      tableColumnMeta={editorTableColumnMeta ? { [editorHostTabId!]: editorTableColumnMeta } : {}}
      tabDirtyRows={editorHostTabId ? { [editorHostTabId]: editorTabDirtyRows } : {}}
      onRowSave={handleRowSave}
      onRowCancel={() => setRowEdit(null)}
    />
    {isActiveRoute && ctxMenu && (() => {
        const visibleDockTabs = workspaceTabs.filter((tab) => !tab.workspaceOnly);
        const menuTabIndex = visibleDockTabs.findIndex((tab) => tab.id === ctxMenu.tabId);
        const closeItems = buildTabCloseMenuItems(
          t,
          visibleDockTabs.length,
          menuTabIndex >= 0 ? menuTabIndex : 0,
          handleContextAction,
          {
            showWorkspaceActions: true,
            showRename: true,
            currentWorkspaceId: activeWorkspaceId,
            workspaces,
            onMoveToWorkspace: (workspaceId) =>
              performMoveTabToWorkspace(ctxMenu.tabId, workspaceId),
          },
        );
      return (
        <ContextMenu
          items={closeItems}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
        />
      );
    })()}
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


