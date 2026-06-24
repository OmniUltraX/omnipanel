import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type CSSProperties,
} from "react";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import { ScopedSearch, type ScopedSearchHandle } from "../../components/ui/ScopedSearch";
import {
  type DbConnectionConfig,
  listConnections,
  isConnectionEnabled,
  connectionHasTableSchemaChildren,
  isRedisConnection,
} from "./api";
import { useDbSchemaFilterStore } from "../../stores/dbSchemaFilterStore";
import { useDbSchemaTreeExpandedStore } from "../../stores/dbSchemaTreeExpandedStore";
import { useDbSchemaCacheStore } from "../../stores/dbSchemaCacheStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { getEngineIconByType } from "./engineIcons";
import {
  DatabaseFilterDialog,
  getVisibleItems,
  makeTableFilterKey,
  mergeFilter,
  applyTablePinOrder,
  isTablePinned,
  toggleTablePin,
  SchemaFilterDialog,
} from "./DatabaseFilterDialog";
import {
  buildConnectionTreeItem,
  buildDatabaseTreeItem,
  buildFolderTreeItem,
  type SchemaTreeItem,
} from "./schemaTreeItem";
import {
  nextSchemaChildLimit,
  paginateSchemaChildren,
} from "./schemaTreePagination";
import { mergeConnectionsWithCache, type CachedConnection, type CachedDatabase } from "./schemaCacheMerge";
import { refreshAllSchemaCache } from "./schemaCacheRefresh";
import {
  createSchemaCacheRefreshReporter,
  publishSchemaNodeRefreshDone,
  publishSchemaNodeRefreshFailed,
  publishSchemaNodeRefreshStart,
} from "./schemaCacheStatusLog";
import type { SchemaCacheSnapshot } from "./schemaCache";
import { textSearchMatches } from "../../lib/textSearchMatch";
import {
  connectionDatabasesFolderId,
  connectionUsersFolderId,
  databaseOtherFolderId,
  databaseTablesFolderId,
  databaseViewsFolderId,
  formatUserLabel,
  makeDatabaseNodeId,
  parseTableNodeId,
  parseViewNodeId,
  routineNodeId,
  userNodeId,
  SCHEMA_ROOT_CONNECTIONS_ID,
} from "./schemaTreeIds";
import { SchemaTreeObjectDetails } from "./schemaTreeObjectDetails";
import type { SchemaSidebarSectionConfig } from "./SchemaSidebarSection";
import { SchemaSidebarSection } from "./SchemaSidebarSection";
import {
  buildPaginationPatchesForScrollTarget,
  collectExpandedIdsForScrollTarget,
  resolveSchemaTreeScrollTarget,
  scrollSchemaTreeToNode,
} from "./schemaTreeSidebarLinkage";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/ContextMenu";
import type { SchemaCacheConnectionEntry } from "./schemaCache";
import {
  refreshAndApplySchemaTreeNode,
  type SchemaTreeRefreshHooks,
} from "./schemaTreeRefresh";

type LoadedDatabase = CachedDatabase;

type LoadedConnection = CachedConnection;

interface TreeNodeProps {
  item: SchemaTreeItem;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  meta?: string;
  isPk?: boolean;
  isFk?: boolean;
  hasChildren: boolean;
  active?: boolean;
  onSelect?: () => void;
  onLabelClick?: () => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
  iconUrl?: string | null;
  onMetaClick?: () => void;
  metaTitle?: string;
  pinActive?: boolean;
  onPinToggle?: () => void;
  /** 表节点：名称后显示的灰色注释 */
  labelComment?: string;
  /** 连接节点：是否启用（禁用与树折叠无关） */
  connectionEnabled?: boolean;
}

function SchemaLoadMoreButton({
  depth,
  remaining,
  onClick,
  label,
}: {
  depth: number;
  remaining: number;
  onClick: () => void;
  label: string;
}) {
  const indent = depth * 16 + 8;
  return (
    <button
      type="button"
      className="schema-load-more-btn"
      style={{ paddingLeft: indent }}
      onClick={onClick}
    >
      {label}
      {remaining > 0 ? ` (${remaining})` : ""}
    </button>
  );
}

function TreeNode({
  item,
  depth,
  expanded,
  onToggle,
  meta,
  isPk,
  isFk,
  hasChildren,
  active,
  onSelect,
  onLabelClick,
  onContextMenu,
  iconUrl,
  onMetaClick,
  metaTitle,
  pinActive,
  onPinToggle,
  labelComment,
  connectionEnabled = true,
}: TreeNodeProps) {
  const { t } = useI18n();
  const { type, label } = item;
  const indent = depth * 16 + 8;
  const isConnection = type === "connection";
  const connectionStateClass = isConnection
    ? connectionEnabled
      ? " tree-node--connection-enabled"
      : " tree-node--connection-disabled"
    : "";

  const runLabelClick = () => {
    if (onLabelClick) {
      onLabelClick();
      return;
    }
    if (!hasChildren) {
      onSelect?.();
      return;
    }
    onToggle();
  };

  const handleLabelClick = () => {
    runLabelClick();
  };

  const stickyClass = hasChildren && expanded ? " tree-node--sticky" : "";
  const nodeStyle: CSSProperties = {
    paddingLeft: indent,
    ["--tree-depth" as string]: depth,
  };

  return (
    <div
      className={`tree-node tree-node--${type}${active ? " tree-node--active" : ""}${connectionStateClass}${stickyClass}`}
      style={nodeStyle}
      data-schema-item-type={type}
      data-schema-node-id={item.id}
      onContextMenu={onContextMenu}
    >
      <span
        className={`tree-arrow${hasChildren ? "" : " tree-leaf"}${expanded ? " tree-arrow--open" : ""}`}
        onClick={(event) => {
          event.stopPropagation();
          if (hasChildren) {
            onToggle();
          }
        }}
      >
        {hasChildren ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
            <path d="M9 18l6-6-6-6" />
          </svg>
        ) : (
          <span className="tree-dot" />
        )}
      </span>
      <span className="tree-icon">
        {type === "connection" ? (
          iconUrl ? (
            <img src={iconUrl} alt="" className="tree-engine-logo" draggable={false} />
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13">
              <rect x="2" y="2" width="20" height="8" rx="2" />
              <rect x="2" y="14" width="20" height="8" rx="2" />
              <circle cx="6" cy="6" r="1" fill="currentColor" />
              <circle cx="6" cy="18" r="1" fill="currentColor" />
            </svg>
          )
        ) : null}
        {type === "database" && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
          </svg>
        )}
        {type === "table" && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M3 15h18M9 3v18" />
          </svg>
        )}
        {type === "view" && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13">
            <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
        {type === "user" && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13">
            <circle cx="12" cy="8" r="3" />
            <path d="M5 20a7 7 0 0114 0" />
          </svg>
        )}
        {type === "routine" && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13">
            <path d="M10 3h4" />
            <path d="M12 3v6" />
            <path d="M6 14h12" />
            <path d="M8 18h8" />
          </svg>
        )}
        {(type === "folder" || type === "group") && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
        )}
        {type === "column" && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13">
            <path d="M12 2v20" />
            <path d="M2 12h20" />
          </svg>
        )}
        {type === "index" && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13">
            <path d="M4 6h16M4 10h10M4 14h14M4 18h8" />
          </svg>
        )}
      </span>
      {isConnection && (
        <span
          className={`tree-conn-status${connectionEnabled ? " tree-conn-status--enabled" : " tree-conn-status--disabled"}`}
          title={
            connectionEnabled
              ? t("database.sidebar.connectionEnabled")
              : t("database.sidebar.connectionDisabled")
          }
          aria-hidden
        />
      )}
      <span
        className="tree-label"
        onClick={handleLabelClick}
      >
        <span className="tree-label-name">{label}</span>
        {labelComment ? (
          <span className="tree-label-comment" title={labelComment}>
            {labelComment}
          </span>
        ) : null}
      </span>
      {isPk && <span className="tree-badge tree-badge--pk">PK</span>}
      {isFk && <span className="tree-badge tree-badge--fk">FK</span>}
      {onPinToggle ? (
        <button
          type="button"
          className={`tree-pin-btn${pinActive ? " tree-pin-btn--active" : ""}`}
          title={
            pinActive ? t("database.sidebar.unpinTable") : t("database.sidebar.pinTable")
          }
          aria-label={
            pinActive ? t("database.sidebar.unpinTable") : t("database.sidebar.pinTable")
          }
          aria-pressed={pinActive}
          onClick={(event) => {
            event.stopPropagation();
            onPinToggle();
          }}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12" aria-hidden>
            <path d="M9.5 1.5 8 3 6.5 1.5 5 3v4.6L2.8 9.8l-.3.3v1.4l.3.3L5 12.9V14l1.5-1.5L8 14l1.5-1.5L11 14v-1.1l2.2-2.2.3-.3v-1.4l-.3-.3L11 7.6V3L9.5 1.5Z" />
          </svg>
        </button>
      ) : null}
      {!onPinToggle && meta ? (
        <span
          className={`tree-meta${onMetaClick ? " tree-meta--clickable" : ""}`}
          title={metaTitle}
          onClick={
            onMetaClick
              ? (event) => {
                  event.stopPropagation();
                  onMetaClick();
                }
              : undefined
          }
        >
          {meta}
        </span>
      ) : null}
    </div>
  );
}

function routineTypeLabel(t: (key: string) => string, routineType: string): string {
  switch (routineType.toLowerCase()) {
    case "procedure":
      return t("database.sidebar.routineProcedure");
    case "function":
      return t("database.sidebar.routineFunction");
    case "trigger":
      return t("database.sidebar.routineTrigger");
    default:
      return routineType;
  }
}

export { makeDatabaseNodeId } from "./schemaTreeIds";

function tableColumnsFolderId(tableId: string) {
  return `${tableId}:cols`;
}

function tableIndexesFolderId(tableId: string) {
  return `${tableId}:idxs`;
}

function schemaNodeMeta(
  refreshingNodeIds: Record<string, true>,
  nodeId: string,
  meta: string | undefined,
  loadingLabel: string,
): string | undefined {
  return refreshingNodeIds[nodeId] ? loadingLabel : meta;
}

export type SchemaTableSelection = {
  connId: string;
  dbName: string;
  tableName: string;
  connection: DbConnectionConfig;
};

export type SchemaDatabaseSelection = {
  connId: string;
  dbName: string;
  connection: DbConnectionConfig;
};

function syncFiltersFromSnapshot(
  snapshot: SchemaCacheSnapshot,
  syncDatabaseFilter: (connId: string, names: string[]) => void,
  syncTableFilter: (connId: string, dbName: string, names: string[]) => void,
) {
  for (const [connId, entry] of Object.entries(snapshot.connections)) {
    if (entry.databases.length > 0) {
      syncDatabaseFilter(connId, entry.databases.map((db) => db.name));
    }
    for (const db of entry.databases) {
      if (db.tables.length > 0) {
        syncTableFilter(connId, db.name, db.tables.map((table) => table.name));
      }
    }
  }
}

export type SchemaContextMenuContext = {
  connection?: DbConnectionConfig;
  tableSelection?: SchemaTableSelection;
};

export interface SchemaBrowserProps {
  activeConnId?: string | null;
  onCreateConnection?: () => void;
  onSelectConnection?: (connId: string) => void;
  onSelectTable?: (selection: SchemaTableSelection) => void;
  onSelectDatabase?: (selection: SchemaDatabaseSelection) => void;
  buildSchemaContextMenuItems?: (
    item: SchemaTreeItem,
    context: SchemaContextMenuContext,
  ) => ContextMenuItem[];
  onSchemaCacheConnectionPatched?: (connId: string, entry: SchemaCacheConnectionEntry) => void;
  activeTableKey?: string | null;
  activeDatabaseKey?: string | null;
  refreshToken?: number;
  section?: SchemaSidebarSectionConfig;
  /** 由 DatabasePanel 注入，避免重复 listConnections 与 remount 后空白加载 */
  connectionConfigs?: DbConnectionConfig[];
  connectionsReady?: boolean;
}

export function SchemaBrowser({
  activeConnId = null,
  onCreateConnection,
  onSelectConnection,
  onSelectTable,
  onSelectDatabase,
  buildSchemaContextMenuItems,
  onSchemaCacheConnectionPatched,
  activeTableKey = null,
  activeDatabaseKey = null,
  refreshToken = 0,
  section,
  connectionConfigs,
  connectionsReady,
}: SchemaBrowserProps) {
  const { t } = useI18n();
  const resolvedTheme = useSettingsStore((s) => s.resolved);
  const useExternalConnections =
    connectionConfigs !== undefined && connectionsReady !== undefined;
  const [search, setSearch] = useState("");
  const searchActive = search.trim().length > 0;
  const paginateOpts = searchActive ? { unpaginated: true as const } : undefined;
  const stickyAncestors = useMemo(() => !searchActive, [searchActive]);
  const expandedNodeIds = useDbSchemaTreeExpandedStore((s) => s.expandedNodeIds);
  const expandedHydrated = useDbSchemaTreeExpandedStore((s) => s.hydrated);
  const hydrateSchemaExpanded = useDbSchemaTreeExpandedStore((s) => s.hydrate);
  const updateExpanded = useDbSchemaTreeExpandedStore((s) => s.updateExpanded);
  const [childVisibleLimits, setChildVisibleLimits] = useState<Record<string, number>>({});
  const [internalConnections, setInternalConnections] = useState<LoadedConnection[]>([]);
  const [internalLoading, setInternalLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const databaseFilters = useDbSchemaFilterStore((s) => s.databaseFilters);
  const tableFilters = useDbSchemaFilterStore((s) => s.tableFilters);
  const filtersHydrated = useDbSchemaFilterStore((s) => s.hydrated);
  const hydrateSchemaFilters = useDbSchemaFilterStore((s) => s.hydrate);
  const setDatabaseFilters = useDbSchemaFilterStore((s) => s.setDatabaseFilters);
  const setTableFilters = useDbSchemaFilterStore((s) => s.setTableFilters);
  const [filterDialogConnId, setFilterDialogConnId] = useState<string | null>(null);
  const [filterDialogTable, setFilterDialogTable] = useState<{ connId: string; dbName: string } | null>(
    null
  );
  const [schemaCtxMenu, setSchemaCtxMenu] = useState<
    | {
        x: number;
        y: number;
        item: SchemaTreeItem;
        connection?: DbConnectionConfig;
        tableSelection?: SchemaTableSelection;
      }
    | null
  >(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const schemaTreeRef = useRef<HTMLDivElement>(null);
  const scopedSearchRef = useRef<ScopedSearchHandle>(null);
  const replaceSchemaSnapshot = useDbSchemaCacheStore((s) => s.replaceSnapshot);
  const schemaSnapshot = useDbSchemaCacheStore((s) => s.snapshot);
  const refreshingConnectionIds = useDbSchemaCacheStore((s) => s.refreshingConnectionIds);
  const refreshingNodeIds = useDbSchemaCacheStore((s) => s.refreshingNodeIds);
  const anyConnectionRefreshing = Object.keys(refreshingConnectionIds).length > 0;
  const syncSeqRef = useRef(0);
  const connectionsRef = useRef<LoadedConnection[]>([]);

  const externalConnections = useMemo(() => {
    if (!useExternalConnections) {
      return null;
    }
    if (!connectionsReady) {
      return null;
    }
    return mergeConnectionsWithCache(connectionConfigs, schemaSnapshot, connectionsRef.current);
  }, [useExternalConnections, connectionConfigs, connectionsReady, schemaSnapshot]);

  const connections = useExternalConnections ? (externalConnections ?? []) : internalConnections;
  const loading = useExternalConnections ? externalConnections === null : internalLoading;

  const syncDatabaseFilter = useCallback((connId: string, names: string[]) => {
    setDatabaseFilters((prev) => ({
      ...prev,
      [connId]: mergeFilter(prev[connId], names),
    }));
  }, []);

  const syncTableFilter = useCallback((connId: string, dbName: string, names: string[]) => {
    const key = makeTableFilterKey(connId, dbName);
    setTableFilters((prev) => ({
      ...prev,
      [key]: mergeFilter(prev[key], names),
    }));
  }, []);

  const schemaRefreshHooks = useMemo<SchemaTreeRefreshHooks>(
    () => ({
      syncDatabaseFilter,
      syncTableFilter,
      onConnectionPatched: onSchemaCacheConnectionPatched,
    }),
    [syncDatabaseFilter, syncTableFilter, onSchemaCacheConnectionPatched],
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

  const buildSchemaTreeContextMenuItems = useCallback((): ContextMenuItem[] => {
    if (!schemaCtxMenu) {
      return [];
    }
    const { item, connection } = schemaCtxMenu;
    const extra =
      buildSchemaContextMenuItems?.(item, {
        connection,
        tableSelection: schemaCtxMenu.tableSelection,
      }) ?? [];
    const refreshIcon = (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M2 8a6 6 0 0 1 10.5-3.9" />
        <path d="M14 2v3h-3" />
        <path d="M14 8a6 6 0 0 1-10.5 3.9" />
        <path d="M2 14v-3h3" />
      </svg>
    );
    const connRefreshing = connection ? Boolean(refreshingNodeIds[item.id]) : false;
    const canRefresh = Boolean(connection && isConnectionEnabled(connection));
    const refreshItem: ContextMenuItem = {
      id: "refresh-schema-node",
      label: t("common.refresh"),
      icon: refreshIcon,
      disabled: !canRefresh || connRefreshing,
      onClick: () => {
        if (connection) {
          publishSchemaNodeRefreshStart(t, item.label);
          void refreshAndApplySchemaTreeNode(connection, item, schemaRefreshHooks)
            .then(() => publishSchemaNodeRefreshDone(t, item.label))
            .catch((err) => publishSchemaNodeRefreshFailed(t, item.label, String(err)));
        }
      },
    };
    if (extra.length === 0) {
      return [refreshItem];
    }
    return [...extra, { id: "sep-refresh", label: "", separator: true }, refreshItem];
  }, [
    buildSchemaContextMenuItems,
    refreshingNodeIds,
    schemaCtxMenu,
    schemaRefreshHooks,
    t,
  ]);

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
    let enabledConnIds: string[] = [];
    const { setConnectionRefreshing } = useDbSchemaCacheStore.getState();
    try {
      const list = await listConnections();
      enabledConnIds = list.filter(isConnectionEnabled).map((conn) => conn.id);
      for (const connId of enabledConnIds) {
        setConnectionRefreshing(connId, true);
      }
      const snapshot = await refreshAllSchemaCache(schemaCacheReporter);
      await replaceSchemaSnapshot(snapshot);
      const merged = mergeConnectionsWithCache(list, snapshot, connectionsRef.current);
      connectionsRef.current = merged;
      setInternalConnections(merged);
      syncFiltersFromSnapshot(snapshot, syncDatabaseFilter, syncTableFilter);
    } catch (error) {
      schemaCacheReporter.onError?.(String(error));
      setLoadError(String(error));
    } finally {
      for (const connId of enabledConnIds) {
        setConnectionRefreshing(connId, false);
      }
    }
  }, [replaceSchemaSnapshot, schemaCacheReporter, syncDatabaseFilter, syncTableFilter]);

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

  const toggle = (id: string) => {
    if (id.startsWith("conn:")) {
      const connId = id.slice(5);
      const conn = connectionsRef.current.find((item) => item.config.id === connId);
      if (conn && !isConnectionEnabled(conn.config)) {
        return;
      }
    }

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

    const tableParsed = parseTableNodeId(id);
    const viewParsed = parseViewNodeId(id);
    if (tableParsed || viewParsed) {
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
      }
    }
  };

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

  const filtered = useMemo(() => {
    if (!search.trim()) {
      return connections;
    }

    const q = search.trim();
    const objectMatchesQuery = (name: string, comment?: string) =>
      textSearchMatches(q, name) || (comment ? textSearchMatches(q, comment) : false);

    return connections
      .map((conn) => {
        const nameMatch = textSearchMatches(q, conn.config.name);
        const allUsers = conn.users ?? [];
        const users = nameMatch
          ? allUsers
          : allUsers.filter(
              (user) =>
                textSearchMatches(q, user.name) ||
                (user.host ? textSearchMatches(q, user.host) : false) ||
                textSearchMatches(q, formatUserLabel(user.name, user.host)),
            );

        const allDatabases = conn.databases ?? [];
        const visibleDatabases = getVisibleItems(allDatabases, databaseFilters[conn.config.id]);
        const databases = visibleDatabases
          .map((db) => {
            const dbMatch = nameMatch || textSearchMatches(q, db.name);
            if (isRedisConnection(conn.config)) {
              return dbMatch ? db : null;
            }
            const allTables = db.tables ?? [];
            const visibleTables = getVisibleItems(
              allTables,
              tableFilters[makeTableFilterKey(conn.config.id, db.name)],
            );
            const tables = dbMatch
              ? visibleTables
              : visibleTables.filter((table) => objectMatchesQuery(table.name, table.comment));

            const allViews = db.views ?? [];
            const views = dbMatch
              ? allViews
              : allViews.filter((view) => objectMatchesQuery(view.name, view.comment));

            const allRoutines = db.routines ?? [];
            const routines = dbMatch
              ? allRoutines
              : allRoutines.filter((routine) => objectMatchesQuery(routine.name));

            if (dbMatch) {
              return db;
            }
            if (tables.length > 0 || views.length > 0 || routines.length > 0) {
              return { ...db, tables, views, routines };
            }
            return null;
          })
          .filter((db): db is LoadedDatabase => db !== null);

        if (nameMatch) {
          return conn;
        }
        if (isRedisConnection(conn.config)) {
          if (databases.length > 0) {
            return { ...conn, databases, users: [] };
          }
          return null;
        }
        if (databases.length > 0 || users.length > 0) {
          return {
            ...conn,
            databases: databases.length > 0 ? databases : [],
            users: users.length > 0 ? users : [],
          };
        }
        return null;
      })
      .filter((conn): conn is LoadedConnection => conn !== null);
  }, [connections, search, databaseFilters, tableFilters]);

  const pagedRootConns = useMemo(
    () => paginateSchemaChildren(filtered, SCHEMA_ROOT_CONNECTIONS_ID, childVisibleLimits, paginateOpts),
    [filtered, childVisibleLimits, paginateOpts],
  );

  const hasAnyConnection = filtered.length > 0;

  const sidebarScrollTargetId = useMemo(
    () =>
      resolveSchemaTreeScrollTarget({
        activeTableKey,
        activeDatabaseKey,
        activeConnId,
      }),
    [activeTableKey, activeDatabaseKey, activeConnId],
  );

  const sidebarLinkageRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!sidebarScrollTargetId || loading || search.trim()) {
      return;
    }

    if (sidebarLinkageRafRef.current != null) {
      cancelAnimationFrame(sidebarLinkageRafRef.current);
    }

    sidebarLinkageRafRef.current = requestAnimationFrame(() => {
      sidebarLinkageRafRef.current = null;

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

      if (connections.length === 0) {
        return;
      }

      setChildVisibleLimits((prev) => {
        const patch = buildPaginationPatchesForScrollTarget(
          sidebarScrollTargetId,
          {
            connections,
            databaseFilters,
            tableFilters,
          },
          prev,
        );
        if (Object.keys(patch).length === 0) {
          return prev;
        }
        return { ...prev, ...patch };
      });
    });

    return () => {
      if (sidebarLinkageRafRef.current != null) {
        cancelAnimationFrame(sidebarLinkageRafRef.current);
      }
    };
  }, [
    sidebarScrollTargetId,
    loading,
    search,
    activeConnId,
    connections,
    databaseFilters,
    tableFilters,
    updateExpanded,
  ]);

  useLayoutEffect(() => {
    if (!sidebarScrollTargetId || loading || search.trim()) {
      return;
    }
    const container = schemaTreeRef.current;
    if (!container) {
      return;
    }
    scrollSchemaTreeToNode(container, sidebarScrollTargetId);
  }, [sidebarScrollTargetId, loading, search, expandedNodeIds, childVisibleLimits]);

  const filterDialogConn = filterDialogConnId
    ? connections.find((conn) => conn.config.id === filterDialogConnId)
    : undefined;

  const filterDialogTableDb =
    filterDialogTable &&
    connections
      .find((conn) => conn.config.id === filterDialogTable.connId)
      ?.databases?.find((db) => db.name === filterDialogTable.dbName);

  const toolbar = (
    <div className="schema-toolbar schema-toolbar--inline">
      <Button
        variant="icon"
        title={t("database.sidebar.createConnection")}
        onClick={onCreateConnection}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </Button>
      <Button
        variant="icon"
        title={t("database.sidebar.refresh")}
        disabled={anyConnectionRefreshing}
        onClick={() => void refreshSchemaCache()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <path d="M23 4v6h-6M1 20v-6h6" />
          <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
        </svg>
      </Button>
    </div>
  );

  const panelBody = (
    <div className="schema-browser" ref={sidebarRef}>
      {!section && toolbar}
      <ScopedSearch
        ref={scopedSearchRef}
        className="schema-tree-scoped-search"
        value={search}
        onChange={setSearch}
        placeholder={t("database.sidebar.search")}
        enabled={filterDialogConnId === null && filterDialogTable === null}
      >
        <div
          className={`schema-tree${stickyAncestors ? " schema-tree--sticky-ancestors" : ""}`}
          ref={schemaTreeRef}
          tabIndex={-1}
          onKeyDown={handleTreeKeyDown}
        >
        {loading && (
          <div style={{ padding: "12px 16px", fontSize: "12px", color: "var(--text-secondary, #8e8e93)" }}>
            {t("common.loading")}
          </div>
        )}
        {!loading && loadError && (
          <div style={{ padding: "12px 16px", fontSize: "12px", color: "var(--color-danger, #ff3b30)" }}>
            {t("database.sidebar.loadFailed")}: {loadError}
          </div>
        )}
        {!loading && !loadError && !hasAnyConnection && (
          <div style={{ padding: "12px 16px", fontSize: "12px", color: "var(--text-secondary, #8e8e93)" }}>
            {t("database.sidebar.empty")}
          </div>
        )}
        {!loading && !loadError && pagedRootConns.visible.map((conn) => {
          const connId = `conn:${conn.config.id}`;
          const connExpanded = searchActive || expandedNodeIds.has(connId);
          const databasesFolderId = connectionDatabasesFolderId(conn.config.id);
          const allDatabases = conn.databases ?? [];
          const filter = databaseFilters[conn.config.id];
          const visibleDatabases = getVisibleItems(allDatabases, filter);
          const visibleCount = visibleDatabases.length;
          const totalCount = allDatabases.length;
          const isFiltered = totalCount > 0 && visibleCount < totalCount;
          const pagedDatabases = paginateSchemaChildren(
            visibleDatabases,
            databasesFolderId,
            childVisibleLimits,
            paginateOpts,
          );

          const engineIconUrl = getEngineIconByType(conn.config.db_type, resolvedTheme);
          const connItem = buildConnectionTreeItem(conn.config.id, conn.config.name, conn.config.db_type);
          const connEnabled = isConnectionEnabled(conn.config);
          const fullConnRefreshing =
            connEnabled && Boolean(refreshingConnectionIds[conn.config.id]);
          const connNodeRefreshing = Boolean(refreshingNodeIds[connId]);

          return (
            <div key={conn.config.id}>
              <TreeNode
                item={connItem}
                depth={0}
                expanded={connExpanded}
                onToggle={() => toggle(connId)}
                active={activeConnId === conn.config.id}
                connectionEnabled={connEnabled}
                onLabelClick={() => onSelectConnection?.(conn.config.id)}
                onContextMenu={(e) => handleContextSchemaNode(connItem, e)}
                iconUrl={engineIconUrl}
                meta={
                  !connEnabled
                    ? t("database.sidebar.connectionDisabled")
                    : fullConnRefreshing || connNodeRefreshing
                      ? t("common.loading")
                      : conn.databases
                        ? isFiltered
                          ? `${visibleCount}/${totalCount} DB`
                          : `${totalCount} DB`
                        : t("database.sidebar.cacheEmpty")
                }
                onMetaClick={
                  connEnabled &&
                  !fullConnRefreshing &&
                  !connNodeRefreshing &&
                  conn.databases &&
                  totalCount > 0
                    ? () => setFilterDialogConnId(conn.config.id)
                    : undefined
                }
                metaTitle={
                  connEnabled &&
                  !fullConnRefreshing &&
                  !connNodeRefreshing &&
                  conn.databases &&
                  totalCount > 0
                    ? t("database.sidebar.filterDisplay")
                    : undefined
                }
                hasChildren={connEnabled}
              />
              {connEnabled && connExpanded && conn.databasesError && (
                <div style={{ padding: "4px 24px", fontSize: "11px", color: "var(--color-danger, #ff3b30)" }}>
                  {conn.databasesError}
                </div>
              )}
              {connEnabled && connExpanded && conn.databases && !fullConnRefreshing && visibleCount === 0 && totalCount > 0 && (
                <div
                  style={{
                    padding: "4px 24px",
                    fontSize: "11px",
                    color: "var(--text-secondary, #8e8e93)",
                  }}
                >
                  {t("database.sidebar.filterHidden")}
                </div>
              )}
              {connEnabled && connExpanded && conn.databases && pagedDatabases.visible.map((db) => {
                  const isRedis = isRedisConnection(conn.config);
                  const dbId = makeDatabaseNodeId(conn.config.id, db.name);
                  const dbExpanded = searchActive || expandedNodeIds.has(dbId);
                  const allTables = db.tables ?? [];
                  const allViews = db.views ?? [];
                  const allRoutines = db.routines ?? [];
                  const tableFilter = tableFilters[makeTableFilterKey(conn.config.id, db.name)];
                  const visibleTables = getVisibleItems(allTables, tableFilter);
                  const tableVisibleCount = visibleTables.length;
                  const tableTotalCount = allTables.length;
                  const isTableFiltered = tableTotalCount > 0 && tableVisibleCount < tableTotalCount;
                  const viewTotalCount = allViews.length;
                  const routineTotalCount = allRoutines.length;
                  const tblsFolderId = databaseTablesFolderId(conn.config.id, db.name);
                  const viewsFolderId = databaseViewsFolderId(conn.config.id, db.name);
                  const otherFolderId = databaseOtherFolderId(conn.config.id, db.name);
                  const tblsExpanded = searchActive || expandedNodeIds.has(tblsFolderId);
                  const viewsExpanded = searchActive || expandedNodeIds.has(viewsFolderId);
                  const otherExpanded = searchActive || expandedNodeIds.has(otherFolderId);
                  const pagedTables = paginateSchemaChildren(
                    visibleTables,
                    tblsFolderId,
                    childVisibleLimits,
                    paginateOpts,
                  );
                  const pagedViews = paginateSchemaChildren(
                    allViews,
                    viewsFolderId,
                    childVisibleLimits,
                    paginateOpts,
                  );
                  const pagedRoutines = paginateSchemaChildren(
                    allRoutines,
                    otherFolderId,
                    childVisibleLimits,
                    paginateOpts,
                  );
                  const dbItem = buildDatabaseTreeItem(conn.config.id, db.name);
                  const dbNodeRefreshing = Boolean(refreshingNodeIds[dbId]);
                  const tblsFolderRefreshing = Boolean(refreshingNodeIds[tblsFolderId]);
                  const viewsFolderRefreshing = Boolean(refreshingNodeIds[viewsFolderId]);
                  const otherFolderRefreshing = Boolean(refreshingNodeIds[otherFolderId]);
                  const showTablesFolder = tableTotalCount > 0 || tblsFolderRefreshing;
                  const showViewsFolder = viewTotalCount > 0 || viewsFolderRefreshing;
                  const showOtherFolder = routineTotalCount > 0 || otherFolderRefreshing;
                  const hasDbObjectFolders = showTablesFolder || showViewsFolder || showOtherFolder;
                  const objectSummary = isRedis
                    ? undefined
                    : [
                    tableTotalCount > 0 ? `${tableTotalCount} ${t("database.sidebar.tables")}` : null,
                    viewTotalCount > 0 ? `${viewTotalCount} ${t("database.sidebar.views")}` : null,
                    routineTotalCount > 0 ? `${routineTotalCount} ${t("database.sidebar.other")}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ");

                  return (
                    <div key={db.name}>
                      <TreeNode
                        item={dbItem}
                        depth={1}
                        expanded={dbExpanded}
                        onToggle={() => toggle(dbId)}
                        active={activeDatabaseKey === dbId}
                        onLabelClick={() => {
                          if (!dbExpanded) {
                            toggle(dbId);
                          }
                          onSelectDatabase?.({
                            connId: conn.config.id,
                            dbName: db.name,
                            connection: conn.config,
                          });
                        }}
                        meta={
                          dbNodeRefreshing
                            ? t("common.loading")
                            : db.loadError
                              ? t("database.sidebar.tablesFailed")
                              : objectSummary || undefined
                        }
                        hasChildren={!isRedis && (hasDbObjectFolders || Boolean(db.loadError))}
                        onContextMenu={(e) => handleContextSchemaNode(dbItem, e)}
                      />
                      {dbExpanded && db.loadError && (
                        <div
                          style={{
                            padding: "4px 40px",
                            fontSize: "11px",
                            color: "var(--color-danger, #ff3b30)",
                          }}
                        >
                          {db.loadError}
                        </div>
                      )}
                      {dbExpanded && !isRedis && hasDbObjectFolders && (
                        <>
                          {showTablesFolder ? (
                          <>
                          <TreeNode
                            item={buildFolderTreeItem(
                              tblsFolderId,
                              t("database.sidebar.tables"),
                              conn.config.id,
                              db.name,
                            )}
                            depth={2}
                            expanded={tblsExpanded}
                            onToggle={() => toggle(tblsFolderId)}
                            meta={
                              tblsFolderRefreshing
                                ? t("common.loading")
                                : db.tables
                                  ? isTableFiltered
                                    ? `${tableVisibleCount}/${tableTotalCount}`
                                    : String(tableTotalCount)
                                  : undefined
                            }
                            onMetaClick={
                              !tblsFolderRefreshing &&
                              db.tables &&
                              tableTotalCount > 0
                                ? () =>
                                    setFilterDialogTable({
                                      connId: conn.config.id,
                                      dbName: db.name,
                                    })
                                : undefined
                            }
                            metaTitle={
                              !tblsFolderRefreshing &&
                              db.tables &&
                              tableTotalCount > 0
                                ? t("database.sidebar.filterDisplay")
                                : undefined
                            }
                            hasChildren
                            onContextMenu={(e) =>
                              handleContextSchemaNode(
                                buildFolderTreeItem(
                                  tblsFolderId,
                                  t("database.sidebar.tables"),
                                  conn.config.id,
                                  db.name,
                                ),
                                e,
                              )
                            }
                          />
                          {tblsExpanded && tableVisibleCount === 0 && tableTotalCount > 0 && (
                            <div
                              style={{
                                padding: "4px 56px",
                                fontSize: "11px",
                                color: "var(--text-secondary, #8e8e93)",
                              }}
                            >
                              {t("database.sidebar.filterHiddenTables")}
                            </div>
                          )}
                          {tblsExpanded &&
                            pagedTables.visible.map((tbl) => (
                              <SchemaTreeObjectDetails
                                key={tbl.name}
                                TreeNode={TreeNode}
                                LoadMoreButton={SchemaLoadMoreButton}
                                conn={conn}
                                dbName={db.name}
                                tbl={tbl}
                                objectKind="table"
                                depth={3}
                                expandedNodeIds={expandedNodeIds}
                                childVisibleLimits={childVisibleLimits}
                                searchActive={searchActive}
                                activeTableKey={activeTableKey}
                                tablePinned={isTablePinned(tableFilter, tbl.name)}
                                onToggleTablePin={() => {
                                  const key = makeTableFilterKey(conn.config.id, db.name);
                                  setTableFilters((prev) => ({
                                    ...prev,
                                    [key]: toggleTablePin(
                                      prev[key],
                                      tbl.name,
                                      allTables.map((item) => item.name),
                                    ),
                                  }));
                                }}
                                onToggle={toggle}
                                onLoadMore={loadMoreChildren}
                                onSelectTable={onSelectTable}
                                onContextSchemaNode={handleContextSchemaNode}
                                resolveNodeMeta={(nodeId, meta) =>
                                  schemaNodeMeta(refreshingNodeIds, nodeId, meta, t("common.loading"))
                                }
                              />
                            ))}
                          {tblsExpanded && pagedTables.hasMore && (
                            <SchemaLoadMoreButton
                              depth={3}
                              remaining={pagedTables.remaining}
                              label={t("database.sidebar.loadMore")}
                              onClick={() => loadMoreChildren(tblsFolderId)}
                            />
                          )}
                          </>
                          ) : null}

                          {showViewsFolder ? (
                          <>
                          <TreeNode
                            item={buildFolderTreeItem(
                              viewsFolderId,
                              t("database.sidebar.views"),
                              conn.config.id,
                              db.name,
                            )}
                            depth={2}
                            expanded={viewsExpanded}
                            onToggle={() => toggle(viewsFolderId)}
                            meta={
                              viewsFolderRefreshing
                                ? t("common.loading")
                                : viewTotalCount > 0
                                  ? String(viewTotalCount)
                                  : undefined
                            }
                            hasChildren
                            onContextMenu={(e) =>
                              handleContextSchemaNode(
                                buildFolderTreeItem(
                                  viewsFolderId,
                                  t("database.sidebar.views"),
                                  conn.config.id,
                                  db.name,
                                ),
                                e,
                              )
                            }
                          />
                          {viewsExpanded &&
                            pagedViews.visible.map((view) => (
                              <SchemaTreeObjectDetails
                                key={view.name}
                                TreeNode={TreeNode}
                                LoadMoreButton={SchemaLoadMoreButton}
                                conn={conn}
                                dbName={db.name}
                                tbl={view}
                                objectKind="view"
                                depth={3}
                                expandedNodeIds={expandedNodeIds}
                                childVisibleLimits={childVisibleLimits}
                                searchActive={searchActive}
                                activeTableKey={activeTableKey}
                                onToggle={toggle}
                                onLoadMore={loadMoreChildren}
                                onSelectTable={onSelectTable}
                                onContextSchemaNode={handleContextSchemaNode}
                                resolveNodeMeta={(nodeId, meta) =>
                                  schemaNodeMeta(refreshingNodeIds, nodeId, meta, t("common.loading"))
                                }
                              />
                            ))}
                          {viewsExpanded && pagedViews.hasMore && (
                            <SchemaLoadMoreButton
                              depth={3}
                              remaining={pagedViews.remaining}
                              label={t("database.sidebar.loadMore")}
                              onClick={() => loadMoreChildren(viewsFolderId)}
                            />
                          )}
                          </>
                          ) : null}

                          {showOtherFolder ? (
                          <>
                          <TreeNode
                            item={buildFolderTreeItem(
                              otherFolderId,
                              t("database.sidebar.other"),
                              conn.config.id,
                              db.name,
                            )}
                            depth={2}
                            expanded={otherExpanded}
                            onToggle={() => toggle(otherFolderId)}
                            meta={
                              otherFolderRefreshing
                                ? t("common.loading")
                                : routineTotalCount > 0
                                  ? String(routineTotalCount)
                                  : undefined
                            }
                            hasChildren
                            onContextMenu={(e) =>
                              handleContextSchemaNode(
                                buildFolderTreeItem(
                                  otherFolderId,
                                  t("database.sidebar.other"),
                                  conn.config.id,
                                  db.name,
                                ),
                                e,
                              )
                            }
                          />
                          {otherExpanded &&
                            pagedRoutines.visible.map((routine) => {
                              const routineId = routineNodeId(conn.config.id, db.name, routine.name);
                              const routineItem: SchemaTreeItem = {
                                type: "routine",
                                id: routineId,
                                label: routine.name,
                                connId: conn.config.id,
                                dbName: db.name,
                              };
                              return (
                                <TreeNode
                                  key={routineId}
                                  item={routineItem}
                                  depth={3}
                                  expanded={false}
                                  onToggle={() => {}}
                                  hasChildren={false}
                                  meta={
                                    schemaNodeMeta(
                                      refreshingNodeIds,
                                      routineId,
                                      routineTypeLabel(t, routine.routineType),
                                      t("common.loading"),
                                    )
                                  }
                                  onContextMenu={(e) => handleContextSchemaNode(routineItem, e)}
                                />
                              );
                            })}
                          {otherExpanded && pagedRoutines.hasMore && (
                            <SchemaLoadMoreButton
                              depth={3}
                              remaining={pagedRoutines.remaining}
                              label={t("database.sidebar.loadMore")}
                              onClick={() => loadMoreChildren(otherFolderId)}
                            />
                          )}
                          </>
                          ) : null}
                        </>
                      )}
                    </div>
                  );
                })}
              {connEnabled && connExpanded && conn.databases && pagedDatabases.hasMore && (
                <SchemaLoadMoreButton
                  depth={1}
                  remaining={pagedDatabases.remaining}
                  label={t("database.sidebar.loadMore")}
                  onClick={() => loadMoreChildren(databasesFolderId)}
                />
              )}
              {connEnabled &&
                connExpanded &&
                !isRedisConnection(conn.config) &&
                (() => {
                  const usersFolderId = connectionUsersFolderId(conn.config.id);
                  const usersExpanded = searchActive || expandedNodeIds.has(usersFolderId);
                  const usersFolderRefreshing = Boolean(refreshingNodeIds[usersFolderId]);
                  const allUsers = conn.users ?? [];
                  const showUsersFolder = allUsers.length > 0 || usersFolderRefreshing;
                  if (!showUsersFolder) {
                    return null;
                  }
                  const pagedUsers = paginateSchemaChildren(
                    allUsers,
                    usersFolderId,
                    childVisibleLimits,
                    paginateOpts,
                  );
                  return (
                    <>
                      <TreeNode
                        item={buildFolderTreeItem(
                          usersFolderId,
                          t("database.sidebar.users"),
                          conn.config.id,
                        )}
                        depth={1}
                        expanded={usersExpanded}
                        onToggle={() => toggle(usersFolderId)}
                        meta={
                          fullConnRefreshing || usersFolderRefreshing
                            ? t("common.loading")
                            : allUsers.length > 0
                              ? String(allUsers.length)
                              : undefined
                        }
                        hasChildren
                        onContextMenu={(e) =>
                          handleContextSchemaNode(
                            buildFolderTreeItem(
                              usersFolderId,
                              t("database.sidebar.users"),
                              conn.config.id,
                            ),
                            e,
                          )
                        }
                      />
                      {usersExpanded &&
                        pagedUsers.visible.map((user) => {
                          const uid = userNodeId(conn.config.id, user.name, user.host);
                          const userItem: SchemaTreeItem = {
                            type: "user",
                            id: uid,
                            label: formatUserLabel(user.name, user.host),
                            connId: conn.config.id,
                          };
                          const userRefreshing = Boolean(refreshingNodeIds[uid]);
                          return (
                            <TreeNode
                              key={uid}
                              item={userItem}
                              depth={2}
                              expanded={false}
                              onToggle={() => {}}
                              hasChildren={false}
                              meta={userRefreshing ? t("common.loading") : undefined}
                              onContextMenu={(e) => handleContextSchemaNode(userItem, e)}
                            />
                          );
                        })}
                      {usersExpanded && pagedUsers.hasMore && (
                        <SchemaLoadMoreButton
                          depth={2}
                          remaining={pagedUsers.remaining}
                          label={t("database.sidebar.loadMore")}
                          onClick={() => loadMoreChildren(usersFolderId)}
                        />
                      )}
                    </>
                  );
                })()}
            </div>
          );
        })}
        {pagedRootConns.hasMore && (
          <SchemaLoadMoreButton
            depth={0}
            remaining={pagedRootConns.remaining}
            label={t("database.sidebar.loadMore")}
            onClick={() => loadMoreChildren(SCHEMA_ROOT_CONNECTIONS_ID)}
          />
        )}
      </div>
      </ScopedSearch>

      {filterDialogConn && filterDialogConn.databases && (
        <DatabaseFilterDialog
          open={filterDialogConnId !== null}
          connectionName={filterDialogConn.config.name}
          databases={filterDialogConn.databases.map((db) => db.name)}
          initial={
            databaseFilters[filterDialogConn.config.id] ??
            mergeFilter(undefined, filterDialogConn.databases.map((db) => db.name))
          }
          onClose={() => setFilterDialogConnId(null)}
          onApply={(state) => {
            setDatabaseFilters((prev) => ({
              ...prev,
              [filterDialogConn.config.id]: state,
            }));
          }}
        />
      )}

      {filterDialogTable && filterDialogTableDb?.tables && (
        <SchemaFilterDialog
          open={filterDialogTable !== null}
          title={t("database.filter.tableTitle", { name: filterDialogTable.dbName })}
          items={filterDialogTableDb.tables.map((tbl) => tbl.name)}
          initial={
            tableFilters[makeTableFilterKey(filterDialogTable.connId, filterDialogTable.dbName)] ??
            mergeFilter(undefined, filterDialogTableDb.tables.map((tbl) => tbl.name))
          }
          onClose={() => setFilterDialogTable(null)}
          onApply={(state) => {
            const key = makeTableFilterKey(filterDialogTable.connId, filterDialogTable.dbName);
            const items = (filterDialogTableDb.tables ?? []).map((tbl) => tbl.name);
            setTableFilters((prev) => {
              const pinnedNames = (prev[key]?.pinnedNames ?? []).filter((name) =>
                state.visibleNames.has(name),
              );
              return {
                ...prev,
                [key]: {
                  ...state,
                  pinnedNames,
                  orderedNames: applyTablePinOrder(state.orderedNames, pinnedNames, items),
                },
              };
            });
          }}
        />
      )}
      {schemaCtxMenu && (
        <ContextMenu
          items={buildSchemaTreeContextMenuItems()}
          position={{ x: schemaCtxMenu.x, y: schemaCtxMenu.y }}
          onClose={() => setSchemaCtxMenu(null)}
        />
      )}
    </div>
  );

  if (section) {
    return (
      <SchemaSidebarSection {...section} actions={toolbar}>
        {panelBody}
      </SchemaSidebarSection>
    );
  }

  return panelBody;
}
