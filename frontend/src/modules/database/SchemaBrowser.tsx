import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import { ScopedSearch } from "../../components/ui/ScopedSearch";
import {
  type DbConnectionConfig,
  connectionMatchesGroup,
  listConnections,
  isConnectionEnabled,
  connectionHasTableSchemaChildren,
} from "./api";
import type { DbConnectionGroup } from "../../stores/dbGroupStore";
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
  SchemaFilterDialog,
} from "./DatabaseFilterDialog";
import {
  buildConnectionTreeItem,
  buildDatabaseTreeItem,
  buildFolderTreeItem,
  buildGroupTreeItem,
  handleSchemaTreeDragStart,
  handleSchemaTreeDragEnd,
  isSchemaTreeItemDraggable,
  type SchemaTreeItem,
} from "./schemaTreeItem";
import {
  handleSchemaTreePointerDown,
  registerSchemaTreeReorderListener,
  shouldSuppressSchemaTreeClick,
} from "./schemaTreePointerDrag";
import { reorderOrderedNames } from "./schemaTreeReorder";
import {
  nextSchemaChildLimit,
  paginateSchemaChildren,
} from "./schemaTreePagination";
import { mergeConnectionsWithCache, type CachedConnection, type CachedDatabase } from "./schemaCacheMerge";
import { refreshAllSchemaCache } from "./schemaCacheRefresh";
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
} from "./schemaTreeIds";
import { SchemaTreeObjectDetails } from "./schemaTreeObjectDetails";
import type { SchemaSidebarSectionConfig } from "./SchemaSidebarSection";
import { SchemaSidebarSection } from "./SchemaSidebarSection";

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
  onLabelDoubleClick?: () => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
  iconUrl?: string | null;
  reorderScope?: string;
  reorderName?: string;
  onMetaClick?: () => void;
  metaTitle?: string;
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
  onLabelDoubleClick,
  onContextMenu,
  iconUrl,
  reorderScope,
  reorderName,
  onMetaClick,
  metaTitle,
  labelComment,
  connectionEnabled = true,
}: TreeNodeProps) {
  const { t } = useI18n();
  const labelClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { type, label } = item;
  const indent = depth * 16 + 8;
  const draggable = isSchemaTreeItemDraggable(type);
  const isConnection = type === "connection";
  const connectionStateClass = isConnection
    ? connectionEnabled
      ? " tree-node--connection-enabled"
      : " tree-node--connection-disabled"
    : "";

  useEffect(() => {
    return () => {
      if (labelClickTimerRef.current) {
        clearTimeout(labelClickTimerRef.current);
      }
    };
  }, []);

  const runLabelClick = () => {
    if (shouldSuppressSchemaTreeClick()) {
      return;
    }
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
    if (onLabelDoubleClick) {
      if (labelClickTimerRef.current) {
        clearTimeout(labelClickTimerRef.current);
      }
      labelClickTimerRef.current = setTimeout(() => {
        labelClickTimerRef.current = null;
        runLabelClick();
      }, 250);
      return;
    }
    runLabelClick();
  };

  const handleLabelDoubleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (labelClickTimerRef.current) {
      clearTimeout(labelClickTimerRef.current);
      labelClickTimerRef.current = null;
    }
    if (shouldSuppressSchemaTreeClick()) {
      return;
    }
    onLabelDoubleClick?.();
  };

  return (
    <div
      className={`tree-node tree-node--${type}${active ? " tree-node--active" : ""}${draggable ? " tree-node--draggable" : ""}${connectionStateClass}`}
      style={{ paddingLeft: indent }}
      data-schema-item-type={type}
      {...(reorderScope && reorderName
        ? {
            "data-schema-reorder-scope": reorderScope,
            "data-schema-reorder-name": reorderName,
          }
        : {})}
      draggable={draggable}
      onPointerDown={draggable ? (event) => handleSchemaTreePointerDown(item, event) : undefined}
      onDragStart={
        draggable ? (event) => handleSchemaTreeDragStart(item, event) : undefined
      }
      onDragEnd={draggable ? () => handleSchemaTreeDragEnd(item) : undefined}
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
        onDoubleClick={onLabelDoubleClick ? handleLabelDoubleClick : undefined}
      >
        {label}
        {labelComment ? (
          <span className="tree-label-comment" title={labelComment}>
            {labelComment}
          </span>
        ) : null}
      </span>
      {isPk && <span className="tree-badge tree-badge--pk">PK</span>}
      {isFk && <span className="tree-badge tree-badge--fk">FK</span>}
      {meta && (
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
      )}
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

export interface SchemaBrowserProps {
  groups: DbConnectionGroup[];
  activeGroupId?: string;
  activeConnId?: string | null;
  onCreateConnection?: () => void;
  onCreateGroup?: () => void;
  onSelectGroup?: (groupId: string) => void;
  onSelectConnection?: (connId: string) => void;
  onSelectTable?: (selection: SchemaTableSelection) => void;
  onSelectDatabase?: (selection: SchemaDatabaseSelection) => void;
  onContextTable?: (selection: SchemaTableSelection, event: ReactMouseEvent) => void;
  onContextConnection?: (connId: string, event: ReactMouseEvent) => void;
  activeTableKey?: string | null;
  activeDatabaseKey?: string | null;
  refreshToken?: number;
  section?: SchemaSidebarSectionConfig;
}

export function SchemaBrowser({
  groups,
  activeGroupId,
  activeConnId = null,
  onCreateConnection,
  onCreateGroup,
  onSelectGroup,
  onSelectConnection,
  onSelectTable,
  onSelectDatabase,
  onContextTable,
  onContextConnection,
  activeTableKey = null,
  activeDatabaseKey = null,
  refreshToken = 0,
  section,
}: SchemaBrowserProps) {
  const { t } = useI18n();
  const resolvedTheme = useSettingsStore((s) => s.resolved);
  const [search, setSearch] = useState("");
  const expandedNodeIds = useDbSchemaTreeExpandedStore((s) => s.expandedNodeIds);
  const expandedHydrated = useDbSchemaTreeExpandedStore((s) => s.hydrated);
  const hydrateSchemaExpanded = useDbSchemaTreeExpandedStore((s) => s.hydrate);
  const updateExpanded = useDbSchemaTreeExpandedStore((s) => s.updateExpanded);
  const [childVisibleLimits, setChildVisibleLimits] = useState<Record<string, number>>({});
  const [connections, setConnections] = useState<LoadedConnection[]>([]);
  const [loading, setLoading] = useState(true);
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
  const sidebarRef = useRef<HTMLDivElement>(null);
  const schemaTreeRef = useRef<HTMLDivElement>(null);
  const connectionsRef = useRef(connections);
  const hydrateSchemaCache = useDbSchemaCacheStore((s) => s.hydrate);
  const replaceSchemaSnapshot = useDbSchemaCacheStore((s) => s.replaceSnapshot);
  const schemaSnapshot = useDbSchemaCacheStore((s) => s.snapshot);
  const refreshingConnectionIds = useDbSchemaCacheStore((s) => s.refreshingConnectionIds);
  const [refreshingSchema, setRefreshingSchema] = useState(false);

  connectionsRef.current = connections;

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

  const loadConnections = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      await hydrateSchemaCache();
      const list = await listConnections();
      const snapshot = useDbSchemaCacheStore.getState().snapshot;
      const merged = mergeConnectionsWithCache(list, snapshot);
      connectionsRef.current = merged;
      setConnections(merged);
    } catch (error) {
      setConnections([]);
      setLoadError(String(error));
    } finally {
      setLoading(false);
    }
  }, [hydrateSchemaCache]);

  const refreshSchemaCache = useCallback(async () => {
    setRefreshingSchema(true);
    setLoadError(null);
    try {
      const list = await listConnections();
      const snapshot = await refreshAllSchemaCache();
      await replaceSchemaSnapshot(snapshot);
      const merged = mergeConnectionsWithCache(list, snapshot);
      connectionsRef.current = merged;
      setConnections(merged);
      syncFiltersFromSnapshot(snapshot, syncDatabaseFilter, syncTableFilter);
    } catch (error) {
      setLoadError(String(error));
    } finally {
      setRefreshingSchema(false);
    }
  }, [replaceSchemaSnapshot, syncDatabaseFilter, syncTableFilter]);

  useEffect(() => {
    const configs = connectionsRef.current.map((item) => item.config);
    if (configs.length === 0) {
      return;
    }
    const merged = mergeConnectionsWithCache(configs, schemaSnapshot);
    connectionsRef.current = merged;
    setConnections(merged);
  }, [schemaSnapshot]);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections, refreshToken]);

  useEffect(() => {
    if (!activeGroupId) return;
    const groupNodeId = `grp:${activeGroupId}`;
    updateExpanded((prev) => {
      if (prev.has(groupNodeId)) return prev;
      const next = new Set(prev);
      next.add(groupNodeId);
      return next;
    });
  }, [activeGroupId, updateExpanded]);

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

  useEffect(() => {
    return registerSchemaTreeReorderListener((item, target) => {
      if (target.kind === "database" && item.connId && item.dbName) {
        setDatabaseFilters((prev) => {
          const existing = prev[item.connId!];
          if (!existing) {
            return prev;
          }
          const nextOrder = reorderOrderedNames(
            existing.orderedNames,
            item.dbName!,
            target.insertBeforeName,
          );
          if (!nextOrder) {
            return prev;
          }
          return {
            ...prev,
            [item.connId!]: { ...existing, orderedNames: nextOrder },
          };
        });
        return;
      }

      if (target.kind === "table" && item.connId && item.dbName && item.tableName) {
        const key = makeTableFilterKey(item.connId, item.dbName);
        setTableFilters((prev) => {
          const existing = prev[key];
          if (!existing) {
            return prev;
          }
          const nextOrder = reorderOrderedNames(
            existing.orderedNames,
            item.tableName!,
            target.insertBeforeName,
          );
          if (!nextOrder) {
            return prev;
          }
          return {
            ...prev,
            [key]: { ...existing, orderedNames: nextOrder },
          };
        });
      }
    });
  }, [setDatabaseFilters, setTableFilters]);

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

  const groupSections = useMemo(() => {
    const sections = groups.map((group) => ({
      group,
      connections: filtered.filter((conn) => connectionMatchesGroup(conn.config, group.name)),
    }));
    if (!search.trim()) {
      return sections;
    }
    return sections.filter((section) => section.connections.length > 0);
  }, [groups, filtered, search]);

  const hasAnyConnection = filtered.length > 0;

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
      {onCreateGroup && (
        <Button variant="icon" title={t("database.groups.new")} onClick={onCreateGroup}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2v-5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            <path d="M12 11v6M9 14h6" />
          </svg>
        </Button>
      )}
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
        disabled={refreshingSchema}
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
        className="schema-tree-scoped-search"
        value={search}
        onChange={setSearch}
        placeholder={t("database.sidebar.search")}
        enabled={filterDialogConnId === null && filterDialogTable === null}
      >
        <div className="schema-tree" ref={schemaTreeRef} tabIndex={-1}>
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
        {groupSections.map(({ group, connections: groupConns }) => {
          const groupNodeId = `grp:${group.id}`;
          const groupExpanded = expandedNodeIds.has(groupNodeId);
          const totalInGroup = connections.filter((conn) =>
            connectionMatchesGroup(conn.config, group.name),
          ).length;
          const groupItem = buildGroupTreeItem(group.id, group.name);
          const pagedGroupConns = paginateSchemaChildren(groupConns, groupNodeId, childVisibleLimits);

          return (
            <div key={group.id}>
              <TreeNode
                item={groupItem}
                depth={0}
                expanded={groupExpanded}
                onToggle={() => toggle(groupNodeId)}
                meta={String(totalInGroup)}
                hasChildren
                active={activeGroupId === group.id}
                onLabelClick={() => onSelectGroup?.(group.id)}
              />
              {groupExpanded &&
                pagedGroupConns.visible.map((conn) => {
          const connId = `conn:${conn.config.id}`;
          const connExpanded = expandedNodeIds.has(connId);
          const databasesFolderId = connectionDatabasesFolderId(conn.config.id);
          const databasesExpanded = expandedNodeIds.has(databasesFolderId);
          const allDatabases = conn.databases ?? [];
          const filter = databaseFilters[conn.config.id];
          const visibleDatabases = getVisibleItems(allDatabases, filter);
          const visibleCount = visibleDatabases.length;
          const totalCount = allDatabases.length;
          const isFiltered = totalCount > 0 && visibleCount < totalCount;
          const pagedDatabases = paginateSchemaChildren(visibleDatabases, databasesFolderId, childVisibleLimits);

          const engineIconUrl = getEngineIconByType(conn.config.db_type, resolvedTheme);
          const connItem = buildConnectionTreeItem(conn.config.id, conn.config.name, conn.config.db_type);
          const connEnabled = isConnectionEnabled(conn.config);
          const connRefreshing =
            connEnabled && (refreshingSchema || Boolean(refreshingConnectionIds[conn.config.id]));

          return (
            <div key={conn.config.id}>
              <TreeNode
                item={connItem}
                depth={1}
                expanded={connExpanded}
                onToggle={() => toggle(connId)}
                active={activeConnId === conn.config.id}
                connectionEnabled={connEnabled}
                onLabelClick={() => onSelectConnection?.(conn.config.id)}
                onContextMenu={
                  onContextConnection
                    ? (e) => onContextConnection(conn.config.id, e)
                    : undefined
                }
                iconUrl={engineIconUrl}
                meta={
                  !connEnabled
                    ? t("database.sidebar.connectionDisabled")
                    : connRefreshing
                      ? t("common.loading")
                      : conn.databases
                        ? isFiltered
                          ? `${visibleCount}/${totalCount} DB`
                          : `${totalCount} DB`
                        : t("database.sidebar.cacheEmpty")
                }
                onMetaClick={
                  connEnabled &&
                  !connRefreshing &&
                  conn.databases &&
                  totalCount > 0
                    ? () => setFilterDialogConnId(conn.config.id)
                    : undefined
                }
                metaTitle={
                  connEnabled &&
                  !connRefreshing &&
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
              {connEnabled &&
                connExpanded &&
                (() => {
                  const databasesMeta = connRefreshing
                    ? t("common.loading")
                    : conn.databases
                      ? visibleCount > 0
                        ? isFiltered
                          ? `${visibleCount}/${totalCount}`
                          : String(visibleCount)
                        : undefined
                      : t("database.sidebar.cacheEmpty");
                  return (
                    <>
                      <TreeNode
                        item={buildFolderTreeItem(
                          databasesFolderId,
                          t("database.sidebar.databases"),
                          conn.config.id,
                        )}
                        depth={2}
                        expanded={databasesExpanded}
                        onToggle={() => toggle(databasesFolderId)}
                        meta={databasesMeta}
                        onMetaClick={
                          !connRefreshing && conn.databases && totalCount > 0
                            ? () => setFilterDialogConnId(conn.config.id)
                            : undefined
                        }
                        metaTitle={
                          !connRefreshing && conn.databases && totalCount > 0
                            ? t("database.sidebar.filterDisplay")
                            : undefined
                        }
                        hasChildren
                      />
                      {databasesExpanded && connRefreshing && (
                        <div
                          style={{
                            padding: "4px 40px",
                            fontSize: "11px",
                            color: "var(--text-secondary, #8e8e93)",
                          }}
                        >
                          {t("common.loading")}
                        </div>
                      )}
                      {databasesExpanded &&
                        !connRefreshing &&
                        conn.databases &&
                        visibleCount === 0 &&
                        totalCount > 0 && (
                          <div
                            style={{
                              padding: "4px 40px",
                              fontSize: "11px",
                              color: "var(--text-secondary, #8e8e93)",
                            }}
                          >
                            {t("database.sidebar.filterHidden")}
                          </div>
                        )}
                      {databasesExpanded &&
                        !connRefreshing &&
                        conn.databases &&
                        pagedDatabases.visible.map((db) => {
                  const dbId = makeDatabaseNodeId(conn.config.id, db.name);
                  const dbExpanded = expandedNodeIds.has(dbId);
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
                  const tblsExpanded = expandedNodeIds.has(tblsFolderId);
                  const viewsExpanded = expandedNodeIds.has(viewsFolderId);
                  const otherExpanded = expandedNodeIds.has(otherFolderId);
                  const pagedTables = paginateSchemaChildren(visibleTables, tblsFolderId, childVisibleLimits);
                  const pagedViews = paginateSchemaChildren(allViews, viewsFolderId, childVisibleLimits);
                  const pagedRoutines = paginateSchemaChildren(allRoutines, otherFolderId, childVisibleLimits);
                  const dbItem = buildDatabaseTreeItem(conn.config.id, db.name);
                  const objectSummary = [
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
                        depth={3}
                        expanded={dbExpanded}
                        onToggle={() => toggle(dbId)}
                        reorderScope={conn.config.id}
                        reorderName={db.name}
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
                          db.loadError
                            ? t("database.sidebar.tablesFailed")
                            : objectSummary || undefined
                        }
                        hasChildren
                      />
                      {dbExpanded && db.loadError && (
                        <div
                          style={{
                            padding: "4px 56px",
                            fontSize: "11px",
                            color: "var(--color-danger, #ff3b30)",
                          }}
                        >
                          {db.loadError}
                        </div>
                      )}
                      {dbExpanded && (
                        <>
                          <TreeNode
                            item={buildFolderTreeItem(
                              tblsFolderId,
                              t("database.sidebar.tables"),
                              conn.config.id,
                              db.name,
                            )}
                            depth={4}
                            expanded={tblsExpanded}
                            onToggle={() => toggle(tblsFolderId)}
                            meta={
                              db.tables
                                ? isTableFiltered
                                  ? `${tableVisibleCount}/${tableTotalCount}`
                                  : String(tableTotalCount)
                                : undefined
                            }
                            onMetaClick={
                              db.tables && tableTotalCount > 0
                                ? () =>
                                    setFilterDialogTable({
                                      connId: conn.config.id,
                                      dbName: db.name,
                                    })
                                : undefined
                            }
                            metaTitle={
                              db.tables && tableTotalCount > 0
                                ? t("database.sidebar.filterDisplay")
                                : undefined
                            }
                            hasChildren
                          />
                          {tblsExpanded && tableVisibleCount === 0 && tableTotalCount > 0 && (
                            <div
                              style={{
                                padding: "4px 72px",
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
                                depth={5}
                                expandedNodeIds={expandedNodeIds}
                                childVisibleLimits={childVisibleLimits}
                                activeTableKey={activeTableKey}
                                onToggle={toggle}
                                onLoadMore={loadMoreChildren}
                                onSelectTable={onSelectTable}
                                onContextTable={onContextTable}
                              />
                            ))}
                          {tblsExpanded && pagedTables.hasMore && (
                            <SchemaLoadMoreButton
                              depth={5}
                              remaining={pagedTables.remaining}
                              label={t("database.sidebar.loadMore")}
                              onClick={() => loadMoreChildren(tblsFolderId)}
                            />
                          )}

                          <TreeNode
                            item={buildFolderTreeItem(
                              viewsFolderId,
                              t("database.sidebar.views"),
                              conn.config.id,
                              db.name,
                            )}
                            depth={4}
                            expanded={viewsExpanded}
                            onToggle={() => toggle(viewsFolderId)}
                            meta={viewTotalCount > 0 ? String(viewTotalCount) : undefined}
                            hasChildren
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
                                depth={5}
                                expandedNodeIds={expandedNodeIds}
                                childVisibleLimits={childVisibleLimits}
                                activeTableKey={activeTableKey}
                                onToggle={toggle}
                                onLoadMore={loadMoreChildren}
                                onSelectTable={onSelectTable}
                                onContextTable={onContextTable}
                              />
                            ))}
                          {viewsExpanded && pagedViews.hasMore && (
                            <SchemaLoadMoreButton
                              depth={5}
                              remaining={pagedViews.remaining}
                              label={t("database.sidebar.loadMore")}
                              onClick={() => loadMoreChildren(viewsFolderId)}
                            />
                          )}

                          <TreeNode
                            item={buildFolderTreeItem(
                              otherFolderId,
                              t("database.sidebar.other"),
                              conn.config.id,
                              db.name,
                            )}
                            depth={4}
                            expanded={otherExpanded}
                            onToggle={() => toggle(otherFolderId)}
                            meta={routineTotalCount > 0 ? String(routineTotalCount) : undefined}
                            hasChildren
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
                                  depth={5}
                                  expanded={false}
                                  onToggle={() => {}}
                                  hasChildren={false}
                                  meta={routineTypeLabel(t, routine.routineType)}
                                />
                              );
                            })}
                          {otherExpanded && pagedRoutines.hasMore && (
                            <SchemaLoadMoreButton
                              depth={5}
                              remaining={pagedRoutines.remaining}
                              label={t("database.sidebar.loadMore")}
                              onClick={() => loadMoreChildren(otherFolderId)}
                            />
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
                      {databasesExpanded && !connRefreshing && conn.databases && pagedDatabases.hasMore && (
                        <SchemaLoadMoreButton
                          depth={3}
                          remaining={pagedDatabases.remaining}
                          label={t("database.sidebar.loadMore")}
                          onClick={() => loadMoreChildren(databasesFolderId)}
                        />
                      )}
                    </>
                  );
                })()}
              {connEnabled &&
                connExpanded &&
                (conn.databases || connRefreshing) &&
                (() => {
                  const usersFolderId = connectionUsersFolderId(conn.config.id);
                  const usersExpanded = expandedNodeIds.has(usersFolderId);
                  const allUsers = conn.users ?? [];
                  const pagedUsers = paginateSchemaChildren(allUsers, usersFolderId, childVisibleLimits);
                  return (
                    <>
                      <TreeNode
                        item={buildFolderTreeItem(
                          usersFolderId,
                          t("database.sidebar.users"),
                          conn.config.id,
                        )}
                        depth={2}
                        expanded={usersExpanded}
                        onToggle={() => toggle(usersFolderId)}
                        meta={
                          connRefreshing
                            ? t("common.loading")
                            : allUsers.length > 0
                              ? String(allUsers.length)
                              : undefined
                        }
                        hasChildren
                      />
                      {usersExpanded && connRefreshing && (
                        <div
                          style={{
                            padding: "4px 40px",
                            fontSize: "11px",
                            color: "var(--text-secondary, #8e8e93)",
                          }}
                        >
                          {t("common.loading")}
                        </div>
                      )}
                      {usersExpanded &&
                        !connRefreshing &&
                        pagedUsers.visible.map((user) => {
                          const uid = userNodeId(conn.config.id, user.name, user.host);
                          const userItem: SchemaTreeItem = {
                            type: "user",
                            id: uid,
                            label: formatUserLabel(user.name, user.host),
                            connId: conn.config.id,
                          };
                          return (
                            <TreeNode
                              key={uid}
                              item={userItem}
                              depth={3}
                              expanded={false}
                              onToggle={() => {}}
                              hasChildren={false}
                            />
                          );
                        })}
                      {usersExpanded && !connRefreshing && pagedUsers.hasMore && (
                        <SchemaLoadMoreButton
                          depth={3}
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
              {groupExpanded && pagedGroupConns.hasMore && (
                <SchemaLoadMoreButton
                  depth={1}
                  remaining={pagedGroupConns.remaining}
                  label={t("database.sidebar.loadMore")}
                  onClick={() => loadMoreChildren(groupNodeId)}
                />
              )}
            </div>
          );
        })}
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
            setTableFilters((prev) => ({
              ...prev,
              [makeTableFilterKey(filterDialogTable.connId, filterDialogTable.dbName)]: state,
            }));
          }}
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
