import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { flushSync } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { ModuleModeIconRail, ModuleWorkspaceLayout } from "../../components/workspace";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import type { SchemaDatabaseSelection, SchemaTableSelection, SchemaContextMenuContext } from "./SchemaBrowser";
import type { SchemaTreeItem } from "./schemaTreeItem";
import type { ContextMenuItem } from "../../components/ui/ContextMenu";
import { DatabaseSchemaSidebar } from "./DatabaseSchemaSidebar";
import {
  DatabaseModuleContextBridge,
  resolveDatabaseModuleContext,
} from "./ai";
import { DatabaseTablesPanel } from "./DatabaseTablesPanel";
import { DatabaseConnectionInfoPanel } from "./DatabaseConnectionInfoPanel";
import { RedisQueryPanel } from "./RedisQueryPanel";
import { ConnectionResolvedDockPane } from "./ConnectionResolvedDockPane";
import { DbSchemaProvider } from "./DbSchemaContext";
import { ConnectionDialog } from "./ConnectionDialog";
import { ContextMenu } from "../../components/ui/ContextMenu";
import { FormDialog, FormField } from "../../components/ui/FormDialog";
import { Select } from "../../components/ui/Select";
import { buildTabCloseMenuItems, type TabContextMenuAction } from "../../components/ui/contextMenuItems";
import { useActionStore } from "../../stores/actionStore";
import { useSettingsStore } from "../../stores/settingsStore";
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
import { makeQueryRunId, isQueryCancelledError } from "./queryRun";
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
  isRedisConnection,
  isToolboxCapableConnection,
  type DbConnectionConfig,
} from "./api";
import { buildDatabaseSchema, introspectToTableSchemas } from "./lsp/sqlCompletion";
import { formatSql } from "./sqlIntel/sqlFormat";
import { toCsv } from "./csvExport";
import { buildRedisColumnMeta, buildRedisUpdateCommands } from "./redisTableMeta";
import { getCachedDatabaseNames, getCachedTableColumns } from "./schemaCacheMerge";
import type { SchemaCacheConnectionEntry } from "./schemaCache";
import { refreshConnectionSchemaCache } from "./schemaCacheRefresh";
import { createSchemaCacheRefreshReporter } from "./schemaCacheStatusLog";
import { parseDatabaseNodeId, parseTableNodeId } from "./schemaTreeIds";
import type { DatabaseSchema } from "./types";
import {
  makeSqlTabId,
  makeTableTabId,
  makeDatabaseTabId,
  makeDatabaseTabKey,
  findTabIdForDatabase,
  findTabIdForConnection,
  findTabIdForSqlFile,
  makeTableTabLabel,
  makeTableTabKey,
  findTabIdForTable,
  findTabIdForDesigner,
  findTabIdForRedisQuery,
  findPreviewDockTab,
  makeDesignerTabId,
  makeConnectionInfoTabId,
  makeRedisQueryTabId,
  isModuleDockTab,
  isToolboxTab,
  makeToolboxWorkspaceTab,
  findTabIdForToolbox,
  makeTableDesignerTabLabel,
  type SchemaDockOpenMode,
  type ConnectionInfoWorkspaceTab,
  type DbWorkspaceTab,
  type RedisQueryWorkspaceTab,
  type SqlWorkspaceTab,
  type TableDesignerWorkspaceTab,
  type TablePreviewWorkspaceTab,
} from "./workspaceTabs";
import { TableDesignerDockPane } from "./tableDesigner/TableDesignerDockPane";
import { supportsTableDesign, resolveTableDesignerDriver } from "./tableDesigner/resolveTableDesignerDriver";
import { DatabaseTableEditorHost } from "./DatabaseTableEditorHost";
import { DatabaseToolbox } from "./toolbox/DatabaseToolbox";
import type { SyncTask, ToolboxTabId } from "./toolbox/types";
import { useDbSyncTaskStore } from "../../stores/dbSyncTaskStore";
import {
  createDefaultSqlTabState,
  createDefaultTablePreviewState,
  createSqlResultSession,
  type SqlResultSession,
  estimateTablePreviewTotalRows,
  buildOrderByClause,
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
  resolveConnIdForWorkspaceTab,
} from "./dbWorkspaceState";
import { DatabaseWorkspaceDock } from "./DatabaseWorkspaceDock";
import {
  buildDatabasePanelContentKeysByTab,
  buildSqlTabPanelKeySeed,
  selectTablePreviewTabIdKey,
} from "./databasePanelTabKeys";
import { DbPanelSurface } from "./DbPanelSurface";
import { DbTablePreviewSurface } from "./DbTablePreviewSurface";
import { DbSidebarLinkageProvider } from "./DbSidebarLinkageContext";
import { formatFilterWhere } from "./tablePreviewFilter";
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
} from "./dbWorkspaceSession";
import { useWorkspaceBottomDockStore } from "../../stores/workspaceBottomDockStore";
import { publishDbWorkspaceMirror } from "../../stores/dbWorkspaceMirrorStore";
import {
  EMPTY_TAB_DIRTY_ROWS,
  selectDbTabWorkspaceMirrorSlice,
  useDbWorkspaceTabStore,
} from "../../stores/dbWorkspaceTabStore";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { dbTabToSnapshot, addSnapshotToWorkspace } from "../../lib/workspaceTabActions";
import type { DbTabSnapshot } from "../../stores/workspaceTabStore";
import { connectionNodeId } from "./schemaTreeExpanded";

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
  isRedis: boolean,
): boolean {
  if (isRedis) {
    return tab.kind === "redis-query" && tab.connId === connId && !tab.dbName;
  }
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


/** 把行主键拼成的字符串??col=val&col=val"）解析回单列值，rowKey 中空字符串表??NULL??*/
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
  const [editingConnection, setEditingConnection] = useState<DbConnectionConfig | null>(null);
  const [schemaRefreshToken, setSchemaRefreshToken] = useState(0);

  const [connections, setConnections] = useState<DbConnectionConfig[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [activeConnId, setActiveConnId] = useState<string | null>(null);

  const setActiveConnIdIfChanged = useCallback((connId: string | null) => {
    setActiveConnId((prev) => (prev === connId ? prev : connId));
  }, []);

  const setSqlTabStates = useDbWorkspaceTabStore((state) => state.setSqlTabStates);
  const setTablePreviews = useDbWorkspaceTabStore((state) => state.setTablePreviews);
  const setTableColumnMeta = useDbWorkspaceTabStore((state) => state.setTableColumnMeta);
  const tabModes = useDbWorkspaceTabStore((state) => state.tabModes);
  const setTabModes = useDbWorkspaceTabStore((state) => state.setTabModes);
  const setTabDirtyRows = useDbWorkspaceTabStore((state) => state.setTabDirtyRows);
  const setCommittingTabs = useDbWorkspaceTabStore((state) => state.setCommittingTabs);
  const removeTabWorkspaceData = useDbWorkspaceTabStore((state) => state.removeTabWorkspaceData);

  const workspaceTabsRef = useRef<DbWorkspaceTab[]>([]);
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
  /** SQL 工作??Tab 未保存标记（??tabId；与 store.dirtyFileIds 解耦，保证 Tab 头即时更新） */
  const [dirtySqlWorkspaceTabIds, setDirtySqlWorkspaceTabIds] = useState<Set<string>>(
    () => new Set(),
  );
  const tablePreviewRestoreDoneRef = useRef(false);
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
  /** 每个 tab 的「未提交修改」：行键 -> {列名: 新值}。提交或回滚后清空对??tab??*/
  const [pendingTabAction, setPendingTabAction] = useState<
    | {
        kind: "refresh" | "page" | "close" | "sort" | "filter";
        tabId: string;
        page?: number;
        sort?: SortState | null;
        filter?: RuleGroupType | null;
      }
    | null
  >(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabId: string; index: number } | null>(null);
  const updateSchemaExpanded = useDbSchemaTreeExpandedStore((s) => s.updateExpanded);
  const [createDbDialog, setCreateDbDialog] = useState<
    | {
        connId: string;
      }
    | null
  >(null);
  const dockLayout = useDbDockLayoutStore((s) => s.savedLayout);
  const setDockLayout = useDbDockLayoutStore((s) => s.setSavedLayout);

  const referencedDatabaseTabIds = useWorkspaceBottomDockStore(
    useShallow((s) => {
      const ids = new Set<string>();
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
  // Refs for workspace switch (access current state from event listener)
  workspaceTabsRef.current = workspaceTabs;
  const activeWorkspaceTabIdRef = useRef(activeWorkspaceTabId);
  activeWorkspaceTabIdRef.current = activeWorkspaceTabId;
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
      setActiveWorkspaceTabId(tabId);
      syncConnForTabId(tabId);
    },
    [syncConnForTabId],
  );

  const openOrActivateToolboxTab = useCallback(
    (toolboxTab: ToolboxTabId) => {
      const tabId = findTabIdForToolbox(workspaceTabsRef.current, toolboxTab);
      const label = t(`database.tabs.${toolboxTab}`);
      if (tabId) {
        activateWorkspaceTab(tabId);
        return;
      }
      const tab = makeToolboxWorkspaceTab(toolboxTab, label);
      setWorkspaceTabs((prev) => [...prev, tab]);
      activateWorkspaceTab(tab.id);
    },
    [activateWorkspaceTab, setWorkspaceTabs, t],
  );

  const handleOpenSyncTask = useCallback(
    (task: SyncTask) => {
      openOrActivateToolboxTab(task.kind);
      useDbSyncTaskStore.getState().requestLoad(task.id, false);
    },
    [openOrActivateToolboxTab],
  );

  const handleRunSyncTask = useCallback(
    (task: SyncTask) => {
      openOrActivateToolboxTab(task.kind);
      useDbSyncTaskStore.getState().requestLoad(task.id, true);
    },
    [openOrActivateToolboxTab],
  );

  const handleModuleModeChange = useCallback(
    (id: string) => {
      const mode = id as DbModuleTab;
      setModuleTab(mode);
      if (mode === "dataSync" || mode === "schemaSync") {
        openOrActivateToolboxTab(mode);
        return;
      }
      const moduleTabs = workspaceTabsRef.current.filter(isModuleDockTab);
      const nonToolboxTabs = moduleTabs.filter((tab) => tab.kind !== "toolbox");
      const target =
        nonToolboxTabs.find((tab) => tab.id === activeWorkspaceTabIdRef.current) ??
        nonToolboxTabs[nonToolboxTabs.length - 1];
      if (target) {
        activateWorkspaceTab(target.id);
      }
    },
    [activateWorkspaceTab, openOrActivateToolboxTab, setModuleTab],
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
      flushSync(() => {
        setWorkspaceTabs((prev) =>
          prev.map((tab) => (tab.id === tabId ? { ...tab, preview: undefined } : tab)),
        );
      });
      patchDockTabPreviewMeta(tabId, false);
    },
    [setWorkspaceTabs],
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

  const moduleModeIconItems = useMemo(
    () => [
      { id: "dataSync", label: t("database.tabs.dataSync"), icon: "table" as const },
      { id: "schemaSync", label: t("database.tabs.schemaSync"), icon: "database" as const },
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
      // 连接列表加载失败时保留当前状??
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
      return;
    }
    if (moduleTab === "dataSync" || moduleTab === "schemaSync") {
      openOrActivateToolboxTab(moduleTab);
    }
  }, [workspaceInitialized, moduleTab, openOrActivateToolboxTab]);

  useEffect(() => {
    if (!workspaceInitialized || !activeWorkspaceTabId) {
      return;
    }
    const tab = workspaceTabs.find((item) => item.id === activeWorkspaceTabId);
    if (isToolboxTab(tab)) {
      if (moduleTab !== tab.toolboxTab) {
        setModuleTab(tab.toolboxTab);
      }
      return;
    }
    if (moduleTab !== "query") {
      setModuleTab("query");
    }
  }, [workspaceInitialized, workspaceTabs, activeWorkspaceTabId, moduleTab, setModuleTab]);

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

      const connForSchema = { ...connection, database: tab.dbName };
      void introspectTable(connection, tab.dbName, tab.tableName)
        .then((schema) => {
          if (connection.db_type !== "redis") {
            setTableColumnMeta((prev) => ({ ...prev, [tab.id]: schema.columns }));
          }
        })
        .catch(() => {});

      const sort = previewState?.sort ?? null;
      const filter = previewState?.filter ?? null;
      const hiddenColumns = previewState?.hiddenColumns ? [...previewState.hiddenColumns] : [];
      const transposed = previewState?.transposed ?? false;
      const page = previewState?.page ?? 0;
      const pageSize = previewState?.pageSize ?? createDefaultTablePreviewState().pageSize;
      const orderBy = sort ? buildOrderByClause(sort, connection.db_type) : undefined;
      const where = formatFilterWhere(filter, connection.db_type);
      void Promise.all([
        countTable(connForSchema, tab.tableName, tab.dbName, where),
        previewTable(connForSchema, tab.tableName, pageSize, page * pageSize, orderBy, where),
      ])
        .then(([totalRows, data]) => {
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
      const database = useDbWorkspaceTabStore.getState().sqlTabStates[tabId]?.database.trim() ?? "";
      if (!conn || !database) {
        return null;
      }
      return { ...conn, database };
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
        return [cached];
      }
      return [buildDatabaseSchema(database, [])];
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
          // 忽略：用户可??Schema 侧栏手动刷新
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
        [key]: buildDatabaseSchema(database, tables),
      }));
    }
  }, [
    workspaceTabs,
    sqlTabPanelKeySeed,
    resolveSqlTabConnection,
    schemaByKey,
    cacheHydrated,
    schemaSnapshot,
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
        } else {
          const existingMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
          if (!existingMeta?.length) {
            void introspectTable(connection, dbName, tableName)
              .then((schema) => {
                setTableColumnMeta((prevMeta) => {
                  if (prevMeta[tabId]?.length) {
                    return prevMeta;
                  }
                  return { ...prevMeta, [tabId]: schema.columns };
                });
              })
              .catch(() => {});
          }
        }
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
      const connForSchema = { ...connection, database: dbName };

      setTablePreviews((prev) => {
        const existing = prev[tabId] ?? createDefaultTablePreviewState();
        const pageSize = existing.pageSize;
        const page = existing.page;
        const orderBy = existing.sort
          ? buildOrderByClause(existing.sort, connection.db_type)
          : undefined;
        const where = formatFilterWhere(existing.filter, connection.db_type);

        Promise.all([
          countTable(connForSchema, tableName, dbName, where),
          previewTable(connForSchema, tableName, pageSize, page * pageSize, orderBy, where),
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
        const where = formatFilterWhere(existing.filter, connection.db_type);

        previewTable(connForSchema, tableName, pageSize, page * pageSize, orderBy, where)
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

  const setTableFilter = useCallback(
    (tabId: string, filter: RuleGroupType | null) => {
      const preview = useDbWorkspaceTabStore.getState().tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      const connection = connections.find((c) => c.id === preview.connId);
      if (!connection) return;
      const connForSchema = { ...connection, database: preview.dbName };

      setTablePreviews((prev) => {
        const existing = prev[tabId] ?? createDefaultTablePreviewState();
        const pageSize = existing.pageSize;
        const orderBy = existing.sort
          ? buildOrderByClause(existing.sort, connection.db_type)
          : undefined;
        const where = formatFilterWhere(filter, connection.db_type);

        Promise.all([
          countTable(connForSchema, preview.tableName!, preview.dbName!, where),
          previewTable(connForSchema, preview.tableName!, pageSize, 0, orderBy, where),
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
      const connection = connections.find((c) => c.id === preview.connId);
      if (!connection) return;
      const connForSchema = { ...connection, database: preview.dbName };

      setTablePreviews((prev) => {
        const existing = prev[tabId] ?? createDefaultTablePreviewState();
        const pageSize = existing.pageSize;
        const orderBy = sort ? buildOrderByClause(sort, connection.db_type) : undefined;
        const where = formatFilterWhere(existing.filter, connection.db_type);

        Promise.all([
          countTable(connForSchema, preview.tableName!, preview.dbName!, where),
          previewTable(connForSchema, preview.tableName!, pageSize, 0, orderBy, where),
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
    [connections],
  );

  const commitTabDirty = useCallback(
    async (tabId: string) => {
      const tabState = useDbWorkspaceTabStore.getState();
      const dirty = tabState.tabDirtyRows[tabId];
      if (!dirty) return;
      const preview = tabState.tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      const connection = connections.find((c) => c.id === preview.connId);
      if (!connection) return;
      const colMeta = tabState.tableColumnMeta[tabId];
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
          await invoke("db_execute_query", {
            connection: connForSchema,
            sql,
            runId: makeQueryRunId(),
          });
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
      patch: Partial<Pick<TablePreviewState, "hiddenColumns" | "transposed">>,
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
      const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
      if (!colMeta?.length) return;
      const firstEditable = colMeta.find((c) => !c.isPk) ?? colMeta[0];
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
      const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
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
    [isSameCellValue],
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
    [rowEdit, isSameCellValue],
  );

  const handleCellSave = useCallback(
    (value: unknown) => {
      if (!cellEdit) return;
      commitCellDirtyChange(cellEdit.tabId, cellEdit.column, cellEdit.row, value);
      setCellEdit(null);
    },
    [cellEdit, commitCellDirtyChange],
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
      await writeToClipboard(toCsv(payload.columns, payload.rows));
    },
    [resolveTabExportData],
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
        ];
      }

      return [];
    },
    [copyDdlForTable, copyNameForTable, handleDesignTable, t, toggleConnectionEnabled],
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
      const { setConnectionRefreshing, patchConnection } = useDbSchemaCacheStore.getState();
      setConnectionRefreshing(connId, true);
      void refreshConnectionSchemaCache(conn, schemaCacheReporter)
        .then(async (entry) => {
          await patchConnection(connId, entry);
          const names = entry.databases.map((db) => db.name);
          setDatabasesByConnId((prev) => ({ ...prev, [connId]: names }));
          setDatabaseFilters((prev) => ({
            ...prev,
            [connId]: mergeFilter(prev[connId], names),
          }));
        })
        .catch((err) => {
          schemaCacheReporter.onError?.(String(err));
        })
        .finally(() => {
          setConnectionRefreshing(connId, false);
        });
    },
    [connections, schemaCacheReporter, setDatabaseFilters],
  );

  const handleSelectTable = useCallback(
    (selection: SchemaTableSelection, mode: SchemaDockOpenMode = "preview") => {
      setActiveConnIdIfChanged(selection.connId);

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
        activateWorkspaceTab(existingTabId);
        if (connection.db_type !== "redis") {
          const warmed = warmColumnMetaFromCache(existingTabId);
          if (!warmed) {
            void introspectTable(connection, dbName, tableName)
              .then((schema) => {
                setTableColumnMeta((prev) => {
                  if (prev[existingTabId]?.length) return prev;
                  return { ...prev, [existingTabId]: schema.columns };
                });
              })
              .catch(() => {});
          }
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
    },
    [
      loadTablePreview,
      activateWorkspaceTab,
      promotePreviewTab,
      replacePreviewDockTab,
      setActiveConnIdIfChanged,
      setTableColumnMeta,
      setTablePreviews,
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
    (selection: SchemaDatabaseSelection, mode: SchemaDockOpenMode = "preview") => {
      setActiveConnIdIfChanged(selection.connId);
      const moduleTabs = workspaceTabsRef.current.filter(isModuleDockTab);
      const { connId, dbName, connection } = selection;
      const isRedis = isRedisConnection(connection);

      const existingTabId = isRedis
        ? findTabIdForRedisQuery(moduleTabs, connId, dbName)
        : findTabIdForDatabase(moduleTabs, connId, dbName);
      if (existingTabId) {
        activateWorkspaceTab(existingTabId);
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
    [activateWorkspaceTab, promotePreviewTab, replacePreviewDockTab, setActiveConnIdIfChanged],
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

  const performCopyTabToWorkspace = useCallback(
    (tabId: string) => {
      if (!activeWorkspaceId) return;
      const ctxTab = workspaceTabs.find((tab) => tab.id === tabId);
      if (!ctxTab) return;

      // Generate a new ID based on kind
      const newTabId =
        ctxTab.kind === "designer"
          ? `designer:${ctxTab.connId}:${ctxTab.dbName}:${ctxTab.tableName}:${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
          : `sql:${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

      const newTab = { ...ctxTab, id: newTabId, workspaceOnly: true } as DbWorkspaceTab;

      setWorkspaceTabs((prev) => [...prev, newTab]);
      setTabModes((prev) => ({ ...prev, [newTabId]: tabModes[ctxTab.id] }));

      const tabStoreState = useDbWorkspaceTabStore.getState();
      const sqlTabStates = tabStoreState.sqlTabStates;
      const tablePreviews = tabStoreState.tablePreviews;
      const tableColumnMeta = tabStoreState.tableColumnMeta;
      const tabDirtyRows = tabStoreState.tabDirtyRows;
      const setTableColumnMeta = useDbWorkspaceTabStore.getState().setTableColumnMeta;
      const setTabDirtyRows = useDbWorkspaceTabStore.getState().setTabDirtyRows;
      
      if (sqlTabStates[ctxTab.id]) {
        setSqlTabStates((prev) => ({
          ...prev,
          [newTabId]: { ...sqlTabStates[ctxTab.id] },
        }));
      }
      if (tablePreviews[ctxTab.id]) {
        setTablePreviews((prev) => ({
          ...prev,
          [newTabId]: { ...tablePreviews[ctxTab.id] },
        }));
      }
      if (tableColumnMeta[ctxTab.id]) {
        setTableColumnMeta((prev) => ({
          ...prev,
          [newTabId]: [...tableColumnMeta[ctxTab.id]],
        }));
      }
      if (tabDirtyRows[ctxTab.id]) {
        setTabDirtyRows((prev) => ({
          ...prev,
          [newTabId]: { ...tabDirtyRows[ctxTab.id] },
        }));
      }
      if (tableDesignerStates[ctxTab.id]) {
        updateTableDesignerState(newTabId, tableDesignerStates[ctxTab.id]);
      }

      addSnapshotToWorkspace(
        activeWorkspaceId,
        dbTabToSnapshot(newTab, tabModes[ctxTab.id]),
      );
    },
    [workspaceTabs, tabModes, tableDesignerStates, updateTableDesignerState, activeWorkspaceId],
  );

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
      if (action === "copyToWorkspace") {
        performCopyTabToWorkspace(ctxMenu.tabId);
        setCtxMenu(null);
        return;
      }
      if (action === "moveToWorkspace") {
        if (!activeWorkspaceId) return;
        const ctxTab = workspaceTabs.find((tab) => tab.id === ctxMenu.tabId);
        if (ctxTab) {
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
          addSnapshotToWorkspace(
            activeWorkspaceId,
            dbTabToSnapshot(ctxTab, tabStoreState.tabModes[ctxTab.id]),
          );
        }
        setCtxMenu(null);
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
    [ctxMenu, workspaceTabs, closeWorkspaceTab, closeWorkspaceTabs, handleRenameTab, setDockLayout, performCopyTabToWorkspace, activeWorkspaceId, tabModes],
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

  const openRedisQueryTab = useCallback(
    (connId: string, dbName: string | undefined, label: string, mode: SchemaDockOpenMode = "preview") => {
      const moduleTabs = workspaceTabsRef.current.filter(isModuleDockTab);
      const existingTabId = findTabIdForRedisQuery(moduleTabs, connId, dbName);
      if (existingTabId) {
        activateWorkspaceTab(existingTabId);
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
    [activateWorkspaceTab, promotePreviewTab, replacePreviewDockTab],
  );

  const handleSelectConnection = useCallback(
    (connId: string, mode: SchemaDockOpenMode = "preview") => {
      setActiveConnIdIfChanged(connId);
      const conn = connections.find((item) => item.id === connId);
      if (!conn) return;
      const normalized = normalizeConnectionGroup(conn.group);
      const group = groups.find((item) => item.name === normalized);
      if (group) {
        setActiveGroupId(group.id);
      }

      if (isRedisConnection(conn)) {
        openRedisQueryTab(connId, undefined, conn.name, mode);
        return;
      }

      const moduleTabs = workspaceTabsRef.current.filter(isModuleDockTab);
      const existingTabId = findTabIdForConnection(moduleTabs, connId);
      if (existingTabId) {
        activateWorkspaceTab(existingTabId);
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
    [connections, groups, setActiveGroupId, openRedisQueryTab, activateWorkspaceTab, promotePreviewTab, replacePreviewDockTab, setActiveConnIdIfChanged],
  );

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
    const conn = connectionForSqlTab(resolvedTabId);
    const sessions = tabState.resultSessions ?? [];

    if (options?.sessionId) {
      const session = sessions.find((item) => item.id === options.sessionId);
      if (!session) return;
      if (!conn) {
        updateSqlResultSession(resolvedTabId, session.id, {
          error: t("database.results.noConnection"),
        });
        return;
      }
      const resultPage = Math.max(0, options.resultPage ?? 0);
      const sql = session.sql.trim();
      if (!sql) return;

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

    const runId = makeQueryRunId();
    const session = createSqlResultSession(sql);
    updateSqlTabState(resolvedTabId, {
      running: true,
      activeQueryRunId: runId,
      error: null,
      resultSessions: [...sessions, session],
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

  // 表预览（data）模式：编辑器常折叠且无焦点，在此统一处理 ??Ctrl+Enter??
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter" || e.shiftKey || e.altKey) {
        return;
      }
      if (isSqlMonacoEditorFocused()) return;

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
      const sqlToSave = formatSql(state.sql, connection?.db_type ?? null);
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

  const workspaceStateValue: DbWorkspaceSharedContextValue = useMemo(
    () => ({
        tabs: workspaceTabs,
        closeTab: (tabId: string) => requestTabAction({ kind: "close", tabId }),
        runQuery,
        cancelQuery,
        goToQueryResultPage,
        updateSqlTabState,
        closeSqlResultSession,
        refreshTablePreview,
        goToPage,
        requestTabAction,
        setTableSort,
        setTableFilter,
        setTableGridView,
        handleCellEdit,
        handleRowEdit,
        handleCellSetNull,
        handleRowNew,
        resolveConnection,
        connectionsLoading,
        selectTable: handleSelectTable,
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
    refreshTablePreview,
    goToPage,
    setTableFilter,
    setTableGridView,
    handleCellEdit,
    handleRowEdit,
    handleCellSetNull,
    handleRowNew,
    resolveConnection,
    connectionsLoading,
    handleSelectTable,
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
              panelType: "database",
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
              panelType: "database",
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
              panelType: "database",
              icon: "database" as const,
              tooltip: t("database.redisQuery.search"),
              closable: true,
              preview,
            };
          }
          if (tab.kind === "toolbox") {
            return {
              id: tab.id,
              label: tab.label,
              panelType: "database",
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
              panelType: "database",
              type: "file" as const,
              dirty,
              saved: !dirty,
              icon: "table" as const,
              tooltip: t("database.tableDesigner.tabTooltip", { label: tab.label }),
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
            panelType: "database",
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
                <DatabaseConnectionInfoPanel
                  connection={connection}
                  active={tab.id === activeWorkspaceTabId}
                />
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

      if (tab.kind === "toolbox") {
        return (
          <div className="db-workspace-pane db-dock-pane db-module-transfer">
            <DatabaseToolbox
              active={tab.id === activeWorkspaceTabId}
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

  const moduleSoftRefreshKey = useMemo(
    () =>
      [
        connections.map((c) => c.id).join(","),
        connectionsLoading ? "1" : "0",
        workspaceTabs.map((t) => `${t.id}:${t.workspaceOnly ? "1" : "0"}`).join(","),
        activeWorkspaceTabId,
      ].join("|"),
    [connections, connectionsLoading, workspaceTabs, activeWorkspaceTabId],
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

  const editorHostTabId = cellEdit?.tabId ?? rowEdit?.tabId ?? null;
  const editorTableColumnMeta = useDbWorkspaceTabStore((state) =>
    editorHostTabId ? state.tableColumnMeta[editorHostTabId] : undefined,
  );
  const editorTabDirtyRows = useDbWorkspaceTabStore((state) =>
    editorHostTabId
      ? state.tabDirtyRows[editorHostTabId] ?? EMPTY_TAB_DIRTY_ROWS
      : EMPTY_TAB_DIRTY_ROWS,
  );
  const pendingCommitTabId = pendingTabAction?.tabId ?? null;
  const pendingDirtyCount = useDbWorkspaceTabStore((state) =>
    pendingCommitTabId
      ? Object.keys(state.tabDirtyRows[pendingCommitTabId] ?? {}).length
      : 0,
  );
  const pendingCommitBusy = useDbWorkspaceTabStore((state) =>
    pendingCommitTabId ? state.committingTabs.has(pendingCommitTabId) : false,
  );

  return (
    <>
    <DatabaseModuleContextBridge active={moduleLive} context={databaseModuleContext} />
    <DbSidebarLinkageProvider value={sidebarLinkageValue}>
    <DbWorkspaceProviders state={workspaceStateValue} activeTab={activeTabContextValue}>
    <ModuleWorkspaceLayout
      layoutKey="database"
      className="db-module-layout"
      leftColumnTitle={t("routes.database")}
      leftPreset="schema"
      leftIconRail={
        <ModuleModeIconRail
          items={moduleModeIconItems}
          activeId={moduleTab}
          onChange={handleModuleModeChange}
        />
      }
      leftSidebar={
        <DbSchemaProvider value={schemaContextValue}>
          <DatabaseSchemaSidebar
            onCreateConnection={() => {
              setEditingConnection(null);
              setDialogOpen(true);
            }}
            onSelectConnection={handleSelectConnection}
            onOpenSqlFile={openSqlFile}
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
        </DbSchemaProvider>
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
            onCloseTab={(tabId) => requestTabAction({ kind: "close", tabId })}
            dockLayout={dockLayout}
            onDockLayoutChange={setDockLayout}
            renderDockPanel={renderDockPanel}
            softRefreshKey={moduleSoftRefreshKey}
            panelContentKeysByTab={panelContentKeysByTab}
            onTabContextMenu={handleDockTabContextMenu}
            onTabDoubleClick={handleDockTabDoubleClick}
            recentClosedActionItems={recentClosedActionItems}
            emptyPrompt={t("database.workspace.emptyTabs")}
            recentClosedTitle={t("database.workspace.recentClosed")}
          />
        )}
      </div>
    </ModuleWorkspaceLayout>
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
      {pendingTabAction && (
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
                {t("database.results.dirtyMessage", { count: pendingDirtyCount })}
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
                disabled={pendingCommitBusy}
              >
                {t("database.results.dirtyCommit")}
              </Button>
            </div>
          </div>
      )}
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
    </DbWorkspaceProviders>
    </DbSidebarLinkageProvider>
    <DatabaseTableEditorHost
      cellEdit={cellEdit}
      rowEdit={rowEdit}
      tableColumnMeta={editorTableColumnMeta ? { [editorHostTabId!]: editorTableColumnMeta } : {}}
      tabDirtyRows={editorHostTabId ? { [editorHostTabId]: editorTabDirtyRows } : {}}
      onCellSave={handleCellSave}
      onCellCancel={() => setCellEdit(null)}
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
          { showWorkspaceActions: true, showRename: true },
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
