import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../../i18n";
import { commands } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";
import { appConfirm } from "../../../lib/appConfirm";
import {
  ACTION_DB_DROP_DATABASE,
  ACTION_DB_DROP_TABLE,
  dropDatabaseTarget,
  dropTableObjectsTarget,
} from "../../../lib/presenceTargets";
import { requireStepUp } from "../../../lib/stepUp";
import { appAlert } from "../../../lib/appAlert";
import { quickInput } from "../../../lib/quickInput";
import { useActionStore } from "../../../stores/actionStore";
import {
  type DbConnectionConfig,
  listConnections,
  isConnectionEnabled,
  connectionHasTableSchemaChildren,
} from "../api";
import { makeQueryRunId } from "../sql/queryRun";
import { resolveSqlPresenceToken } from "../sql/sqlPresence";
import { useDbSqlFileStore, type DbSqlFileNode } from "../../../stores/dbSqlFileStore";
import { useDbSchemaTreeExpandedStore } from "../../../stores/dbSchemaTreeExpandedStore";
import { useDbSchemaCacheStore } from "../../../stores/dbSchemaCacheStore";
import { useSchemaBrowserFilters } from "./useSchemaBrowserFilters";
import { useDbConnectionRuntimeStore } from "../../../stores/dbConnectionRuntimeStore";
import {
  useDbSchemaConnectionLayoutStore,
  schemaConnectionFolderNodeId,
} from "../../../stores/dbSchemaConnectionLayoutStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import {
  makeTableFilterKey,
  mergeFilter,
  applyTablePinOrder,
} from "./DatabaseFilterDialog";
import {
  buildDatabaseTreeItem,
  buildConnectionTreeItem,
  buildFolderTreeItem,
  buildTableTreeItem,
  buildViewTreeItem,
  type SchemaTreeItem,
} from "./schemaTreeItem";
import {
  buildDropColumnSql,
  buildDropDatabaseSql,
  buildDropIndexSql,
  buildDropTableSql,
  buildDropUserSql,
  buildDropViewSql,
  isSchemaNodeDropSupported,
} from "./schemaTreeDropSql";
import {
  isSchemaNodeDeletable,
  isSchemaNodeRefreshable,
  schemaNodeDeleteActionKey,
} from "./schemaTreeNodeActions";
import {
  collectExpandedIdsForScrollTarget,
  resolveSchemaTreeScrollTarget,
} from "./schemaTreeSidebarLinkage";
import { mergeConnectionsWithCache, type CachedConnection } from "./schemaCacheMerge";
import {
  submitSchemaCacheRefresh,
  SCHEMA_CACHE_REFRESH_COMPLETE_EVENT,
  syncConnectionRuntimeFromSchemaCache,
} from "./schemaCacheBackgroundTasks";
import { nextSchemaChildLimit } from "./schemaTreePagination";
import {
  createSchemaCacheRefreshReporter,
  publishSchemaNodeRefreshDone,
  publishSchemaNodeRefreshFailed,
  publishSchemaNodeRefreshStart,
} from "./schemaCacheStatusLog";
import { databaseObjectsNeedLoad, tableDetailsNeedLoad } from "./schemaCache";
import {
  connectionUsersFolderId,
  makeDatabaseNodeId,
  parseDatabaseNodeId,
  parseTableNodeId,
  parseUserNodeId,
  parseViewNodeId,
} from "./schemaTreeIds";
import {
  buildSchemaFlatRows,
  collectSchemaPathCrumbsForNodeId,
  findSchemaFlatRowIndexByNodeId,
  isSchemaFlatRowIndexInViewport,
  scrollSchemaFlatRowIntoView,
  SCHEMA_TREE_NODE_ROW_HEIGHT,
  SCHEMA_TREE_VIRTUALIZE_THRESHOLD,
  type SchemaFlatRow,
  type StickySchemaAncestor,
} from "./schemaTreeFlatRows";
import { useShareUiStore } from "../../../stores/shareUiStore";
import {
  createLayoutDragGhost,
  isLayoutPointerDragExcludedTarget,
  resolveLayoutDropFromPointer,
  SCHEMA_LAYOUT_POINTER_DRAG_THRESHOLD,
  type SchemaLayoutDragPayload,
} from "./schemaLayoutPointerDnD";
import {
  refreshAndApplySchemaTreeNode,
  type SchemaTreeRefreshHooks,
} from "./schemaTreeRefresh";
import { resolveSidebarTreeDeleteTargets } from "@/components/ui/sidebar-tree";
import type { ScopedSearchHandle } from "../../../components/ui/search";
import {
  buildDeploymentServerTagMap,
  DEPLOYMENT_CACHE_UPDATED_EVENT,
} from "../deploymentServerTag";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useShallow } from "zustand/react/shallow";
import type { SchemaBrowserProps, SchemaTableSelection } from "./schemaBrowserTypes";
import {
  resolveSoleDatabaseObjectFolderId,
  tableColumnsFolderId,
  tableIndexesFolderId,
  syncFiltersFromSnapshot,
} from "./schemaBrowserHelpers";
import type { TreeNodeProps } from "./SchemaTreeNode";
import {
  buildSchemaTreeContextMenuItems,
  type SchemaCtxMenuState,
} from "./buildSchemaTreeContextMenu";
import { createRenderSchemaFlatRow } from "./renderSchemaFlatRow";

type LoadedConnection = CachedConnection;
export function useSchemaBrowserModel({
  activeConnId = null,
  onSelectConnection,
  onSelectTable,
  onSelectDatabase,
  onOpenSqlFile,
  buildSchemaContextMenuItems,
  onDeleteConnections,
  onSchemaCacheConnectionPatched,
  activeTableKey = null,
  activeDatabaseKey = null,
  openTabNodeIds,
  refreshToken = 0,
  connectionConfigs,
  connectionsReady,
}: SchemaBrowserProps) {
  const { t } = useI18n();
  const openShareDialog = useShareUiStore((s) => s.openShareDialog);
  const sqlFileNodes = useDbSqlFileStore((s) => s.nodes);
  const resolvedTheme = useSettingsStore((s) => s.resolved);
  const showTableSchemaChildren = useSettingsStore((s) => s.databaseSchemaTreeShowTableChildren);
  const useExternalConnections =
    connectionConfigs !== undefined && connectionsReady !== undefined;
  const [search, setSearch] = useState("");
  const [childVisibleLimits, setChildVisibleLimits] = useState<Record<string, number>>({});
  const expandedNodeIds = useDbSchemaTreeExpandedStore((s) => s.expandedNodeIds);
  const expandedHydrated = useDbSchemaTreeExpandedStore((s) => s.hydrated);
  const hydrateSchemaExpanded = useDbSchemaTreeExpandedStore((s) => s.hydrate);
  const updateExpanded = useDbSchemaTreeExpandedStore((s) => s.updateExpanded);
  const [internalConnections, setInternalConnections] = useState<LoadedConnection[]>([]);
  const [internalLoading, setInternalLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const {
    databaseFilters,
    tableFilters,
    filtersHydrated,
    hydrateSchemaFilters,
    setDatabaseFilters,
    setTableFilters,
    filterDialogConnId,
    setFilterDialogConnId,
    filterDialogTable,
    setFilterDialogTable,
    syncDatabaseFilter,
    syncTableFilter,
  } = useSchemaBrowserFilters();
  const [schemaCtxMenu, setSchemaCtxMenu] = useState<SchemaCtxMenuState>(null);
  const [layoutDragOverNodeId, setLayoutDragOverNodeId] = useState<string | null>(null);
  const [layoutDraggingSourceId, setLayoutDraggingSourceId] = useState<string | null>(null);
  const layoutPointerDragRef = useRef<{
    payload: SchemaLayoutDragPayload;
    sourceNodeId: string;
    startX: number;
    startY: number;
    pointerId: number;
    active: boolean;
  } | null>(null);
  const layoutDragGhostRef = useRef<HTMLElement | null>(null);
  const layoutFolders = useDbSchemaConnectionLayoutStore((s) => s.folders);
  const connectionParents = useDbSchemaConnectionLayoutStore((s) => s.connectionParents);
  const addLayoutFolder = useDbSchemaConnectionLayoutStore((s) => s.addFolder);
  const renameLayoutFolder = useDbSchemaConnectionLayoutStore((s) => s.renameFolder);
  const deleteLayoutFolder = useDbSchemaConnectionLayoutStore((s) => s.deleteFolder);
  const moveLayoutFolder = useDbSchemaConnectionLayoutStore((s) => s.moveFolder);
  const setConnectionLayoutParent = useDbSchemaConnectionLayoutStore((s) => s.setConnectionParent);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const schemaTreeRef = useRef<HTMLDivElement>(null);
  const scopedSearchRef = useRef<ScopedSearchHandle>(null);
  const [pathCrumbs, setPathCrumbs] = useState<StickySchemaAncestor[]>([]);
  const pathFocusNodeIdRef = useRef<string | null>(null);
  const flatRowsRef = useRef<SchemaFlatRow[]>([]);
  const schemaSnapshot = useDbSchemaCacheStore((s) => s.snapshot);
  const cacheHydrated = useDbSchemaCacheStore((s) => s.hydrated);
  const refreshingConnectionIds = useDbSchemaCacheStore((s) => s.refreshingConnectionIds);
  const refreshingNodeIds = useDbSchemaCacheStore((s) => s.refreshingNodeIds);
  const anyConnectionRefreshing = Object.keys(refreshingConnectionIds).length > 0;
  const syncSeqRef = useRef(0);
  const connectionsRef = useRef<LoadedConnection[]>([]);
  const sqlFilesRef = useRef<DbSqlFileNode[]>([]);

  const externalConnections = useMemo(() => {
    if (!useExternalConnections) {
      return null;
    }
    // 有连接配置就立刻与本地缓存合并渲染，不因 connectionsReady / 探测而空白等待
    if (!connectionConfigs) {
      return null;
    }
    return mergeConnectionsWithCache(connectionConfigs, schemaSnapshot, connectionsRef.current);
  }, [useExternalConnections, connectionConfigs, schemaSnapshot]);

  const connections = useExternalConnections ? (externalConnections ?? []) : internalConnections;
  // 延后 connections 驱动 buildSchemaFlatRows 的全量重建：首次挂载或 cache 刷新时，
  // urgent render 用旧 deferredConnections（memo 命中，不重算 flatRows），transition 再算。
  // 模块切换时 connections 引用稳定，useDeferredValue 无额外开销。
  const deferredConnections = useDeferredValue(connections);
  // 仅在「尚无任何连接配置可展示」且仍在拉取列表时显示 loading
  const loading = useExternalConnections
    ? !connectionsReady && connectionConfigs.length === 0 && !cacheHydrated
    : internalLoading;

  const schemaRefreshHooks = useMemo<SchemaTreeRefreshHooks>(
    () => ({
      syncDatabaseFilter,
      syncTableFilter,
      onConnectionPatched: onSchemaCacheConnectionPatched,
    }),
    [syncDatabaseFilter, syncTableFilter, onSchemaCacheConnectionPatched],
  );

  const enqueueAction = useActionStore((s) => s.enqueueAction);
  const [deletingNodeIds, setDeletingNodeIds] = useState<Record<string, true>>({});
  const selectedIdsRef = useRef<ReadonlySet<string>>(new Set());
  const handleSelectedIdsChange = useCallback((ids: ReadonlySet<string>) => {
    selectedIdsRef.current = ids;
  }, []);
  const [deploymentCacheTick, setDeploymentCacheTick] = useState(0);
  const sshConnections = useConnectionStore(
    useShallow((state) => state.connections.filter((conn) => conn.kind === "ssh")),
  );

  useEffect(() => {
    const onDeploymentCacheUpdated = () => {
      setDeploymentCacheTick((value) => value + 1);
    };
    window.addEventListener(DEPLOYMENT_CACHE_UPDATED_EVENT, onDeploymentCacheUpdated);
    return () => {
      window.removeEventListener(DEPLOYMENT_CACHE_UPDATED_EVENT, onDeploymentCacheUpdated);
    };
  }, []);

  const deploymentServerByConnId = useMemo(
    () => buildDeploymentServerTagMap(connections, sshConnections),
    [connections, sshConnections, deploymentCacheTick],
  );

  const handleRefreshSchemaNode = useCallback(
    (connection: DbConnectionConfig, item: SchemaTreeItem) => {
      if (!isSchemaNodeRefreshable(item.type)) {
        return;
      }
      publishSchemaNodeRefreshStart(t, item.label);
      void refreshAndApplySchemaTreeNode(connection, item, schemaRefreshHooks)
        .then(() => publishSchemaNodeRefreshDone(t, item.label))
        .catch((err) => publishSchemaNodeRefreshFailed(t, item.label, String(err)));
    },
    [schemaRefreshHooks, t],
  );

  const deleteOneSchemaNode = useCallback(
    async (
      connection: DbConnectionConfig,
      item: SchemaTreeItem,
      options?: { alreadyDropped?: boolean },
    ): Promise<boolean> => {
      if (!isSchemaNodeDeletable(item.type)) {
        return false;
      }
      if (!isSchemaNodeDropSupported(connection.db_type, item.type)) {
        void appAlert(t("database.schemaTree.dropUnsupported"));
        return false;
      }

      const dbName = item.dbName?.trim();
      const tableName = item.tableName?.trim();
      let objectName = item.label.trim();

      if (item.type === "column") {
        if (!dbName || !tableName) return false;
        objectName = (item.columnName ?? item.label).trim();
      } else if (item.type === "index") {
        if (!dbName || !tableName) return false;
        objectName = (item.indexName ?? item.label).trim();
      } else if (item.type === "database") {
        const parsed = parseDatabaseNodeId(item.id);
        const resolvedDbName = parsed?.dbName ?? dbName;
        if (!resolvedDbName) return false;
        objectName = resolvedDbName;
      } else if (item.type === "table" || item.type === "view") {
        const parsed =
          item.type === "view" ? parseViewNodeId(item.id) : parseTableNodeId(item.id);
        const resolvedDbName = parsed?.dbName ?? dbName;
        const resolvedObjectName =
          item.type === "view"
            ? (parsed?.tableName ?? item.tableName ?? item.label).trim()
            : (parsed?.tableName ?? tableName ?? item.label).trim();
        if (!resolvedDbName || !resolvedObjectName) return false;
        objectName = resolvedObjectName;
      } else if (item.type === "user") {
        const parsed = parseUserNodeId(item.id);
        if (!parsed) return false;
        objectName = parsed.host ? `${parsed.name}@${parsed.host}` : parsed.name;
      }

      let sql: string | null = null;
      if (item.type === "column" && dbName && tableName) {
        sql = buildDropColumnSql(connection.db_type, dbName, tableName, objectName);
      } else if (item.type === "index" && dbName && tableName) {
        sql = buildDropIndexSql(connection.db_type, dbName, tableName, objectName);
      } else if (item.type === "database") {
        const resolvedDbName = parseDatabaseNodeId(item.id)?.dbName ?? dbName;
        if (resolvedDbName) {
          sql = buildDropDatabaseSql(connection.db_type, resolvedDbName);
        }
      } else if (item.type === "table") {
        const parsed = parseTableNodeId(item.id);
        const resolvedDbName = parsed?.dbName ?? dbName;
        const resolvedTableName = parsed?.tableName ?? tableName;
        if (resolvedDbName && resolvedTableName) {
          sql = buildDropTableSql(connection.db_type, resolvedDbName, resolvedTableName);
        }
      } else if (item.type === "view") {
        const parsed = parseViewNodeId(item.id);
        const resolvedDbName = parsed?.dbName ?? dbName;
        const resolvedViewName = parsed?.tableName ?? item.tableName ?? item.label;
        if (resolvedDbName && resolvedViewName) {
          sql = buildDropViewSql(connection.db_type, resolvedDbName, resolvedViewName);
        }
      } else if (item.type === "user") {
        const parsed = parseUserNodeId(item.id);
        if (parsed) {
          sql = buildDropUserSql(connection.db_type, parsed.name, parsed.host);
        }
      }

      if (!sql) {
        void appAlert(t("database.schemaTree.dropUnsupported"));
        return false;
      }

      setDeletingNodeIds((prev) => ({ ...prev, [item.id]: true }));
      try {
        enqueueAction({
          type: "sql",
          title: t(schemaNodeDeleteActionKey(item.type)),
          description: `${connection.name} · ${objectName}`,
          command: sql,
          resourceId: connection.id,
          source: "用户",
        });
        if (!options?.alreadyDropped) {
          const presenceToken = await resolveSqlPresenceToken(connection, sql, t);
          if (presenceToken === null) return false;
          await invoke("db_execute_query", {
            connection,
            sql,
            runId: makeQueryRunId(),
            limit: 1,
            offset: 0,
            presenceToken: presenceToken ?? null,
          });
        }

        let refreshItem: SchemaTreeItem;
        if (item.type === "database") {
          refreshItem = buildConnectionTreeItem(
            connection.id,
            connection.name,
            connection.db_type,
          );
        } else if (item.type === "user") {
          refreshItem = buildFolderTreeItem(
            connectionUsersFolderId(connection.id),
            t("database.sidebar.users"),
            connection.id,
          );
        } else if (item.type === "table" || item.type === "view") {
          const parsed =
            item.type === "view" ? parseViewNodeId(item.id) : parseTableNodeId(item.id);
          const resolvedDbName = parsed?.dbName ?? dbName;
          if (!resolvedDbName) return false;
          refreshItem = buildDatabaseTreeItem(connection.id, resolvedDbName);
        } else {
          const resolvedDbName = dbName;
          const resolvedTableName = tableName;
          if (!resolvedDbName || !resolvedTableName) return false;
          refreshItem = buildTableTreeItem(connection.id, resolvedDbName, resolvedTableName);
        }

        await refreshAndApplySchemaTreeNode(connection, refreshItem, schemaRefreshHooks);
        return true;
      } catch (err) {
        void appAlert(t("database.schemaTree.dropFailed", { message: String(err) }));
        return false;
      } finally {
        setDeletingNodeIds((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
      }
    },
    [enqueueAction, schemaRefreshHooks, t],
  );

  const handleDeleteSchemaNode = useCallback(
    async (connection: DbConnectionConfig, item: SchemaTreeItem): Promise<boolean> => {
      if (!isSchemaNodeDeletable(item.type)) {
        return false;
      }
      if (!isSchemaNodeDropSupported(connection.db_type, item.type)) {
        void appAlert(t("database.schemaTree.dropUnsupported"));
        return false;
      }

      const targetIds = resolveSidebarTreeDeleteTargets(item.id, selectedIdsRef.current, {
        filter: (id) => {
          const row = flatRowsRef.current.find(
            (entry) => entry.kind === "node" && entry.item.id === id,
          );
          return (
            row?.kind === "node" &&
            row.item.type === item.type &&
            row.item.connId === item.connId &&
            isSchemaNodeDeletable(row.item.type)
          );
        },
      });
      const targets = targetIds
        .map((id) => {
          const row = flatRowsRef.current.find(
            (entry) => entry.kind === "node" && entry.item.id === id,
          );
          return row?.kind === "node" ? row.item : undefined;
        })
        .filter((entry): entry is SchemaTreeItem => Boolean(entry));

      if (targets.length === 0) {
        return false;
      }

      const tableLike = targets.filter((item) => item.type === "table" || item.type === "view");
      const databases = targets.filter((item) => item.type === "database");
      if (tableLike.length === targets.length) {
        const objects = tableLike.map((item) => {
          const parsed =
            item.type === "view" ? parseViewNodeId(item.id) : parseTableNodeId(item.id);
          return {
            database: parsed?.dbName ?? item.dbName ?? "",
            name:
              item.type === "view"
                ? (parsed?.tableName ?? item.tableName ?? item.label).trim()
                : (parsed?.tableName ?? item.tableName ?? item.label).trim(),
            kind: item.type === "view" ? "view" : "table",
          };
        });
        const grantTarget = dropTableObjectsTarget(connection.id, objects);
        const label = objects.map((o) => o.name).join(", ");
        const token = await requireStepUp({
          action: ACTION_DB_DROP_TABLE,
          target: grantTarget,
          title: t("database.schemaTree.confirmDeleteTitle"),
          message: t("database.schemaTree.confirmDeleteTable", {
            name: label,
            database: objects[0]?.database ?? "",
          }),
          reason: t("database.schemaTree.confirmDeleteTable", {
            name: label,
            database: objects[0]?.database ?? "",
          }),
          confirmLabel: t("database.schemaTree.deleteTable"),
        });
        if (!token) return false;
        try {
          await unwrapCommand(commands.dbDropTable(connection, objects, token));
          for (const item of tableLike) {
            await deleteOneSchemaNode(connection, item, { alreadyDropped: true });
          }
          return true;
        } catch (err) {
          void appAlert(t("database.schemaTree.dropFailed", { message: String(err) }));
          return false;
        }
      }
      if (databases.length === targets.length) {
        const names = databases.map(
          (item) => parseDatabaseNodeId(item.id)?.dbName ?? item.dbName ?? item.label.trim(),
        );
        const joined = [...names].sort().join(",");
        const token = await requireStepUp({
          action: ACTION_DB_DROP_DATABASE,
          target: dropDatabaseTarget(connection.id, joined),
          title: t("database.schemaTree.confirmDeleteTitle"),
          message: t("database.schemaTree.confirmDeleteDatabase", { name: joined }),
          reason: t("database.schemaTree.confirmDeleteDatabase", { name: joined }),
        });
        if (!token) return false;
        try {
          await unwrapCommand(commands.dbDropDatabase(connection, names, token));
          for (const item of databases) {
            await deleteOneSchemaNode(connection, item, { alreadyDropped: true });
          }
          return true;
        } catch (err) {
          void appAlert(t("database.schemaTree.dropFailed", { message: String(err) }));
          return false;
        }
      }

      if (targets.length === 1) {
        return deleteOneSchemaNode(connection, targets[0]!);
      }

      const confirmed = await appConfirm(
        t("sidebarTree.confirmDeleteSelected", { count: String(targets.length) }),
        t("database.schemaTree.confirmDeleteTitle"),
      );
      if (!confirmed) return false;
      let anyOk = false;
      for (const target of targets) {
        if (await deleteOneSchemaNode(connection, target)) {
          anyOk = true;
        }
      }
      return anyOk;
    },
    [deleteOneSchemaNode, t],
  );

  const resolveSchemaNodeActions = useCallback(
    (
      connection: DbConnectionConfig,
      item: SchemaTreeItem,
    ): Pick<TreeNodeProps, "onRefresh" | "refreshing" | "refreshDisabled" | "onDelete" | "deleteDisabled"> => {
      const props: Pick<
        TreeNodeProps,
        "onRefresh" | "refreshing" | "refreshDisabled" | "onDelete" | "deleteDisabled"
      > = {};
      if (isSchemaNodeRefreshable(item.type)) {
        props.onRefresh = () => handleRefreshSchemaNode(connection, item);
        props.refreshing = Boolean(refreshingNodeIds[item.id]);
        props.refreshDisabled =
          !isConnectionEnabled(connection) || Boolean(refreshingNodeIds[item.id]);
      }
      return props;
    },
    [handleRefreshSchemaNode, refreshingNodeIds],
  );

  const schemaCacheReporter = useMemo(
    () => createSchemaCacheRefreshReporter(t),
    [t],
  );

  const handleContextSchemaNode = useCallback(
    (item: SchemaTreeItem, event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      let connection: DbConnectionConfig | undefined;
      let tableSelection: SchemaTableSelection | undefined;

      if (item.connId) {
        const conn = connectionsRef.current.find((entry) => entry.config.id === item.connId);
        connection = conn?.config;
        if (
          item.type === "table" &&
          connection &&
          item.dbName &&
          item.tableName
        ) {
          tableSelection = {
            connId: item.connId,
            dbName: item.dbName,
            tableName: item.tableName,
            connection,
          };
        }
      }

      setSchemaCtxMenu({
        x: event.clientX,
        y: event.clientY,
        item,
        connection,
        tableSelection,
      });
    },
    [],
  );

  const handleContextLayoutRoot = useCallback((event: ReactMouseEvent) => {
    if (search.trim()) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("[data-schema-item-type]")) {
      return;
    }
    event.preventDefault();
    setSchemaCtxMenu({
      x: event.clientX,
      y: event.clientY,
      item: null,
      layoutRoot: true,
    });
  }, [search]);

  const handleCreateLayoutFolder = useCallback(
    async (parentId: string | null) => {
      const name = await quickInput({
        title: t("database.sidebar.newFolderTitle"),
        placeholder: t("database.sidebar.folderNamePlaceholder"),
        defaultValue: t("database.sidebar.defaultFolderName"),
        validate: (value) => (value.trim() ? null : t("database.sidebar.folderNameRequired")),
      });
      if (!name) {
        return;
      }
      const folder = addLayoutFolder(parentId, name.trim());
      const nodeId = schemaConnectionFolderNodeId(folder.id);
      updateExpanded((prev) => new Set(prev).add(nodeId));
      if (parentId) {
        updateExpanded((prev) => new Set(prev).add(schemaConnectionFolderNodeId(parentId)));
      }
    },
    [addLayoutFolder, t, updateExpanded],
  );

  const handleRenameLayoutFolder = useCallback(
    async (folderId: string, currentName: string) => {
      const name = await quickInput({
        title: t("database.sidebar.renameFolderTitle"),
        defaultValue: currentName,
        validate: (value) => (value.trim() ? null : t("database.sidebar.folderNameRequired")),
      });
      if (!name) {
        return;
      }
      renameLayoutFolder(folderId, name.trim());
    },
    [renameLayoutFolder, t],
  );

  const handleDeleteLayoutFolder = useCallback(
    async (folderId: string) => {
      const confirmed = await appConfirm(
        t("database.sidebar.deleteFolderConfirm"),
        t("database.sidebar.deleteFolderTitle"),
      );
      if (!confirmed) {
        return false;
      }
      deleteLayoutFolder(folderId);
      return true;
    },
    [deleteLayoutFolder, t],
  );

  const handleHotkeyDeleteLayoutFolders = useCallback(
    async (folderIds: string[]) => {
      if (folderIds.length === 0) return false;
      if (folderIds.length === 1) {
        return handleDeleteLayoutFolder(folderIds[0]!);
      }
      const confirmed = await appConfirm(
        t("sidebarTree.confirmDeleteSelected", { count: String(folderIds.length) }),
        t("database.sidebar.deleteFolderTitle"),
      );
      if (!confirmed) return false;
      for (const folderId of folderIds) {
        deleteLayoutFolder(folderId);
      }
      return true;
    },
    [deleteLayoutFolder, handleDeleteLayoutFolder, t],
  );

  const sidebarHotkeysArmedRef = useRef(false);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      sidebarHotkeysArmedRef.current = Boolean(sidebarRef.current?.contains(event.target as Node));
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const handleHotkeyDelete = useCallback(
    async (selected: ReadonlySet<string>): Promise<boolean> => {
      if (selected.size === 0) return false;

      const orderedSelected = flatRowsRef.current
        .filter(
          (row): row is Extract<SchemaFlatRow, { kind: "node" }> =>
            row.kind === "node" && selected.has(row.item.id),
        )
        .map((row) => row.item);

      const primary = orderedSelected.find(
        (item) =>
          item.type === "connection-folder" ||
          item.type === "connection" ||
          isSchemaNodeDeletable(item.type),
      );
      if (!primary) return false;

      if (primary.type === "connection-folder") {
        const folderIds = orderedSelected
          .filter((item) => item.type === "connection-folder")
          .map((item) => item.id);
        return handleHotkeyDeleteLayoutFolders(folderIds);
      }

      if (primary.type === "connection") {
        if (!onDeleteConnections) return false;
        const configs = orderedSelected
          .filter((item) => item.type === "connection")
          .map((item) => {
            const connId = item.connId ?? (item.id.startsWith("conn:") ? item.id.slice(5) : item.id);
            return connectionsRef.current.find((entry) => entry.config.id === connId)?.config;
          })
          .filter((entry): entry is DbConnectionConfig => Boolean(entry));
        if (configs.length === 0) return false;
        return Promise.resolve(onDeleteConnections(configs));
      }

      const connection = connectionsRef.current.find(
        (entry) => entry.config.id === primary.connId,
      )?.config;
      if (!connection) return false;
      return handleDeleteSchemaNode(connection, primary);
    },
    [handleDeleteSchemaNode, handleHotkeyDeleteLayoutFolders, onDeleteConnections],
  );

  const applyLayoutDrop = useCallback(
    (payload: SchemaLayoutDragPayload, targetFolderId: string | null) => {
      if (payload.kind === "connection") {
        setConnectionLayoutParent(payload.connId, targetFolderId);
        return;
      }
      if (payload.folderId === targetFolderId) {
        return;
      }
      moveLayoutFolder(payload.folderId, targetFolderId);
      if (targetFolderId) {
        updateExpanded((prev) => new Set(prev).add(schemaConnectionFolderNodeId(targetFolderId)));
      }
    },
    [moveLayoutFolder, setConnectionLayoutParent, updateExpanded],
  );

  const cleanupLayoutPointerDrag = useCallback(() => {
    layoutDragGhostRef.current?.remove();
    layoutDragGhostRef.current = null;
    layoutPointerDragRef.current = null;
    setLayoutDragOverNodeId(null);
    setLayoutDraggingSourceId(null);
    document.body.classList.remove("schema-layout-dragging");
  }, []);

  const updateLayoutDropHighlight = useCallback((clientX: number, clientY: number) => {
    const { hoverNodeId } = resolveLayoutDropFromPointer(clientX, clientY);
    const folderHoverId =
      hoverNodeId &&
      document.querySelector(
        `[data-schema-node-id="${hoverNodeId}"][data-schema-item-type="connection-folder"]`,
      )
        ? hoverNodeId
        : null;
    setLayoutDragOverNodeId(folderHoverId);
  }, []);

  const beginLayoutPointerDrag = useCallback(
    (
      event: React.PointerEvent<HTMLElement>,
      payload: SchemaLayoutDragPayload,
      sourceNodeId: string,
    ) => {
      if (search.trim()) {
        return;
      }
      if (event.button !== 0) {
        return;
      }
      if (isLayoutPointerDragExcludedTarget(event.target)) {
        return;
      }
      layoutPointerDragRef.current = {
        payload,
        sourceNodeId,
        startX: event.clientX,
        startY: event.clientY,
        pointerId: event.pointerId,
        active: false,
      };
    },
    [search],
  );

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const session = layoutPointerDragRef.current;
      if (!session || event.pointerId !== session.pointerId) {
        return;
      }
      const dx = event.clientX - session.startX;
      const dy = event.clientY - session.startY;
      if (!session.active) {
        if (Math.hypot(dx, dy) < SCHEMA_LAYOUT_POINTER_DRAG_THRESHOLD) {
          return;
        }
        session.active = true;
        setLayoutDraggingSourceId(session.sourceNodeId);
        document.body.classList.add("schema-layout-dragging");
        const sourceEl = document.querySelector(
          `[data-schema-node-id="${session.sourceNodeId}"]`,
        ) as HTMLElement | null;
        if (sourceEl) {
          const ghost = createLayoutDragGhost(sourceEl, sourceEl.textContent?.trim() ?? "");
          ghost.style.left = `${event.clientX + 12}px`;
          ghost.style.top = `${event.clientY + 12}px`;
          layoutDragGhostRef.current = ghost;
        }
      }
      event.preventDefault();
      const ghost = layoutDragGhostRef.current;
      if (ghost) {
        ghost.style.left = `${event.clientX + 12}px`;
        ghost.style.top = `${event.clientY + 12}px`;
      }
      updateLayoutDropHighlight(event.clientX, event.clientY);
    };

    const onPointerUp = (event: PointerEvent) => {
      const session = layoutPointerDragRef.current;
      if (!session || event.pointerId !== session.pointerId) {
        return;
      }
      if (session.active) {
        event.preventDefault();
        const { targetFolderId } = resolveLayoutDropFromPointer(event.clientX, event.clientY);
        applyLayoutDrop(session.payload, targetFolderId);
        const suppressClick = (clickEvent: MouseEvent) => {
          clickEvent.preventDefault();
          clickEvent.stopImmediatePropagation();
          window.removeEventListener("click", suppressClick, true);
        };
        window.addEventListener("click", suppressClick, true);
        window.setTimeout(() => {
          window.removeEventListener("click", suppressClick, true);
        }, 0);
      }
      cleanupLayoutPointerDrag();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [applyLayoutDrop, cleanupLayoutPointerDrag, updateLayoutDropHighlight]);

  const getSchemaTreeContextMenuItems = useCallback(
    () =>
      buildSchemaTreeContextMenuItems({
        t,
        schemaCtxMenu,
        connectionsRef,
        selectedIdsRef,
        refreshingNodeIds,
        deletingNodeIds,
        buildSchemaContextMenuItems,
        handleCreateLayoutFolder,
        handleRenameLayoutFolder,
        handleDeleteLayoutFolder,
        handleRefreshSchemaNode,
        handleDeleteSchemaNode,
        openShareDialog,
      }),
    [
      buildSchemaContextMenuItems,
      deletingNodeIds,
      handleCreateLayoutFolder,
      handleDeleteLayoutFolder,
      handleRenameLayoutFolder,
      handleDeleteSchemaNode,
      handleRefreshSchemaNode,
      openShareDialog,
      refreshingNodeIds,
      schemaCtxMenu,
      t,
    ],
  );

  const loadConnections = useCallback(async () => {
    const seq = ++syncSeqRef.current;
    setInternalLoading(true);
    setLoadError(null);
    useDbSchemaCacheStore.getState().clearConnectionRefreshing();
    try {
      await useDbSchemaCacheStore.getState().hydrate();
      const list = await listConnections();
      const snapshot = useDbSchemaCacheStore.getState().snapshot;
      const merged = mergeConnectionsWithCache(list, snapshot, connectionsRef.current);
      if (seq !== syncSeqRef.current) {
        return;
      }
      connectionsRef.current = merged;
      setInternalConnections(merged);
    } catch (error) {
      if (seq !== syncSeqRef.current) {
        return;
      }
      setInternalConnections([]);
      setLoadError(String(error));
    } finally {
      if (seq === syncSeqRef.current) {
        setInternalLoading(false);
      }
    }
  }, []);

  const refreshSchemaCache = useCallback(async () => {
    setLoadError(null);
    try {
      await submitSchemaCacheRefresh(undefined, schemaCacheReporter);
    } catch (error) {
      schemaCacheReporter.onError?.(String(error));
      setLoadError(String(error));
    }
  }, [schemaCacheReporter]);

  useEffect(() => {
    if (useExternalConnections) {
      return;
    }
    const onComplete = (event: Event) => {
      const detail = (event as CustomEvent<{ snapshot: import("./schemaCache").SchemaCacheSnapshot }>)
        .detail;
      if (!detail?.snapshot) {
        return;
      }
      void (async () => {
        try {
          const list = await listConnections();
          const merged = mergeConnectionsWithCache(list, detail.snapshot, connectionsRef.current);
          connectionsRef.current = merged;
          setInternalConnections(merged);
          syncFiltersFromSnapshot(detail.snapshot, syncDatabaseFilter, syncTableFilter);
        } catch (error) {
          schemaCacheReporter.onError?.(String(error));
        }
      })();
    };
    window.addEventListener(SCHEMA_CACHE_REFRESH_COMPLETE_EVENT, onComplete);
    return () => {
      window.removeEventListener(SCHEMA_CACHE_REFRESH_COMPLETE_EVENT, onComplete);
    };
  }, [
    useExternalConnections,
    schemaCacheReporter,
    syncDatabaseFilter,
    syncTableFilter,
  ]);

  useEffect(() => {
    if (useExternalConnections) {
      return;
    }
    const configs = connectionsRef.current.map((item) => item.config);
    if (configs.length === 0) {
      return;
    }
    const merged = mergeConnectionsWithCache(configs, schemaSnapshot, connectionsRef.current);
    connectionsRef.current = merged;
    setInternalConnections(merged);
  }, [useExternalConnections, schemaSnapshot]);

  useEffect(() => {
    connectionsRef.current = connections;
  }, [connections]);

  useEffect(() => {
    sqlFilesRef.current = sqlFileNodes;
  }, [sqlFileNodes]);

  useEffect(() => {
    if (useExternalConnections) {
      return;
    }
    void loadConnections();
    return () => {
      syncSeqRef.current += 1;
    };
  }, [useExternalConnections, loadConnections, refreshToken]);

  useEffect(() => {
    if (!filtersHydrated) {
      void hydrateSchemaFilters();
    }
  }, [filtersHydrated, hydrateSchemaFilters]);


  useEffect(() => {
    const runtime = useDbConnectionRuntimeStore.getState();
    for (const conn of connections) {
      runtime.syncEnabled(conn.config.id, isConnectionEnabled(conn.config));
    }
  }, [connections]);

  useEffect(() => {
    if (!expandedHydrated) {
      void hydrateSchemaExpanded();
    }
  }, [expandedHydrated, hydrateSchemaExpanded]);

  const loadMoreChildren = useCallback((parentNodeId: string) => {
    setChildVisibleLimits((prev) => ({
      ...prev,
      [parentNodeId]: nextSchemaChildLimit(prev, parentNodeId),
    }));
  }, []);

  const toggle = useCallback((id: string) => {
    if (id.startsWith("conn:")) {
      const connId = id.slice(5);
      const conn = connectionsRef.current.find((item) => item.config.id === connId);
      if (conn && !isConnectionEnabled(conn.config)) {
        return;
      }
    }

    const expandedNodeIds = useDbSchemaTreeExpandedStore.getState().expandedNodeIds;
    const willExpand = !expandedNodeIds.has(id);
    updateExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

    if (!willExpand) {
      return;
    }

    if (id.startsWith("conn:")) {
      const connId = id.slice(5);
      const conn = connectionsRef.current.find((item) => item.config.id === connId);
      if (conn && isConnectionEnabled(conn.config)) {
        // 只同步本地缓存状态点；连通探测不挡展开，由打开连接 / 预热后台处理
        syncConnectionRuntimeFromSchemaCache(connId);
      }
    }

    const dbParsed = parseDatabaseNodeId(id);
    const dbFolderMatch = /^(?:tbls|views|other):([^:]+):(.+)$/.exec(id);
    const lazyConnId = dbParsed?.connId ?? dbFolderMatch?.[1] ?? null;
    const lazyDbName = dbParsed?.dbName ?? dbFolderMatch?.[2] ?? null;
    if (lazyConnId && lazyDbName) {
      const conn = connectionsRef.current.find((item) => item.config.id === lazyConnId);
      const db = conn?.databases?.find((item) => item.name === lazyDbName);
      const dbNodeId = makeDatabaseNodeId(lazyConnId, lazyDbName);
      const nodeRefreshing = Boolean(useDbSchemaCacheStore.getState().refreshingNodeIds[dbNodeId]);
      if (
        conn &&
        isConnectionEnabled(conn.config) &&
        databaseObjectsNeedLoad(db ?? {}) &&
        !nodeRefreshing
      ) {
        void refreshAndApplySchemaTreeNode(
          conn.config,
          buildDatabaseTreeItem(lazyConnId, lazyDbName),
          schemaRefreshHooks,
        ).catch((err) => {
          schemaCacheReporter.onError?.(String(err));
        });
      }
    }

    const tableParsed = parseTableNodeId(id);
    const viewParsed = parseViewNodeId(id);
    if (
      showTableSchemaChildren &&
      (tableParsed || viewParsed)
    ) {
      const parsed = tableParsed ?? viewParsed!;
      const conn = connectionsRef.current.find((item) => item.config.id === parsed.connId);
      if (conn && connectionHasTableSchemaChildren(conn.config)) {
        updateExpanded((prev) => {
          const next = new Set(prev);
          next.add(tableColumnsFolderId(id));
          if (tableParsed) {
            next.add(tableIndexesFolderId(id));
          }
          return next;
        });

        const db = conn.databases?.find((item) => item.name === parsed.dbName);
        const object =
          (tableParsed
            ? db?.tables?.find((item) => item.name === parsed.tableName)
            : db?.views?.find((item) => item.name === parsed.tableName)) ?? undefined;
        const nodeRefreshing = Boolean(useDbSchemaCacheStore.getState().refreshingNodeIds[id]);
        if (tableDetailsNeedLoad(object ?? {}) && !nodeRefreshing) {
          void refreshAndApplySchemaTreeNode(
            conn.config,
            tableParsed
              ? buildTableTreeItem(parsed.connId, parsed.dbName, parsed.tableName)
              : buildViewTreeItem(parsed.connId, parsed.dbName, parsed.tableName),
            schemaRefreshHooks,
          ).catch((err) => {
            schemaCacheReporter.onError?.(String(err));
          });
        }
      }
    }
  }, [schemaCacheReporter, schemaRefreshHooks, showTableSchemaChildren, updateExpanded]);

  /** 双击对象文件夹（表 / 视图 / 其他）：已展开则收起，否则展开。 */
  const expandObjectFolderOnActivate = useCallback(
    (folderNodeId: string) => {
      updateExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(folderNodeId)) {
          next.delete(folderNodeId);
        } else {
          next.add(folderNodeId);
        }
        return next;
      });
    },
    [updateExpanded],
  );

  /** 双击库名：已展开则收起；未展开则展开，若二层只有一个对象文件夹则继续展开。 */
  const expandDatabaseOnActivate = useCallback(
    (connId: string, dbName: string, dbNodeId: string) => {
      void (async () => {
        const expanded = useDbSchemaTreeExpandedStore.getState().expandedNodeIds;
        if (expanded.has(dbNodeId)) {
          updateExpanded((prev) => {
            if (!prev.has(dbNodeId)) {
              return prev;
            }
            const next = new Set(prev);
            next.delete(dbNodeId);
            return next;
          });
          return;
        }

        updateExpanded((prev) => {
          const next = new Set(prev);
          next.add(dbNodeId);
          return next;
        });

        const conn = connectionsRef.current.find((item) => item.config.id === connId);
        if (!conn || !isConnectionEnabled(conn.config)) {
          return;
        }

        let db =
          conn.databases?.find((item) => item.name === dbName) ??
          useDbSchemaCacheStore.getState().snapshot.connections?.[connId]?.databases?.find(
            (item) => item.name === dbName,
          );

        if (databaseObjectsNeedLoad(db ?? {})) {
          const nodeRefreshing = Boolean(
            useDbSchemaCacheStore.getState().refreshingNodeIds[dbNodeId],
          );
          if (!nodeRefreshing) {
            try {
              await refreshAndApplySchemaTreeNode(
                conn.config,
                buildDatabaseTreeItem(connId, dbName),
                schemaRefreshHooks,
              );
            } catch (err) {
              schemaCacheReporter.onError?.(String(err));
              return;
            }
          }
          db = useDbSchemaCacheStore
            .getState()
            .snapshot.connections?.[connId]?.databases?.find((item) => item.name === dbName);
        }

        const soleFolderId = resolveSoleDatabaseObjectFolderId(connId, dbName, db);
        if (!soleFolderId) {
          return;
        }
        updateExpanded((prev) => {
          if (prev.has(soleFolderId)) {
            return prev;
          }
          const next = new Set(prev);
          next.add(soleFolderId);
          return next;
        });
      })();
    },
    [schemaCacheReporter, schemaRefreshHooks, updateExpanded],
  );

  const handleTreeKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    if (e.key.length !== 1) {
      return;
    }
    e.preventDefault();
    scopedSearchRef.current?.open(e.key);
  }, []);

  const flatRows = useMemo(
    () =>
      buildSchemaFlatRows({
        t,
        connections: search.trim() ? connections : deferredConnections,
        expandedNodeIds,
        childVisibleLimits,
        databaseFilters,
        tableFilters,
        refreshingConnectionIds,
        refreshingNodeIds,
        resolvedTheme,
        searchQuery: search,
        layoutFolders,
        connectionParents,
        deploymentServerByConnId,
        showTableSchemaChildren,
        sqlFiles: sqlFileNodes,
      }),
    [
      t,
      connections,
      deferredConnections,
      expandedNodeIds,
      childVisibleLimits,
      databaseFilters,
      tableFilters,
      refreshingConnectionIds,
      refreshingNodeIds,
      resolvedTheme,
      search,
      layoutFolders,
      connectionParents,
      deploymentServerByConnId,
      showTableSchemaChildren,
      sqlFileNodes,
    ],
  );

  useEffect(() => {
    if (schemaTreeRef.current) {
      schemaTreeRef.current.scrollTop = 0;
    }
  }, [search]);

  const selectableNodeIds = useMemo(
    () =>
      flatRows
        .filter((row): row is Extract<SchemaFlatRow, { kind: "node" }> => row.kind === "node")
        .map((row) => row.item.id),
    [flatRows],
  );


  flatRowsRef.current = flatRows;

  const useTreeVirtualization = flatRows.length > SCHEMA_TREE_VIRTUALIZE_THRESHOLD;

  const rowVirtualizer = useVirtualizer({
    count: useTreeVirtualization ? flatRows.length : 0,
    getScrollElement: () => (useTreeVirtualization ? schemaTreeRef.current : null),
    // 固定行高：勿用 measureElement；所有行统一高度避免区间漂移露白
    estimateSize: () => SCHEMA_TREE_NODE_ROW_HEIGHT,
    getItemKey: (index) => flatRowsRef.current[index]?.key ?? index,
    // 视口约 25 行，overscan 32 上下各缓冲足够覆盖两帧快滚距离（28px×32=896px）。
    // 太小快滚露白；太大 reconcile 开销高。32 是实测平衡点。
    overscan: 32,
    // 底部工作区在看板页仍可能保活挂载；layout 内 flushSync 会刷控制台告警
    useFlushSync: false,
  });
  const rowVirtualizerRef = useRef(rowVirtualizer);
  rowVirtualizerRef.current = rowVirtualizer;

  const virtualRows = useTreeVirtualization ? rowVirtualizer.getVirtualItems() : [];

  // 固定行高虚拟列表无需在每次 flatRows.length 变化时 measure()（会重置 scrollTop）。
  // 仅在进入虚拟滚动模式时测一次滚动容器。
  useEffect(() => {
    if (!useTreeVirtualization) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      rowVirtualizerRef.current.measure();
    });
    return () => cancelAnimationFrame(raf);
  }, [useTreeVirtualization]);

  // 滚动中给容器加 is-scrolling class，动态启用 will-change: transform。
  // 静态 will-change 会为所有虚拟行创建合成层，浪费 GPU 内存；仅在滚动中启用。
  useEffect(() => {
    const el = schemaTreeRef.current;
    if (!el || !useTreeVirtualization) return;
    let scrollTimer: number | null = null;
    const onScroll = () => {
      if (!el.classList.contains("is-scrolling")) {
        el.classList.add("is-scrolling");
      }
      if (scrollTimer != null) window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => {
        el.classList.remove("is-scrolling");
        scrollTimer = null;
      }, 120);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (scrollTimer != null) window.clearTimeout(scrollTimer);
      el.classList.remove("is-scrolling");
    };
  }, [useTreeVirtualization]);

  const hasAnyConnection = connections.length > 0;

  const sidebarScrollTargetId = useMemo(
    () =>
      resolveSchemaTreeScrollTarget({
        activeTableKey,
        activeDatabaseKey,
        activeConnId,
      }),
    [activeTableKey, activeDatabaseKey, activeConnId],
  );

  const lastLinkageScrollRef = useRef<{ targetId: string; rowIndex: number } | null>(null);
  /** 树上单击/双击/展开由用户发起时抑制随后的 Tab 联动滚动，避免光标下节点被拽走导致双击点偏 */
  const suppressLinkageScrollRef = useRef(false);

  const markTreeUserInteraction = useCallback(() => {
    suppressLinkageScrollRef.current = true;
  }, []);

  // 先展开祖先（layout 阶段同步，保证随后 scroll 能立刻找到节点）
  useLayoutEffect(() => {
    if (!sidebarScrollTargetId || loading || search.trim()) {
      return;
    }
    const expandIds = collectExpandedIdsForScrollTarget(sidebarScrollTargetId);
    updateExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of expandIds) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sidebarScrollTargetId, loading, search, updateExpanded]);

  // flatRows 就绪后定位：延后到 paint 后，避免 getBoundingClientRect + scrollToIndex
  // 强制 reflow 阻塞首帧 paint。updateExpanded（上方 useLayoutEffect）已同步展开祖先并
  // 重建 flatRows，此处 useEffect 运行时 flatRows 已是最新。
  useEffect(() => {
    if (!sidebarScrollTargetId || search.trim()) {
      if (!sidebarScrollTargetId) {
        lastLinkageScrollRef.current = null;
      }
      return;
    }
    // loading 闪烁时不要清空 last：否则恢复后会被当成新目标再次滚动
    if (loading) {
      return;
    }
    const container = schemaTreeRef.current;
    if (!container) {
      return;
    }
    const rowIndex = findSchemaFlatRowIndexByNodeId(flatRows, sidebarScrollTargetId);
    if (rowIndex < 0) {
      return;
    }

    const last = lastLinkageScrollRef.current;
    // 同一目标已处理过：用户可能已手动滚动，禁止再拽回去
    if (last?.targetId === sidebarScrollTargetId) {
      lastLinkageScrollRef.current = { targetId: sidebarScrollTargetId, rowIndex };
      return;
    }

    // 用户刚在树上操作（选中/打开）：节点已在指针下，禁止联动滚动
    if (suppressLinkageScrollRef.current) {
      suppressLinkageScrollRef.current = false;
      lastLinkageScrollRef.current = { targetId: sidebarScrollTargetId, rowIndex };
      return;
    }

    if (isSchemaFlatRowIndexInViewport(container, flatRows, rowIndex)) {
      lastLinkageScrollRef.current = { targetId: sidebarScrollTargetId, rowIndex };
      return;
    }

    scrollSchemaFlatRowIntoView(
      container,
      flatRowsRef.current,
      rowIndex,
      useTreeVirtualization
        ? (index) =>
            rowVirtualizerRef.current.scrollToIndex(index, { align: "auto", behavior: "auto" })
        : undefined,
    );
    lastLinkageScrollRef.current = { targetId: sidebarScrollTargetId, rowIndex };
  }, [sidebarScrollTargetId, loading, search, flatRows, useTreeVirtualization]);

  const updatePathForNodeId = useCallback((nodeId: string) => {
    pathFocusNodeIdRef.current = nodeId;
    const next = collectSchemaPathCrumbsForNodeId(flatRowsRef.current, nodeId);
    setPathCrumbs((prev) => {
      if (
        prev.length === next.length &&
        prev.every((crumb, index) => crumb.row.key === next[index]?.row.key)
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  // 切 Tab：crumb 跟随激活目标
  useEffect(() => {
    if (!sidebarScrollTargetId || search.trim() || loading) {
      return;
    }
    updatePathForNodeId(sidebarScrollTargetId);
  }, [sidebarScrollTargetId, search, loading, updatePathForNodeId]);

  // 树展开 / 数据变化后，按当前 focus 补全 crumb（可能是 Tab 目标，也可能是树上点过的节点）
  useEffect(() => {
    if (search.trim()) {
      setPathCrumbs((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const focusId = pathFocusNodeIdRef.current;
    if (!focusId) {
      return;
    }
    const next = collectSchemaPathCrumbsForNodeId(flatRows, focusId);
    if (next.length === 0) {
      return;
    }
    setPathCrumbs((prev) => {
      if (
        prev.length === next.length &&
        prev.every((crumb, index) => crumb.row.key === next[index]?.row.key)
      ) {
        return prev;
      }
      return next;
    });
  }, [flatRows, search]);

  const handlePathCrumbClick = useCallback(
    (rowIndex: number) => {
      const container = schemaTreeRef.current;
      const row = flatRowsRef.current[rowIndex];
      if (row?.kind !== "node") {
        return;
      }

      updatePathForNodeId(row.item.id);

      const connection = row.item.connId
        ? connectionsRef.current.find((entry) => entry.config.id === row.item.connId)?.config
        : undefined;

      if (row.labelClickKind === "connection" && row.labelClickConnId) {
        onSelectConnection?.(row.labelClickConnId, "permanent");
      } else if (
        row.labelClickKind === "database" &&
        row.labelClickConnId &&
        row.labelClickDbName &&
        connection
      ) {
        onSelectDatabase?.(
          {
            connId: row.labelClickConnId,
            dbName: row.labelClickDbName,
            connection,
          },
          "permanent",
        );
      } else if (
        row.labelClickKind === "table" &&
        row.labelClickConnId &&
        row.labelClickDbName &&
        row.labelClickTableName &&
        connection
      ) {
        onSelectTable?.(
          {
            connId: row.labelClickConnId,
            dbName: row.labelClickDbName,
            tableName: row.labelClickTableName,
            connection,
          },
          "permanent",
        );
      } else if (row.labelClickKind === "sql-query" && row.labelClickSqlFileId) {
        const file = sqlFilesRef.current.find((entry) => entry.id === row.labelClickSqlFileId);
        if (file) {
          onOpenSqlFile?.(file);
        }
      }

      if (!container) {
        return;
      }
      // crumb 主动导航：滚入视野即可，不强制居中
      lastLinkageScrollRef.current = { targetId: row.item.id, rowIndex };
      scrollSchemaFlatRowIntoView(
        container,
        flatRowsRef.current,
        rowIndex,
        useTreeVirtualization
          ? (index) =>
              rowVirtualizerRef.current.scrollToIndex(index, { align: "auto", behavior: "auto" })
          : undefined,
      );
    },
    [onSelectConnection, onSelectDatabase, onSelectTable, onOpenSqlFile, updatePathForNodeId, useTreeVirtualization],
  );

  const filterDialogConn = filterDialogConnId
    ? connections.find((conn) => conn.config.id === filterDialogConnId)
    : undefined;

  const filterDialogTableDb =
    filterDialogTable &&
    connections
      .find((conn) => conn.config.id === filterDialogTable.connId)
      ?.databases?.find((db) => db.name === filterDialogTable.dbName);

  const renderFlatRow = useCallback(
    createRenderSchemaFlatRow({
      t,
      connectionsRef,
      sqlFilesRef,
      search,
      layoutDragOverNodeId,
      layoutDraggingSourceId,
      activeConnId,
      activeTableKey,
      activeDatabaseKey,
      openTabNodeIds,
      loadMoreChildren,
      toggle,
      updateExpanded,
      expandDatabaseOnActivate,
      expandObjectFolderOnActivate,
      onSelectConnection,
      onSelectDatabase,
      onSelectTable,
      onOpenSqlFile,
      resolveSchemaNodeActions,
      handleContextSchemaNode,
      setTableFilters,
      setFilterDialogConnId,
      setFilterDialogTable,
      beginLayoutPointerDrag,
      updatePathForNodeId,
      markTreeUserInteraction,
    }),
    [
      t,
      toggle,
      updateExpanded,
      expandDatabaseOnActivate,
      expandObjectFolderOnActivate,
      onSelectConnection,
      onSelectDatabase,
      onSelectTable,
      onOpenSqlFile,
      resolveSchemaNodeActions,
      handleContextSchemaNode,
      setTableFilters,
      setFilterDialogConnId,
      setFilterDialogTable,
      search,
      layoutDragOverNodeId,
      layoutDraggingSourceId,
      beginLayoutPointerDrag,
      activeConnId,
      activeTableKey,
      activeDatabaseKey,
      openTabNodeIds,
      updatePathForNodeId,
      markTreeUserInteraction,
      loadMoreChildren,
    ],
  );

  const handleCollapseAll = useCallback(() => {
    updateExpanded(() => new Set());
  }, [updateExpanded]);
  return {
    t,
    search,
    setSearch,
    expandedNodeIds,
    anyConnectionRefreshing,
    sidebarRef,
    schemaTreeRef,
    scopedSearchRef,
    pathCrumbs,
    loading,
    loadError,
    hasAnyConnection,
    databaseFilters,
    tableFilters,
    setDatabaseFilters,
    setTableFilters,
    filterDialogConnId,
    setFilterDialogConnId,
    filterDialogTable,
    setFilterDialogTable,
    schemaCtxMenu,
    setSchemaCtxMenu,
    selectableNodeIds,
    handleSelectedIdsChange,
    sidebarHotkeysArmedRef,
    handleHotkeyDelete,
    sidebarScrollTargetId,
    useTreeVirtualization,
    flatRows,
    virtualRows,
    rowVirtualizer,
    renderFlatRow,
    handleTreeKeyDown,
    handleContextLayoutRoot,
    handlePathCrumbClick,
    handleCollapseAll,
    refreshSchemaCache,
    getSchemaTreeContextMenuItems,
    filterDialogConn,
    filterDialogTableDb,
    makeTableFilterKey,
    mergeFilter,
    applyTablePinOrder,
  };
}
