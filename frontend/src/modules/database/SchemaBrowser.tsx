import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type CSSProperties,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import { appAlert } from "../../lib/appAlert";
import { quickInput } from "../../lib/quickInput";
import { useActionStore } from "../../stores/actionStore";
import { Button } from "../../components/ui/Button";
import { IconDropdownButton } from "../../components/ui/IconDropdownButton";
import { ScopedSearch, type ScopedSearchHandle } from "../../components/ui/ScopedSearch";
import {
  type DbConnectionConfig,
  listConnections,
  isConnectionEnabled,
  connectionHasTableSchemaChildren,
} from "./api";
import { makeQueryRunId } from "./queryRun";
import { useDbSchemaFilterStore } from "../../stores/dbSchemaFilterStore";
import { useDbSchemaTreeExpandedStore } from "../../stores/dbSchemaTreeExpandedStore";
import { useDbSchemaCacheStore } from "../../stores/dbSchemaCacheStore";
import {
  useDbSchemaConnectionLayoutStore,
  schemaConnectionFolderNodeId,
} from "../../stores/dbSchemaConnectionLayoutStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  DatabaseFilterDialog,
  makeTableFilterKey,
  mergeFilter,
  applyTablePinOrder,
  toggleTablePin,
  SchemaFilterDialog,
} from "./DatabaseFilterDialog";
import {
  buildTableTreeItem,
  type SchemaTreeItem,
} from "./schemaTreeItem";
import {
  buildDropColumnSql,
  buildDropIndexSql,
  isSchemaDropSqlSupported,
} from "./schemaTreeDropSql";
import { isSchemaNodeDeletable, isSchemaNodeRefreshable } from "./schemaTreeNodeActions";
import {
  nextSchemaChildLimit,
} from "./schemaTreePagination";
import { mergeConnectionsWithCache, type CachedConnection } from "./schemaCacheMerge";
import { submitSchemaCacheRefresh, SCHEMA_CACHE_REFRESH_COMPLETE_EVENT } from "./schemaCacheBackgroundTasks";
import {
  createSchemaCacheRefreshReporter,
  publishSchemaNodeRefreshDone,
  publishSchemaNodeRefreshFailed,
  publishSchemaNodeRefreshStart,
} from "./schemaCacheStatusLog";
import type { SchemaCacheSnapshot } from "./schemaCache";
import {
  parseTableNodeId,
  parseViewNodeId,
} from "./schemaTreeIds";
import {
  buildSchemaFlatRows,
  collectStickySchemaAncestors,
  estimateSchemaFlatRowSize,
  filterStickySchemaAncestorsForOverlay,
  findSchemaFlatRowIndexByNodeId,
  isSchemaFlatRowIndexCenteredInViewport,
  scrollSchemaFlatRowToCenter,
  type SchemaFlatRow,
  type SchemaNodeFlatRow,
} from "./schemaTreeFlatRows";
import type { SchemaSidebarSectionConfig } from "./SchemaSidebarSection";
import { SchemaSidebarSection } from "./SchemaSidebarSection";
import {
  buildPaginationPatchesForScrollTarget,
  collectExpandedIdsForScrollTarget,
  resolveSchemaTreeScrollTarget,
} from "./schemaTreeSidebarLinkage";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/ContextMenu";
import type { SchemaCacheConnectionEntry } from "./schemaCache";
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
import type { SchemaDockOpenMode } from "./workspaceTabs";

type LoadedConnection = CachedConnection;

function resolveLayoutFolderIdFromItem(item: SchemaTreeItem): string | null {
  if (item.type !== "connection-folder") {
    return null;
  }
  return item.id;
}

function buildLayoutDragPayload(item: SchemaTreeItem): SchemaLayoutDragPayload | null {
  if (item.type === "connection" && item.connId) {
    return { kind: "connection", connId: item.connId };
  }
  if (item.type === "connection-folder") {
    return {
      kind: "connection-folder",
      folderId: resolveLayoutFolderIdFromItem(item) ?? item.id,
    };
  }
  return null;
}

/** 区分单击预览与双击常驻的延迟（ms）。 */
const SCHEMA_LABEL_CLICK_DELAY_MS = 200;

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
  /** 双击打开常驻面板（单击为预览，需配合 onLabelClick） */
  onLabelDoubleClick?: () => void;
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
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshDisabled?: boolean;
  onDelete?: () => void;
  deleteDisabled?: boolean;
  /** 虚拟树吸顶条中的祖先节点样式 */
  stickyAncestor?: boolean;
  layoutDraggable?: boolean;
  layoutDraggingSource?: boolean;
  dragOver?: boolean;
  onLayoutPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
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
  onMetaClick,
  metaTitle,
  pinActive,
  onPinToggle,
  labelComment,
  connectionEnabled = true,
  onRefresh,
  refreshing = false,
  refreshDisabled = false,
  onDelete,
  deleteDisabled = false,
  stickyAncestor = false,
  layoutDraggable = false,
  layoutDraggingSource = false,
  dragOver = false,
  onLayoutPointerDown,
}: TreeNodeProps) {
  const { t } = useI18n();
  const labelClickTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (labelClickTimerRef.current !== null) {
        window.clearTimeout(labelClickTimerRef.current);
      }
    },
    [],
  );
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

  const handleNodeClick = (event: ReactMouseEvent) => {
    if (isLayoutPointerDragExcludedTarget(event.target)) {
      return;
    }
    if (onLabelDoubleClick && onLabelClick) {
      if (labelClickTimerRef.current !== null) {
        window.clearTimeout(labelClickTimerRef.current);
      }
      labelClickTimerRef.current = window.setTimeout(() => {
        labelClickTimerRef.current = null;
        onLabelClick();
      }, SCHEMA_LABEL_CLICK_DELAY_MS);
      return;
    }
    runLabelClick();
  };

  const handleNodeDoubleClick = (event: ReactMouseEvent) => {
    if (isLayoutPointerDragExcludedTarget(event.target)) {
      return;
    }
    if (labelClickTimerRef.current !== null) {
      window.clearTimeout(labelClickTimerRef.current);
      labelClickTimerRef.current = null;
    }
    if (onLabelDoubleClick) {
      event.preventDefault();
      event.stopPropagation();
      onLabelDoubleClick();
      return;
    }
    runLabelClick();
  };

  const stickyClass = stickyAncestor && hasChildren && expanded ? " tree-node--sticky" : "";
  const dragClass = dragOver ? " tree-node--drag-over" : "";
  const layoutDragClass = layoutDraggable ? " tree-node--layout-draggable" : "";
  const layoutSourceClass = layoutDraggingSource ? " tree-node--layout-source-dragging" : "";
  const nodeStyle: CSSProperties = {
    paddingLeft: indent,
    ["--tree-depth" as string]: depth,
  };

  return (
    <div
      className={`tree-node tree-node--${type}${active ? " tree-node--active" : ""}${connectionStateClass}${stickyClass}${dragClass}${layoutDragClass}${layoutSourceClass}`}
      style={nodeStyle}
      data-schema-item-type={type}
      data-schema-node-id={item.id}
      onClick={handleNodeClick}
      onDoubleClick={handleNodeDoubleClick}
      onPointerDown={(event) => {
        if (layoutDraggable) {
          onLayoutPointerDown?.(event);
        }
      }}
      onContextMenu={onContextMenu}
    >
      <span
        className={`tree-arrow${hasChildren ? "" : " tree-leaf"}${expanded ? " tree-arrow--open" : ""}`}
        onClick={(event) => {
          if (hasChildren) {
            event.stopPropagation();
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
        {(type === "folder" || type === "group" || type === "connection-folder") && (
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
      <span className="tree-label">
        <span className="tree-label-name">{label}</span>
        {labelComment ? (
          <span className="tree-label-comment" title={labelComment}>
            {labelComment}
          </span>
        ) : null}
      </span>
      {isPk && <span className="tree-badge tree-badge--pk">PK</span>}
      {isFk && <span className="tree-badge tree-badge--fk">FK</span>}
      {(meta || onRefresh || onDelete || onPinToggle) ? (
        <div className="tree-node-trailing">
          {meta ? (
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
          {(onRefresh || onDelete || onPinToggle) ? (
            <div className="tree-node-actions">
              {onRefresh ? (
                <button
                  type="button"
                  className={`tree-action-btn${refreshing ? " tree-action-btn--busy" : ""}`}
                  title={t("common.refresh")}
                  aria-label={t("common.refresh")}
                  disabled={refreshDisabled}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRefresh();
                  }}
                >
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                    <path d="M2 8a6 6 0 0 1 10.5-3.9" />
                    <path d="M14 2v3h-3" />
                    <path d="M14 8a6 6 0 0 1-10.5 3.9" />
                    <path d="M2 14v-3h3" />
                  </svg>
                </button>
              ) : null}
              {onDelete ? (
                <button
                  type="button"
                  className={`tree-action-btn tree-action-btn--danger${deleteDisabled ? " tree-action-btn--busy" : ""}`}
                  title={
                    item.type === "column"
                      ? t("database.schemaTree.deleteColumn")
                      : item.type === "index"
                        ? t("database.schemaTree.deleteIndex")
                        : t("database.queryFiles.delete")
                  }
                  aria-label={
                    item.type === "column"
                      ? t("database.schemaTree.deleteColumn")
                      : item.type === "index"
                        ? t("database.schemaTree.deleteIndex")
                        : t("database.queryFiles.delete")
                  }
                  disabled={deleteDisabled}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete();
                  }}
                >
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                    <path d="M2 4h12" />
                    <path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
                    <path d="M6 7v5M10 7v5" />
                    <path d="M3 4l.7 9.1a1 1 0 0 0 1 .9h6.6a1 1 0 0 0 1-.9L13 4" />
                  </svg>
                </button>
              ) : null}
              {onPinToggle ? (
                <button
                  type="button"
                  className={`tree-action-btn tree-action-btn--pin${pinActive ? " tree-action-btn--active" : ""}`}
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
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
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

export type SchemaContextMenuContext = {
  connection?: DbConnectionConfig;
  tableSelection?: SchemaTableSelection;
};

export interface SchemaBrowserProps {
  activeConnId?: string | null;
  onCreateConnection?: () => void;
  onImportNavicat?: () => void;
  onSelectConnection?: (connId: string, mode?: SchemaDockOpenMode) => void;
  onSelectTable?: (selection: SchemaTableSelection, mode?: SchemaDockOpenMode) => void;
  onSelectDatabase?: (selection: SchemaDatabaseSelection, mode?: SchemaDockOpenMode) => void;
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
  onImportNavicat,
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
  const stickyAncestors = useMemo(() => !search.trim(), [search]);
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
        item: SchemaTreeItem | null;
        connection?: DbConnectionConfig;
        tableSelection?: SchemaTableSelection;
        layoutRoot?: boolean;
      }
    | null
  >(null);
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

  const enqueueAction = useActionStore((s) => s.enqueueAction);
  const [deletingNodeIds, setDeletingNodeIds] = useState<Record<string, true>>({});

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

  const handleDeleteSchemaNode = useCallback(
    async (connection: DbConnectionConfig, item: SchemaTreeItem) => {
      if (!isSchemaNodeDeletable(item.type)) {
        return;
      }
      const dbName = item.dbName?.trim();
      const tableName = item.tableName?.trim();
      if (!dbName || !tableName) {
        return;
      }
      const objectName =
        item.type === "column"
          ? (item.columnName ?? item.label).trim()
          : (item.indexName ?? item.label).trim();
      const confirmed = await appConfirm(
        item.type === "column"
          ? t("database.schemaTree.confirmDeleteColumn", {
              name: objectName,
              table: tableName,
            })
          : t("database.schemaTree.confirmDeleteIndex", {
              name: objectName,
              table: tableName,
            }),
        t("database.schemaTree.confirmDeleteTitle"),
      );
      if (!confirmed) {
        return;
      }
      if (!isSchemaDropSqlSupported(connection.db_type)) {
        void appAlert(t("database.schemaTree.dropUnsupported"));
        return;
      }
      const sql =
        item.type === "column"
          ? buildDropColumnSql(connection.db_type, dbName, tableName, objectName)
          : buildDropIndexSql(connection.db_type, dbName, tableName, objectName);
      if (!sql) {
        void appAlert(t("database.schemaTree.dropUnsupported"));
        return;
      }
      setDeletingNodeIds((prev) => ({ ...prev, [item.id]: true }));
      try {
        enqueueAction({
          type: "sql",
          title:
            item.type === "column"
              ? t("database.schemaTree.deleteColumn")
              : t("database.schemaTree.deleteIndex"),
          description: `${connection.name} · ${tableName}.${objectName}`,
          command: sql,
          resourceId: connection.id,
          source: "用户",
        });
        await invoke("db_execute_query", {
          connection,
          sql,
          runId: makeQueryRunId(),
          limit: 1,
          offset: 0,
        });
        await refreshAndApplySchemaTreeNode(
          connection,
          buildTableTreeItem(connection.id, dbName, tableName),
          schemaRefreshHooks,
        );
      } catch (err) {
        void appAlert(t("database.schemaTree.dropFailed", { message: String(err) }));
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
      if (isSchemaNodeDeletable(item.type)) {
        props.onDelete = () => {
          void handleDeleteSchemaNode(connection, item);
        };
        props.deleteDisabled =
          !isConnectionEnabled(connection) || Boolean(deletingNodeIds[item.id]);
      }
      return props;
    },
    [deletingNodeIds, handleDeleteSchemaNode, handleRefreshSchemaNode, refreshingNodeIds],
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
        return;
      }
      deleteLayoutFolder(folderId);
    },
    [deleteLayoutFolder, t],
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

  const buildSchemaTreeContextMenuItems = useCallback((): ContextMenuItem[] => {
    if (!schemaCtxMenu) {
      return [];
    }
    const { item, connection, layoutRoot } = schemaCtxMenu;

    if (layoutRoot) {
      return [
        {
          id: "layout-new-folder",
          label: t("database.sidebar.newFolder"),
          onClick: () => void handleCreateLayoutFolder(null),
        },
      ];
    }

    if (item?.type === "connection-folder") {
      const folderId = resolveLayoutFolderIdFromItem(item);
      if (!folderId) {
        return [];
      }
      return [
        {
          id: "layout-new-folder",
          label: t("database.sidebar.newFolder"),
          onClick: () => void handleCreateLayoutFolder(folderId),
        },
        {
          id: "layout-rename-folder",
          label: t("database.sidebar.renameFolder"),
          onClick: () => void handleRenameLayoutFolder(folderId, item.label),
        },
        {
          id: "layout-delete-folder",
          label: t("database.sidebar.deleteFolder"),
          danger: true,
          onClick: () => void handleDeleteLayoutFolder(folderId),
        },
      ];
    }

    if (!item) {
      return [];
    }

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
          handleRefreshSchemaNode(connection, item);
        }
      },
    };
    const deleteIcon = (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M2 4h12" />
        <path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
        <path d="M6 7v5M10 7v5" />
        <path d="M3 4l.7 9.1a1 1 0 0 0 1 .9h6.6a1 1 0 0 0 1-.9L13 4" />
      </svg>
    );
    const deleteItem: ContextMenuItem | null =
      connection && isSchemaNodeDeletable(item.type)
        ? {
            id: "delete-schema-node",
            label:
              item.type === "column"
                ? t("database.schemaTree.deleteColumn")
                : t("database.schemaTree.deleteIndex"),
            icon: deleteIcon,
            danger: true,
            disabled: Boolean(deletingNodeIds[item.id]),
            onClick: () => {
              void handleDeleteSchemaNode(connection, item);
            },
          }
        : null;
    const trailingItems: ContextMenuItem[] = deleteItem
      ? [deleteItem, { id: "sep-delete", label: "", separator: true }, refreshItem]
      : [refreshItem];
    if (extra.length === 0) {
      return trailingItems;
    }
    return [...extra, { id: "sep-refresh", label: "", separator: true }, ...trailingItems];
  }, [
    buildSchemaContextMenuItems,
    deletingNodeIds,
    handleCreateLayoutFolder,
    handleDeleteLayoutFolder,
    handleRenameLayoutFolder,
    handleDeleteSchemaNode,
    handleRefreshSchemaNode,
    refreshingNodeIds,
    schemaCtxMenu,
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

  const flatRows = useMemo(
    () =>
      buildSchemaFlatRows({
        t,
        connections,
        expandedNodeIds,
        childVisibleLimits,
        databaseFilters,
        tableFilters,
        activeConnId,
        activeTableKey,
        activeDatabaseKey,
        refreshingConnectionIds,
        refreshingNodeIds,
        resolvedTheme,
        searchQuery: search,
        layoutFolders,
        connectionParents,
      }),
    [
      t,
      connections,
      expandedNodeIds,
      childVisibleLimits,
      databaseFilters,
      tableFilters,
      activeConnId,
      activeTableKey,
      activeDatabaseKey,
      refreshingConnectionIds,
      refreshingNodeIds,
      resolvedTheme,
      search,
      layoutFolders,
      connectionParents,
    ],
  );

  useEffect(() => {
    if (schemaTreeRef.current) {
      schemaTreeRef.current.scrollTop = 0;
    }
  }, [search]);

  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => schemaTreeRef.current,
    estimateSize: (index) => estimateSchemaFlatRowSize(flatRows[index]),
    overscan: 24,
  });
  const rowVirtualizerRef = useRef(rowVirtualizer);
  rowVirtualizerRef.current = rowVirtualizer;

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

  const sidebarLinkageRafRef = useRef<number | null>(null);
  const lastLinkageScrollRef = useRef<{ targetId: string; rowIndex: number } | null>(null);

  useEffect(() => {
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
  }, [
    sidebarScrollTargetId,
    loading,
    search,
    connections,
    databaseFilters,
    tableFilters,
    updateExpanded,
  ]);

  useEffect(() => {
    if (!sidebarScrollTargetId || loading || search.trim()) {
      lastLinkageScrollRef.current = null;
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
    if (
      last?.targetId === sidebarScrollTargetId &&
      last.rowIndex === rowIndex &&
      isSchemaFlatRowIndexCenteredInViewport(container, flatRows, rowIndex)
    ) {
      return;
    }

    const scrollToCenter = () => {
      scrollSchemaFlatRowToCenter(
        container,
        flatRows,
        rowIndex,
        (index) =>
          rowVirtualizerRef.current.scrollToIndex(index, { align: "center", behavior: "auto" }),
      );
    };

    if (sidebarLinkageRafRef.current != null) {
      cancelAnimationFrame(sidebarLinkageRafRef.current);
    }

    sidebarLinkageRafRef.current = requestAnimationFrame(() => {
      sidebarLinkageRafRef.current = requestAnimationFrame(() => {
        sidebarLinkageRafRef.current = null;
        scrollToCenter();
        requestAnimationFrame(() => {
          if (!isSchemaFlatRowIndexCenteredInViewport(container, flatRows, rowIndex)) {
            scrollToCenter();
          }
          lastLinkageScrollRef.current = { targetId: sidebarScrollTargetId, rowIndex };
        });
      });
    });

    return () => {
      if (sidebarLinkageRafRef.current != null) {
        cancelAnimationFrame(sidebarLinkageRafRef.current);
      }
    };
  }, [sidebarScrollTargetId, loading, search, flatRows]);

  const filterDialogConn = filterDialogConnId
    ? connections.find((conn) => conn.config.id === filterDialogConnId)
    : undefined;

  const filterDialogTableDb =
    filterDialogTable &&
    connections
      .find((conn) => conn.config.id === filterDialogTable.connId)
      ?.databases?.find((db) => db.name === filterDialogTable.dbName);

  const renderFlatRow = useCallback(
    (row: SchemaFlatRow, options?: { stickyAncestor?: boolean }) => {
      if (row.kind === "message") {
        const paddingLeft = row.depth * 16 + 24;
        const color =
          row.variant === "error"
            ? "var(--color-danger, #ff3b30)"
            : "var(--text-secondary, #8e8e93)";
        return (
          <div style={{ padding: "4px 0", paddingLeft, fontSize: "11px", color }}>
            {row.text}
          </div>
        );
      }
      if (row.kind === "load-more") {
        return (
          <SchemaLoadMoreButton
            depth={row.depth}
            remaining={row.remaining}
            label={t("database.sidebar.loadMore")}
            onClick={() => loadMoreChildren(row.parentNodeId)}
          />
        );
      }

      const connection = row.item.connId
        ? connectionsRef.current.find((entry) => entry.config.id === row.item.connId)?.config
        : undefined;

      const onMetaClick =
        row.metaClick === "database-filter" && row.metaClickConnId
          ? () => setFilterDialogConnId(row.metaClickConnId!)
          : row.metaClick === "table-filter" && row.metaClickConnId && row.metaClickDbName
            ? () =>
                setFilterDialogTable({
                  connId: row.metaClickConnId!,
                  dbName: row.metaClickDbName!,
                })
            : undefined;

      let onLabelClick: (() => void) | undefined;
      let onLabelDoubleClick: (() => void) | undefined;
      if (row.labelClickKind === "connection" && row.labelClickConnId) {
        onLabelClick = () => onSelectConnection?.(row.labelClickConnId!, "preview");
        onLabelDoubleClick = () => onSelectConnection?.(row.labelClickConnId!, "permanent");
      } else if (
        row.labelClickKind === "database" &&
        row.labelClickConnId &&
        row.labelClickDbName &&
        connection
      ) {
        onLabelClick = () => {
          onSelectDatabase?.(
            {
              connId: row.labelClickConnId!,
              dbName: row.labelClickDbName!,
              connection,
            },
            "preview",
          );
          if (!expandedNodeIds.has(row.item.id)) {
            requestAnimationFrame(() => toggle(row.item.id));
          }
        };
        onLabelDoubleClick = () => {
          onSelectDatabase?.(
            {
              connId: row.labelClickConnId!,
              dbName: row.labelClickDbName!,
              connection,
            },
            "permanent",
          );
          if (!expandedNodeIds.has(row.item.id)) {
            requestAnimationFrame(() => toggle(row.item.id));
          }
        };
      } else if (
        row.labelClickKind === "table" &&
        row.labelClickConnId &&
        row.labelClickDbName &&
        row.labelClickTableName &&
        connection
      ) {
        const tableSelection: SchemaTableSelection = {
          connId: row.labelClickConnId!,
          dbName: row.labelClickDbName!,
          tableName: row.labelClickTableName!,
          connection,
        };
        onLabelClick = () => onSelectTable?.(tableSelection, "preview");
        onLabelDoubleClick = () => onSelectTable?.(tableSelection, "permanent");
      }

      let onPinToggle: (() => void) | undefined;
      if (
        row.pinActive !== undefined &&
        row.labelClickConnId &&
        row.labelClickDbName &&
        row.labelClickTableName
      ) {
        onPinToggle = () => {
          const key = makeTableFilterKey(row.labelClickConnId!, row.labelClickDbName!);
          const conn = connectionsRef.current.find(
            (entry) => entry.config.id === row.labelClickConnId!,
          );
          const allTables =
            conn?.databases?.find((db) => db.name === row.labelClickDbName)?.tables ?? [];
          setTableFilters((prev) => ({
            ...prev,
            [key]: toggleTablePin(
              prev[key],
              row.labelClickTableName!,
              allTables.map((item) => item.name),
            ),
          }));
        };
      }

      const nodeActions =
        connection != null ? resolveSchemaNodeActions(connection, row.item) : {};

      const layoutDnDEnabled = !search.trim();
      const itemType = row.item.type;
      const isLayoutDraggable =
        layoutDnDEnabled && (itemType === "connection" || itemType === "connection-folder");
      const isLayoutDropTarget = layoutDnDEnabled && itemType === "connection-folder";

      const layoutPayload = buildLayoutDragPayload(row.item);

      return (
        <TreeNode
          item={row.item}
          depth={row.depth}
          expanded={row.expanded}
          onToggle={() => toggle(row.item.id)}
          hasChildren={row.hasChildren}
          active={row.active}
          meta={row.meta}
          metaTitle={row.metaTitle}
          onMetaClick={onMetaClick}
          isPk={row.isPk}
          isFk={row.isFk}
          labelComment={row.labelComment}
          connectionEnabled={row.connectionEnabled}
          iconUrl={row.iconUrl}
          pinActive={row.pinActive}
          onPinToggle={onPinToggle}
          onLabelClick={onLabelClick}
          onLabelDoubleClick={onLabelDoubleClick}
          onContextMenu={(e) => handleContextSchemaNode(row.item, e)}
          stickyAncestor={options?.stickyAncestor}
          layoutDraggable={isLayoutDraggable}
          layoutDraggingSource={layoutDraggingSourceId === row.item.id}
          dragOver={isLayoutDropTarget && layoutDragOverNodeId === row.item.id}
          onLayoutPointerDown={
            isLayoutDraggable && layoutPayload
              ? (event) => beginLayoutPointerDrag(event, layoutPayload, row.item.id)
              : undefined
          }
          {...nodeActions}
        />
      );
    },
    [
      t,
      loadMoreChildren,
      expandedNodeIds,
      onSelectConnection,
      onSelectDatabase,
      onSelectTable,
      resolveSchemaNodeActions,
      handleContextSchemaNode,
      setTableFilters,
      search,
      layoutDragOverNodeId,
      layoutDraggingSourceId,
      beginLayoutPointerDrag,
    ],
  );

  const virtualRows = rowVirtualizer.getVirtualItems();
  const stickyOverlayRows = useMemo(() => {
    if (!stickyAncestors || flatRows.length === 0) {
      return [] as { row: SchemaNodeFlatRow; rowIndex: number }[];
    }
    const firstVisibleIndex = virtualRows[0]?.index ?? 0;
    const ancestors = collectStickySchemaAncestors(flatRows, firstVisibleIndex);
    const visibleIndexes = virtualRows.map((item) => item.index);
    return filterStickySchemaAncestorsForOverlay(ancestors, visibleIndexes);
  }, [stickyAncestors, flatRows, virtualRows]);

  const handleCollapseAll = useCallback(() => {
    updateExpanded(() => new Set());
  }, [updateExpanded]);

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
      {onImportNavicat ? (
        <IconDropdownButton
          title={t("database.sidebar.importConnections")}
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <path d="M12 3v12" />
              <path d="M8 11l4 4 4-4" />
              <path d="M4 21h16" />
            </svg>
          }
          items={[
            {
              id: "datagrip",
              label: t("database.sidebar.importFormatDatagrip"),
              subtitle: t("database.import.inDevelopment"),
              onSelect: () => {
                void appAlert(
                  t("database.import.inDevelopment"),
                  t("database.sidebar.importFormatDatagrip"),
                );
              },
            },
            {
              id: "navicat",
              label: t("database.sidebar.importFormatNavicat"),
              onSelect: onImportNavicat,
            },
            {
              id: "dbeaver",
              label: t("database.sidebar.importFormatDbeaver"),
              subtitle: t("database.import.inDevelopment"),
              onSelect: () => {
                void appAlert(
                  t("database.import.inDevelopment"),
                  t("database.sidebar.importFormatDbeaver"),
                );
              },
            },
          ]}
        />
      ) : null}
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
      <Button
        variant="icon"
        title={t("database.sidebar.collapseAll")}
        aria-label={t("database.sidebar.collapseAll")}
        disabled={expandedNodeIds.size === 0}
        onClick={handleCollapseAll}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden>
          <path d="M8 16l4-4 4 4" />
          <path d="M8 11l4-4 4 4" />
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
          className={`schema-tree schema-tree--virtual${stickyAncestors ? " schema-tree--sticky-ancestors" : ""}`}
          ref={schemaTreeRef}
          tabIndex={-1}
          onKeyDown={handleTreeKeyDown}
          onContextMenu={handleContextLayoutRoot}
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
        {!loading && !loadError && hasAnyConnection && (
          <>
            {stickyOverlayRows.length > 0 && (
              <div className="schema-tree-sticky-ancestors">
                {stickyOverlayRows.map(({ row }) => (
                  <div key={`sticky:${row.key}`} className="schema-tree-sticky-ancestor-row">
                    {renderFlatRow(row, { stickyAncestor: true })}
                  </div>
                ))}
              </div>
            )}
          <div
            className="schema-tree-virtual-inner"
            style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualRows.map((virtualRow) => {
              const row = flatRows[virtualRow.index];
              if (!row) {
                return null;
              }
              return (
                <div
                  key={row.key}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  className="schema-tree-virtual-row"
                  style={{
                    position: "absolute",
                    top: virtualRow.start,
                    left: 0,
                    width: "100%",
                  }}
                >
                  {renderFlatRow(row)}
                </div>
              );
            })}
          </div>
          </>
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
