import type { SchemaFilterState } from "./DatabaseFilterDialog";
import { getVisibleItems, isTablePinned, makeTableFilterKey } from "./DatabaseFilterDialog";
import {
  connectionHasTableSchemaChildren,
  isConnectionEnabled,
  isRedisConnection,
} from "./api";
import type { CachedConnection, CachedTable } from "./schemaCacheMerge";
import { getEngineIconByType } from "./engineIcons";
import {
  buildColumnTreeItem,
  buildConnectionTreeItem,
  buildConnectionFolderTreeItem,
  buildDatabaseTreeItem,
  buildFolderTreeItem,
  buildIndexTreeItem,
  buildTableTreeItem,
  type SchemaTreeItem,
} from "./schemaTreeItem";
import { listSchemaConnectionLayoutChildren } from "./schemaConnectionLayoutTree";
import {
  schemaConnectionFolderNodeId,
  type SchemaConnectionFolder,
} from "../../stores/dbSchemaConnectionLayoutStore";
import {
  connectionDatabasesFolderId,
  connectionUsersFolderId,
  databaseOtherFolderId,
  databaseTablesFolderId,
  databaseViewsFolderId,
  formatUserLabel,
  makeDatabaseNodeId,
  makeTableNodeId,
  makeViewNodeId,
  routineNodeId,
  userNodeId,
  SCHEMA_ROOT_CONNECTIONS_ID,
} from "./schemaTreeIds";
import { paginateSchemaChildren } from "./schemaTreePagination";
import {
  schemaColumnMatchesSearch,
  schemaConnectionSearchMatchesUnderExpanded,
  schemaDatabaseSearchMatchesUnderExpanded,
  schemaIndexMatchesSearch,
  schemaRoutineMatchesSearch,
  schemaSearchMatches,
  schemaTableObjectMatchesSearch,
  schemaTableObjectSearchMatchesUnderExpanded,
  schemaUserMatchesSearch,
} from "./schemaTreeSearch";

export const SCHEMA_TREE_NODE_ROW_HEIGHT = 22;
export const SCHEMA_TREE_MESSAGE_ROW_HEIGHT = 24;
export const SCHEMA_TREE_LOAD_MORE_ROW_HEIGHT = 22;

export type SchemaNodeMetaClick = "database-filter" | "table-filter";

export interface SchemaNodeFlatRow {
  kind: "node";
  key: string;
  item: SchemaTreeItem;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  active?: boolean;
  meta?: string;
  metaTitle?: string;
  metaClick?: SchemaNodeMetaClick;
  metaClickConnId?: string;
  metaClickDbName?: string;
  isPk?: boolean;
  isFk?: boolean;
  labelComment?: string;
  connectionEnabled?: boolean;
  iconUrl?: string | null;
  pinActive?: boolean;
  labelClickKind?: "connection" | "database" | "table";
  labelClickConnId?: string;
  labelClickDbName?: string;
  labelClickTableName?: string;
}

export interface SchemaLoadMoreFlatRow {
  kind: "load-more";
  key: string;
  parentNodeId: string;
  depth: number;
  remaining: number;
}

export interface SchemaMessageFlatRow {
  kind: "message";
  key: string;
  depth: number;
  text: string;
  variant: "error" | "empty";
}

export type SchemaFlatRow = SchemaNodeFlatRow | SchemaLoadMoreFlatRow | SchemaMessageFlatRow;

export interface SchemaFlatRowsParams {
  t: (key: string, params?: Record<string, string | number>) => string;
  connections: CachedConnection[];
  expandedNodeIds: Set<string>;
  childVisibleLimits: Record<string, number>;
  databaseFilters: Record<string, SchemaFilterState | undefined>;
  tableFilters: Record<string, SchemaFilterState | undefined>;
  activeConnId: string | null;
  activeTableKey: string | null;
  activeDatabaseKey: string | null;
  refreshingConnectionIds: Record<string, true>;
  refreshingNodeIds: Record<string, true>;
  resolvedTheme: "light" | "dark";
  searchQuery?: string;
  layoutFolders?: SchemaConnectionFolder[];
  connectionParents?: Record<string, string | null>;
}

function routineTypeLabel(t: SchemaFlatRowsParams["t"], routineType: string): string {
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

function schemaNodeMeta(
  refreshingNodeIds: Record<string, true>,
  nodeId: string,
  meta: string | undefined,
  loadingLabel: string,
): string | undefined {
  return refreshingNodeIds[nodeId] ? loadingLabel : meta;
}

function tableColumnsFolderId(tableId: string) {
  return `${tableId}:cols`;
}

function tableIndexesFolderId(tableId: string) {
  return `${tableId}:idxs`;
}

function pushLoadMore(
  rows: SchemaFlatRow[],
  parentNodeId: string,
  depth: number,
  remaining: number,
) {
  rows.push({
    kind: "load-more",
    key: `load-more:${parentNodeId}`,
    parentNodeId,
    depth,
    remaining,
  });
}

function pushMessage(
  rows: SchemaFlatRow[],
  key: string,
  depth: number,
  text: string,
  variant: "error" | "empty",
) {
  rows.push({ kind: "message", key, depth, text, variant });
}

function pushNode(rows: SchemaFlatRow[], row: SchemaNodeFlatRow) {
  rows.push(row);
}

function appendTableObjectRows(
  rows: SchemaFlatRow[],
  params: SchemaFlatRowsParams,
  conn: CachedConnection,
  dbName: string,
  tbl: CachedTable,
  objectKind: "table" | "view",
  depth: number,
  tablePinned: boolean | undefined,
) {
  const { t, expandedNodeIds, childVisibleLimits, activeTableKey, refreshingNodeIds, searchQuery } =
    params;
  const q = searchQuery?.trim() ?? "";
  const isSearchMode = q.length > 0;
  const tableKey =
    objectKind === "view"
      ? makeViewNodeId(conn.config.id, dbName, tbl.name)
      : makeTableNodeId(conn.config.id, dbName, tbl.name);
  const tableSelfMatches = isSearchMode && schemaTableObjectMatchesSearch(q, tbl);
  const tableExpanded = expandedNodeIds.has(tableKey);
  const colsFolderId = tableColumnsFolderId(tableKey);
  const idxFolderId = tableIndexesFolderId(tableKey);
  const colsExpanded = expandedNodeIds.has(colsFolderId);
  const idxExpanded = expandedNodeIds.has(idxFolderId);
  const fieldsLabel = t("database.sidebar.fields");
  const indexesLabel = t("database.sidebar.indexes");
  const allColumns = tbl.columns ?? [];
  const allIndexes = tbl.indexes ?? [];
  const fieldsFolderMatches = isSearchMode && schemaSearchMatches(q, fieldsLabel);
  const indexesFolderMatches = isSearchMode && schemaSearchMatches(q, indexesLabel);
  const columnsToShow = !isSearchMode
    ? allColumns
    : colsExpanded
      ? tableSelfMatches || fieldsFolderMatches
        ? allColumns
        : allColumns.filter((col) => schemaColumnMatchesSearch(q, col))
      : [];
  const indexesToShow =
    objectKind === "table"
      ? !isSearchMode
        ? allIndexes
        : idxExpanded
          ? tableSelfMatches || indexesFolderMatches
            ? allIndexes
            : allIndexes.filter((idx) => schemaIndexMatchesSearch(q, idx))
          : []
      : [];
  const paginateOpts = isSearchMode ? { unpaginated: true } : undefined;
  const pagedColumns = paginateSchemaChildren(
    columnsToShow,
    colsFolderId,
    childVisibleLimits,
    paginateOpts,
  );
  const pagedIndexes = paginateSchemaChildren(
    indexesToShow,
    idxFolderId,
    childVisibleLimits,
    paginateOpts,
  );
  const tableItem: SchemaTreeItem =
    objectKind === "view"
      ? {
          type: "view",
          id: tableKey,
          label: tbl.name,
          connId: conn.config.id,
          dbName,
          tableName: tbl.name,
        }
      : buildTableTreeItem(conn.config.id, dbName, tbl.name);
  const metaFor = (nodeId: string, meta?: string) =>
    schemaNodeMeta(refreshingNodeIds, nodeId, meta, t("common.loading"));
  const showTableSchemaChildren = connectionHasTableSchemaChildren(conn.config);
  const showColumnsSection = !isSearchMode
    ? allColumns.length > 0
    : fieldsFolderMatches || (colsExpanded && columnsToShow.length > 0);
  const showIndexesSection =
    objectKind === "table" &&
    (!isSearchMode
      ? allIndexes.length > 0
      : indexesFolderMatches || (idxExpanded && indexesToShow.length > 0));

  pushNode(rows, {
    kind: "node",
    key: tableKey,
    item: tableItem,
    depth,
    expanded: tableExpanded,
    hasChildren: showTableSchemaChildren && (showColumnsSection || showIndexesSection),
    active: activeTableKey === tableKey,
    labelComment: tbl.comment?.trim() || undefined,
    meta: metaFor(tableKey, undefined),
    pinActive: objectKind === "table" ? tablePinned : undefined,
    labelClickKind: objectKind === "table" ? "table" : undefined,
    labelClickConnId: conn.config.id,
    labelClickDbName: dbName,
    labelClickTableName: tbl.name,
  });

  if (!showTableSchemaChildren || !tableExpanded) {
    return;
  }

  if (tbl.detailsError) {
    pushMessage(rows, `${tableKey}:details-error`, depth + 1, tbl.detailsError, "error");
  }

  if (!tbl.columns) {
    return;
  }

  if (showColumnsSection) {
    const colsFolderItem = buildFolderTreeItem(
      colsFolderId,
      fieldsLabel,
      conn.config.id,
      dbName,
      tbl.name,
    );
    pushNode(rows, {
      kind: "node",
      key: colsFolderId,
      item: colsFolderItem,
      depth: depth + 1,
      expanded: colsExpanded,
      hasChildren: columnsToShow.length > 0,
      meta: metaFor(colsFolderId, String(columnsToShow.length)),
    });

    if (colsExpanded) {
      for (const col of pagedColumns.visible) {
        const colId = `${tableKey}:col:${col.name}`;
        const colItem = buildColumnTreeItem(
          conn.config.id,
          dbName,
          tbl.name,
          col.name,
          col.type,
          colId,
        );
        pushNode(rows, {
          kind: "node",
          key: colId,
          item: colItem,
          depth: depth + 2,
          expanded: false,
          hasChildren: false,
          meta: metaFor(colId, col.type),
          isPk: col.isPk,
          isFk: col.isFk,
        });
      }
      if (!isSearchMode && pagedColumns.hasMore) {
        pushLoadMore(rows, colsFolderId, depth + 2, pagedColumns.remaining);
      }
    }
  }

  if (!showIndexesSection) {
    return;
  }

  const idxFolderItem = buildFolderTreeItem(
    idxFolderId,
    indexesLabel,
    conn.config.id,
    dbName,
    tbl.name,
  );
  pushNode(rows, {
    kind: "node",
    key: idxFolderId,
    item: idxFolderItem,
    depth: depth + 1,
    expanded: idxExpanded,
    hasChildren: indexesToShow.length > 0,
    meta: metaFor(idxFolderId, String(indexesToShow.length)),
  });

  if (idxExpanded) {
    for (const idx of pagedIndexes.visible) {
      const idxId = `${tableKey}:idx:${idx.name}`;
      const idxItem = buildIndexTreeItem(conn.config.id, dbName, tbl.name, idx.name, idxId);
      pushNode(rows, {
        kind: "node",
        key: idxId,
        item: idxItem,
        depth: depth + 2,
        expanded: false,
        hasChildren: false,
        meta: metaFor(idxId, idx.columns.join(", ")),
      });
    }
    if (!isSearchMode && pagedIndexes.hasMore) {
      pushLoadMore(rows, idxFolderId, depth + 2, pagedIndexes.remaining);
    }
  }
}


interface SchemaFlatRowsBuildContext {
  q: string;
  isSearchMode: boolean;
  paginateOpts: { unpaginated: true } | undefined;
  searchLabels: {
    tables: string;
    views: string;
    other: string;
    fields: string;
    indexes: string;
    users: string;
  };
  routineLabel: (routineType: string) => string;
}

function appendConnectionSchemaRows(
  rows: SchemaFlatRow[],
  params: SchemaFlatRowsParams,
  conn: CachedConnection,
  baseDepth: number,
  ctx: SchemaFlatRowsBuildContext,
): void {
  const {
    t,
    expandedNodeIds,
    childVisibleLimits,
    databaseFilters,
    tableFilters,
    activeConnId,
    activeDatabaseKey,
    refreshingConnectionIds,
    refreshingNodeIds,
    resolvedTheme,
  } = params;
  const { q, isSearchMode, paginateOpts, searchLabels, routineLabel } = ctx;

    const connId = `conn:${conn.config.id}`;
    if (
      isSearchMode &&
      !schemaConnectionSearchMatchesUnderExpanded(
        q,
        conn,
        expandedNodeIds,
        databaseFilters,
        tableFilters,
        makeTableFilterKey,
        searchLabels,
        routineLabel,
      )
    ) {
      return;
    }

    const connExpanded = expandedNodeIds.has(connId);
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
    const fullConnRefreshing = connEnabled && Boolean(refreshingConnectionIds[conn.config.id]);
    const connNodeRefreshing = Boolean(refreshingNodeIds[connId]);

    pushNode(rows, {
      kind: "node",
      key: connId,
      item: connItem,
      depth: baseDepth,
      expanded: connExpanded,
      hasChildren: connEnabled,
      active: activeConnId === conn.config.id,
      connectionEnabled: connEnabled,
      iconUrl: engineIconUrl,
      labelClickKind: "connection",
      labelClickConnId: conn.config.id,
      meta: !connEnabled
        ? t("database.sidebar.connectionDisabled")
        : fullConnRefreshing || connNodeRefreshing
          ? t("common.loading")
          : conn.databases
            ? isFiltered
              ? `${visibleCount}/${totalCount} DB`
              : `${totalCount} DB`
            : t("database.sidebar.cacheEmpty"),
      metaTitle:
        connEnabled &&
        !fullConnRefreshing &&
        !connNodeRefreshing &&
        conn.databases &&
        totalCount > 0
          ? t("database.sidebar.filterDisplay")
          : undefined,
      metaClick:
        connEnabled &&
        !fullConnRefreshing &&
        !connNodeRefreshing &&
        conn.databases &&
        totalCount > 0
          ? "database-filter"
          : undefined,
      metaClickConnId: conn.config.id,
    });

    if (!connEnabled || !connExpanded) {
      return;
    }

    if (conn.databasesError) {
      pushMessage(rows, `${connId}:db-error`, baseDepth + 1, conn.databasesError, "error");
    }

    if (conn.databases && !isSearchMode && visibleCount === 0 && totalCount > 0) {
      pushMessage(rows, `${connId}:filter-hidden`, baseDepth + 1, t("database.sidebar.filterHidden"), "empty");
    }

    if (conn.databases) {
      for (const db of pagedDatabases.visible) {
        const isRedis = isRedisConnection(conn.config);
        const dbId = makeDatabaseNodeId(conn.config.id, db.name);
        const tableFilter = tableFilters[makeTableFilterKey(conn.config.id, db.name)];
        if (
          isSearchMode &&
          !schemaDatabaseSearchMatchesUnderExpanded(
            q,
            db,
            dbId,
            conn,
            expandedNodeIds,
            tableFilter,
            searchLabels,
            routineLabel,
          )
        ) {
          continue;
        }

        const dbExpanded = expandedNodeIds.has(dbId);
        const allTables = db.tables ?? [];
        const allViews = db.views ?? [];
        const allRoutines = db.routines ?? [];
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
        const tablesFolderMatches = isSearchMode && schemaSearchMatches(q, searchLabels.tables);
        const viewsFolderMatches = isSearchMode && schemaSearchMatches(q, searchLabels.views);
        const otherFolderMatches = isSearchMode && schemaSearchMatches(q, searchLabels.other);
        const tablesToShow = isSearchMode
          ? tblsExpanded
            ? tablesFolderMatches
              ? visibleTables
              : visibleTables.filter((tbl) =>
                  schemaTableObjectSearchMatchesUnderExpanded(
                    q,
                    tbl,
                    "table",
                    makeTableNodeId(conn.config.id, db.name, tbl.name),
                    expandedNodeIds,
                    conn.config,
                    searchLabels,
                  ),
                )
            : []
          : visibleTables;
        const viewsToShow = isSearchMode
          ? viewsExpanded
            ? viewsFolderMatches
              ? allViews
              : allViews.filter((view) =>
                  schemaTableObjectSearchMatchesUnderExpanded(
                    q,
                    view,
                    "view",
                    makeViewNodeId(conn.config.id, db.name, view.name),
                    expandedNodeIds,
                    conn.config,
                    searchLabels,
                  ),
                )
            : []
          : allViews;
        const routinesToShow = isSearchMode
          ? otherExpanded
            ? otherFolderMatches
              ? allRoutines
              : allRoutines.filter((routine) =>
                  schemaRoutineMatchesSearch(q, routine, routineLabel(routine.routineType)),
                )
            : []
          : allRoutines;
        const pagedTables = paginateSchemaChildren(
          tablesToShow,
          tblsFolderId,
          childVisibleLimits,
          paginateOpts,
        );
        const pagedViews = paginateSchemaChildren(
          viewsToShow,
          viewsFolderId,
          childVisibleLimits,
          paginateOpts,
        );
        const pagedRoutines = paginateSchemaChildren(
          routinesToShow,
          otherFolderId,
          childVisibleLimits,
          paginateOpts,
        );
        const dbItem = buildDatabaseTreeItem(conn.config.id, db.name);
        const dbNodeRefreshing = Boolean(refreshingNodeIds[dbId]);
        const tblsFolderRefreshing = Boolean(refreshingNodeIds[tblsFolderId]);
        const viewsFolderRefreshing = Boolean(refreshingNodeIds[viewsFolderId]);
        const otherFolderRefreshing = Boolean(refreshingNodeIds[otherFolderId]);
        const showTablesFolder =
          (isSearchMode
            ? tablesFolderMatches || (tblsExpanded && tablesToShow.length > 0)
            : tableTotalCount > 0) || tblsFolderRefreshing;
        const showViewsFolder =
          (isSearchMode
            ? viewsFolderMatches || (viewsExpanded && viewsToShow.length > 0)
            : viewTotalCount > 0) || viewsFolderRefreshing;
        const showOtherFolder =
          (isSearchMode
            ? otherFolderMatches || (otherExpanded && routinesToShow.length > 0)
            : routineTotalCount > 0) || otherFolderRefreshing;
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

        pushNode(rows, {
          kind: "node",
          key: dbId,
          item: dbItem,
          depth: baseDepth + 1,
          expanded: dbExpanded,
          hasChildren: !isRedis && (hasDbObjectFolders || Boolean(db.loadError)),
          active: activeDatabaseKey === dbId,
          labelClickKind: "database",
          labelClickConnId: conn.config.id,
          labelClickDbName: db.name,
          meta: dbNodeRefreshing
            ? t("common.loading")
            : db.loadError
              ? t("database.sidebar.tablesFailed")
              : objectSummary || undefined,
        });

        if (!dbExpanded) {
          continue;
        }

        if (db.loadError) {
          pushMessage(rows, `${dbId}:load-error`, baseDepth + 2, db.loadError, "error");
        }

        if (isRedis || !hasDbObjectFolders) {
          continue;
        }

        if (showTablesFolder) {
          const tblsFolderItem = buildFolderTreeItem(
            tblsFolderId,
            t("database.sidebar.tables"),
            conn.config.id,
            db.name,
          );
          pushNode(rows, {
            kind: "node",
            key: tblsFolderId,
            item: tblsFolderItem,
            depth: baseDepth + 2,
            expanded: tblsExpanded,
            hasChildren: true,
            meta: tblsFolderRefreshing
              ? t("common.loading")
              : db.tables
                ? isTableFiltered
                  ? `${tableVisibleCount}/${tableTotalCount}`
                  : String(tableTotalCount)
                : undefined,
            metaTitle:
              !tblsFolderRefreshing && db.tables && tableTotalCount > 0
                ? t("database.sidebar.filterDisplay")
                : undefined,
            metaClick:
              !tblsFolderRefreshing && db.tables && tableTotalCount > 0 ? "table-filter" : undefined,
            metaClickConnId: conn.config.id,
            metaClickDbName: db.name,
          });

          if (tblsExpanded) {
            if (!isSearchMode && tableVisibleCount === 0 && tableTotalCount > 0) {
              pushMessage(
                rows,
                `${tblsFolderId}:filter-hidden`,
                3,
                t("database.sidebar.filterHiddenTables"),
                "empty",
              );
            }
            for (const tbl of pagedTables.visible) {
              appendTableObjectRows(rows, params, conn, db.name, tbl, "table", baseDepth + 3,
                isTablePinned(tableFilter, tbl.name),
              );
            }
            if (!isSearchMode && pagedTables.hasMore) {
              pushLoadMore(rows, tblsFolderId, baseDepth + 3, pagedTables.remaining);
            }
          }
        }

        if (showViewsFolder) {
          const viewsFolderItem = buildFolderTreeItem(
            viewsFolderId,
            t("database.sidebar.views"),
            conn.config.id,
            db.name,
          );
          pushNode(rows, {
            kind: "node",
            key: viewsFolderId,
            item: viewsFolderItem,
            depth: baseDepth + 2,
            expanded: viewsExpanded,
            hasChildren: true,
            meta: viewsFolderRefreshing
              ? t("common.loading")
              : viewTotalCount > 0
                ? String(viewTotalCount)
                : undefined,
          });

          if (viewsExpanded) {
            for (const view of pagedViews.visible) {
              appendTableObjectRows(rows, params, conn, db.name, view, "view", baseDepth + 3, undefined);
            }
            if (!isSearchMode && pagedViews.hasMore) {
              pushLoadMore(rows, viewsFolderId, baseDepth + 3, pagedViews.remaining);
            }
          }
        }

        if (showOtherFolder) {
          const otherFolderItem = buildFolderTreeItem(
            otherFolderId,
            t("database.sidebar.other"),
            conn.config.id,
            db.name,
          );
          pushNode(rows, {
            kind: "node",
            key: otherFolderId,
            item: otherFolderItem,
            depth: baseDepth + 2,
            expanded: otherExpanded,
            hasChildren: true,
            meta: otherFolderRefreshing
              ? t("common.loading")
              : routineTotalCount > 0
                ? String(routineTotalCount)
                : undefined,
          });

          if (otherExpanded) {
            for (const routine of pagedRoutines.visible) {
              const routineId = routineNodeId(conn.config.id, db.name, routine.name);
              const routineItem: SchemaTreeItem = {
                type: "routine",
                id: routineId,
                label: routine.name,
                connId: conn.config.id,
                dbName: db.name,
              };
              pushNode(rows, {
                kind: "node",
                key: routineId,
                item: routineItem,
                depth: baseDepth + 3,
                expanded: false,
                hasChildren: false,
                meta: schemaNodeMeta(
                  refreshingNodeIds,
                  routineId,
                  routineTypeLabel(t, routine.routineType),
                  t("common.loading"),
                ),
              });
            }
            if (!isSearchMode && pagedRoutines.hasMore) {
              pushLoadMore(rows, otherFolderId, baseDepth + 3, pagedRoutines.remaining);
            }
          }
        }
      }

      if (!isSearchMode && pagedDatabases.hasMore) {
        pushLoadMore(rows, databasesFolderId, baseDepth + 1, pagedDatabases.remaining);
      }
    }

    if (!isRedisConnection(conn.config)) {
      const usersFolderId = connectionUsersFolderId(conn.config.id);
      const usersExpanded = expandedNodeIds.has(usersFolderId);
      const usersFolderRefreshing = Boolean(refreshingNodeIds[usersFolderId]);
      const allUsers = conn.users ?? [];
      const usersFolderMatches = isSearchMode && schemaSearchMatches(q, searchLabels.users);
      const usersToShow = isSearchMode
        ? usersExpanded
          ? usersFolderMatches
            ? allUsers
            : allUsers.filter((user) => schemaUserMatchesSearch(q, user))
          : []
        : allUsers;
      const showUsersFolder =
        (isSearchMode
          ? usersFolderMatches || (usersExpanded && usersToShow.length > 0)
          : allUsers.length > 0) || usersFolderRefreshing;
      if (showUsersFolder) {
        const usersFolderItem = buildFolderTreeItem(
          usersFolderId,
          t("database.sidebar.users"),
          conn.config.id,
        );
        pushNode(rows, {
          kind: "node",
          key: usersFolderId,
          item: usersFolderItem,
          depth: baseDepth + 1,
          expanded: usersExpanded,
          hasChildren: true,
          meta:
            fullConnRefreshing || usersFolderRefreshing
              ? t("common.loading")
              : allUsers.length > 0
                ? String(allUsers.length)
                : undefined,
        });

        if (usersExpanded) {
          const pagedUsers = paginateSchemaChildren(
            usersToShow,
            usersFolderId,
            childVisibleLimits,
            paginateOpts,
          );
          for (const user of pagedUsers.visible) {
            const uid = userNodeId(conn.config.id, user.name, user.host);
            const userItem: SchemaTreeItem = {
              type: "user",
              id: uid,
              label: formatUserLabel(user.name, user.host),
              connId: conn.config.id,
            };
            const userRefreshing = Boolean(refreshingNodeIds[uid]);
            pushNode(rows, {
              kind: "node",
              key: uid,
              item: userItem,
              depth: baseDepth + 2,
              expanded: false,
              hasChildren: false,
              meta: userRefreshing ? t("common.loading") : undefined,
            });
          }
          if (!isSearchMode && pagedUsers.hasMore) {
            pushLoadMore(rows, usersFolderId, baseDepth + 2, pagedUsers.remaining);
          }
        }
      }
    }
}

function appendConnectionLayoutRows(
  rows: SchemaFlatRow[],
  params: SchemaFlatRowsParams,
  parentFolderId: string | null,
  baseDepth: number,
  ctx: SchemaFlatRowsBuildContext,
): void {
  const { connections, expandedNodeIds, childVisibleLimits, layoutFolders, connectionParents } = params;
  const { isSearchMode, paginateOpts } = ctx;
  const folders = layoutFolders ?? [];
  const parents = connectionParents ?? {};
  const parentKey = parentFolderId ?? SCHEMA_ROOT_CONNECTIONS_ID;
  const entries = listSchemaConnectionLayoutChildren(parentFolderId, folders, connections, parents);
  const paged = paginateSchemaChildren(entries, parentKey, childVisibleLimits, paginateOpts);

  for (const entry of paged.visible) {
    if (entry.kind === "folder") {
      const folderNodeId = schemaConnectionFolderNodeId(entry.folder.id);
      const folderExpanded = expandedNodeIds.has(folderNodeId);
      const folderItem = buildConnectionFolderTreeItem(folderNodeId, entry.folder.name);
      pushNode(rows, {
        kind: "node",
        key: folderNodeId,
        item: folderItem,
        depth: baseDepth,
        expanded: folderExpanded,
        hasChildren: true,
      });
      if (folderExpanded) {
        appendConnectionLayoutRows(rows, params, entry.folder.id, baseDepth + 1, ctx);
      }
      continue;
    }
    appendConnectionSchemaRows(rows, params, entry.connection, baseDepth, ctx);
  }

  if (!isSearchMode && paged.hasMore) {
    pushLoadMore(rows, parentKey, baseDepth, paged.remaining);
  }
}

export function buildSchemaFlatRows(params: SchemaFlatRowsParams): SchemaFlatRow[] {
  const { t, connections, childVisibleLimits, searchQuery } = params;

  const q = searchQuery?.trim() ?? "";
  const isSearchMode = q.length > 0;
  const paginateOpts = isSearchMode ? ({ unpaginated: true as const }) : undefined;
  const searchLabels = {
    tables: t("database.sidebar.tables"),
    views: t("database.sidebar.views"),
    other: t("database.sidebar.other"),
    fields: t("database.sidebar.fields"),
    indexes: t("database.sidebar.indexes"),
    users: t("database.sidebar.users"),
  };
  const routineLabel = (routineType: string) => routineTypeLabel(t, routineType);

  const rows: SchemaFlatRow[] = [];
  const ctx: SchemaFlatRowsBuildContext = {
    q,
    isSearchMode,
    paginateOpts,
    searchLabels,
    routineLabel,
  };

  if (isSearchMode) {
    const pagedRootConns = paginateSchemaChildren(
      connections,
      SCHEMA_ROOT_CONNECTIONS_ID,
      childVisibleLimits,
      paginateOpts,
    );
    for (const conn of pagedRootConns.visible) {
      appendConnectionSchemaRows(rows, params, conn, 0, ctx);
    }
    if (pagedRootConns.hasMore) {
      pushLoadMore(rows, SCHEMA_ROOT_CONNECTIONS_ID, 0, pagedRootConns.remaining);
    }
  } else {
    appendConnectionLayoutRows(rows, params, null, 0, ctx);
  }

  if (isSearchMode && !rows.some((row) => row.kind === "node")) {
    pushMessage(rows, "search-no-results", 0, t("common.noResults"), "empty");
  }

  return rows;
}

export function estimateSchemaFlatRowSize(row: SchemaFlatRow | undefined): number {
  if (!row) {
    return SCHEMA_TREE_NODE_ROW_HEIGHT;
  }
  if (row.kind === "message") {
    return SCHEMA_TREE_MESSAGE_ROW_HEIGHT;
  }
  if (row.kind === "load-more") {
    return SCHEMA_TREE_LOAD_MORE_ROW_HEIGHT;
  }
  return SCHEMA_TREE_NODE_ROW_HEIGHT;
}

export function findSchemaFlatRowIndexByNodeId(rows: SchemaFlatRow[], nodeId: string): number {
  return rows.findIndex((row) => row.kind === "node" && row.item.id === nodeId);
}

/** 累计到 rowIndex 之前所有行的像素偏移。 */
export function computeSchemaFlatRowOffset(rows: SchemaFlatRow[], rowIndex: number): number {
  let offset = 0;
  for (let i = 0; i < rowIndex; i++) {
    offset += estimateSchemaFlatRowSize(rows[i]!);
  }
  return offset;
}

/** 将 rowIndex 对应行滚动到视口垂直居中所需的 scrollTop。 */
export function computeSchemaFlatRowScrollTopForCenter(
  rows: SchemaFlatRow[],
  rowIndex: number,
  viewportHeight: number,
): number {
  if (rowIndex < 0 || rowIndex >= rows.length || viewportHeight <= 0) {
    return 0;
  }
  const offset = computeSchemaFlatRowOffset(rows, rowIndex);
  const rowHeight = estimateSchemaFlatRowSize(rows[rowIndex]!);
  return offset - Math.max(0, (viewportHeight - rowHeight) / 2);
}

/** 目标行是否已在视口内大致居中（用于避免重复滚动）。 */
export function isSchemaFlatRowIndexCenteredInViewport(
  container: HTMLElement,
  rows: SchemaFlatRow[],
  rowIndex: number,
  tolerancePx = 12,
): boolean {
  if (rowIndex < 0 || rowIndex >= rows.length) {
    return false;
  }
  const offset = computeSchemaFlatRowOffset(rows, rowIndex);
  const rowHeight = estimateSchemaFlatRowSize(rows[rowIndex]!);
  const rowCenter = offset + rowHeight / 2;
  const viewCenter = container.scrollTop + container.clientHeight / 2;
  return Math.abs(rowCenter - viewCenter) <= tolerancePx;
}

export type StickySchemaAncestor = {
  row: SchemaNodeFlatRow;
  rowIndex: number;
};

/** 根据首行可见索引，收集当前滚动上下文中的展开祖先节点。 */
export function collectStickySchemaAncestors(
  rows: SchemaFlatRow[],
  firstVisibleIndex: number,
): StickySchemaAncestor[] {
  if (rows.length === 0) {
    return [];
  }
  const stickyByDepth = new Map<number, StickySchemaAncestor>();
  const end = Math.max(0, Math.min(firstVisibleIndex, rows.length - 1));
  for (let i = 0; i <= end; i++) {
    const row = rows[i];
    if (row?.kind !== "node") {
      continue;
    }
    for (const depth of [...stickyByDepth.keys()]) {
      if (depth >= row.depth) {
        stickyByDepth.delete(depth);
      }
    }
    if (row.hasChildren && row.expanded) {
      stickyByDepth.set(row.depth, { row, rowIndex: i });
    }
  }
  return [...stickyByDepth.entries()]
    .sort(([leftDepth], [rightDepth]) => leftDepth - rightDepth)
    .map(([, entry]) => entry);
}

/** 过滤掉虚拟列表视口内已渲染的节点，避免吸顶条与列表重复。 */
export function filterStickySchemaAncestorsForOverlay(
  ancestors: StickySchemaAncestor[],
  visibleRowIndexes: readonly number[],
): StickySchemaAncestor[] {
  const visible = new Set(visibleRowIndexes);
  return ancestors.filter(({ rowIndex }) => !visible.has(rowIndex));
}

export function isSchemaFlatRowNodeInView(
  rows: SchemaFlatRow[],
  virtualItems: { index: number }[],
  nodeId: string,
): boolean {
  const index = findSchemaFlatRowIndexByNodeId(rows, nodeId);
  if (index < 0) {
    return false;
  }
  return virtualItems.some((item) => item.index === index);
}

/** 将虚拟列表中的目标行滚动到视口居中。 */
export function scrollSchemaFlatRowToCenter(
  container: HTMLElement,
  rows: SchemaFlatRow[],
  rowIndex: number,
  scrollToIndex?: (index: number) => void,
): void {
  if (rowIndex < 0 || rowIndex >= rows.length) {
    return;
  }
  scrollToIndex?.(rowIndex);
  const manualTop = computeSchemaFlatRowScrollTopForCenter(
    rows,
    rowIndex,
    container.clientHeight,
  );
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
  container.scrollTop = Math.min(maxScroll, Math.max(0, manualTop));
}
