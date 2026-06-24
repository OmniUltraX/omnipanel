import { textSearchMatches } from "../../lib/textSearchMatch";
import type { SchemaFilterState } from "./DatabaseFilterDialog";
import { getVisibleItems } from "./DatabaseFilterDialog";
import { connectionHasTableSchemaChildren, isConnectionEnabled, isRedisConnection } from "./api";
import type {
  CachedConnection,
  CachedDatabase,
  CachedRoutine,
  CachedTable,
  CachedTableColumn,
  CachedTableIndex,
  CachedUser,
} from "./schemaCacheMerge";
import {
  connectionUsersFolderId,
  databaseOtherFolderId,
  databaseTablesFolderId,
  databaseViewsFolderId,
  formatUserLabel,
  makeDatabaseNodeId,
  makeTableNodeId,
  makeViewNodeId,
} from "./schemaTreeIds";

export type SchemaSearchLabels = {
  tables: string;
  views: string;
  other: string;
  fields: string;
  indexes: string;
  users: string;
};

function tableColumnsFolderId(tableId: string) {
  return `${tableId}:cols`;
}

function tableIndexesFolderId(tableId: string) {
  return `${tableId}:idxs`;
}

export function schemaSearchMatches(
  query: string,
  ...texts: (string | undefined | null)[]
): boolean {
  const q = query.trim();
  if (!q) {
    return true;
  }
  return texts.some((text) => text && textSearchMatches(q, text));
}

export function schemaTableObjectMatchesSearch(
  query: string,
  tbl: CachedTable,
): boolean {
  return schemaSearchMatches(query, tbl.name, tbl.comment);
}

export function schemaColumnMatchesSearch(query: string, col: CachedTableColumn): boolean {
  return schemaSearchMatches(query, col.name, col.type);
}

export function schemaIndexMatchesSearch(query: string, idx: CachedTableIndex): boolean {
  return schemaSearchMatches(query, idx.name, idx.columns.join(", "));
}

export function schemaTableObjectSubtreeMatchesSearch(
  query: string,
  tbl: CachedTable,
  objectKind: "table" | "view",
): boolean {
  if (schemaTableObjectMatchesSearch(query, tbl)) {
    return true;
  }
  const columns = tbl.columns ?? [];
  if (columns.some((col) => schemaColumnMatchesSearch(query, col))) {
    return true;
  }
  if (objectKind === "table") {
    return (tbl.indexes ?? []).some((idx) => schemaIndexMatchesSearch(query, idx));
  }
  return false;
}

export function schemaRoutineMatchesSearch(
  query: string,
  routine: CachedRoutine,
  routineTypeLabel: string,
): boolean {
  return schemaSearchMatches(query, routine.name, routineTypeLabel, routine.routineType);
}

export function schemaUserMatchesSearch(query: string, user: CachedUser): boolean {
  return schemaSearchMatches(query, user.name, user.host, formatUserLabel(user.name, user.host));
}

/** 在已展开路径内判断表/视图是否应出现在搜索结果中。 */
export function schemaTableObjectSearchMatchesUnderExpanded(
  query: string,
  tbl: CachedTable,
  objectKind: "table" | "view",
  tableKey: string,
  expandedNodeIds: ReadonlySet<string>,
  connConfig: CachedConnection["config"],
  labels: Pick<SchemaSearchLabels, "fields" | "indexes">,
): boolean {
  if (schemaTableObjectMatchesSearch(query, tbl)) {
    return true;
  }
  if (!expandedNodeIds.has(tableKey) || !connectionHasTableSchemaChildren(connConfig)) {
    return false;
  }
  const colsFolderId = tableColumnsFolderId(tableKey);
  if (expandedNodeIds.has(colsFolderId)) {
    if (schemaSearchMatches(query, labels.fields)) {
      return true;
    }
    if ((tbl.columns ?? []).some((col) => schemaColumnMatchesSearch(query, col))) {
      return true;
    }
  }
  if (objectKind !== "table") {
    return false;
  }
  const idxFolderId = tableIndexesFolderId(tableKey);
  if (expandedNodeIds.has(idxFolderId)) {
    if (schemaSearchMatches(query, labels.indexes)) {
      return true;
    }
    if ((tbl.indexes ?? []).some((idx) => schemaIndexMatchesSearch(query, idx))) {
      return true;
    }
  }
  return false;
}

/** 在已展开路径内判断数据库是否应出现在搜索结果中。 */
export function schemaDatabaseSearchMatchesUnderExpanded(
  query: string,
  db: CachedDatabase,
  dbId: string,
  conn: CachedConnection,
  expandedNodeIds: ReadonlySet<string>,
  tableFilter: SchemaFilterState | undefined,
  labels: SchemaSearchLabels,
  routineTypeLabel: (routineType: string) => string,
): boolean {
  if (schemaSearchMatches(query, db.name)) {
    return true;
  }
  if (!expandedNodeIds.has(dbId) || isRedisConnection(conn.config)) {
    return false;
  }
  const connId = conn.config.id;
  const tblsFolderId = databaseTablesFolderId(connId, db.name);
  const viewsFolderId = databaseViewsFolderId(connId, db.name);
  const otherFolderId = databaseOtherFolderId(connId, db.name);
  const visibleTables = getVisibleItems(db.tables ?? [], tableFilter);

  if (expandedNodeIds.has(tblsFolderId)) {
    if (schemaSearchMatches(query, labels.tables)) {
      return true;
    }
    for (const tbl of visibleTables) {
      const tableKey = makeTableNodeId(connId, db.name, tbl.name);
      if (
        schemaTableObjectSearchMatchesUnderExpanded(
          query,
          tbl,
          "table",
          tableKey,
          expandedNodeIds,
          conn.config,
          labels,
        )
      ) {
        return true;
      }
    }
  }

  if (expandedNodeIds.has(viewsFolderId)) {
    if (schemaSearchMatches(query, labels.views)) {
      return true;
    }
    for (const view of db.views ?? []) {
      const tableKey = makeViewNodeId(connId, db.name, view.name);
      if (
        schemaTableObjectSearchMatchesUnderExpanded(
          query,
          view,
          "view",
          tableKey,
          expandedNodeIds,
          conn.config,
          labels,
        )
      ) {
        return true;
      }
    }
  }

  if (expandedNodeIds.has(otherFolderId)) {
    if (schemaSearchMatches(query, labels.other)) {
      return true;
    }
    for (const routine of db.routines ?? []) {
      if (schemaRoutineMatchesSearch(query, routine, routineTypeLabel(routine.routineType))) {
        return true;
      }
    }
  }

  return false;
}

/** 在已展开路径内判断连接是否应出现在搜索结果中。 */
export function schemaConnectionSearchMatchesUnderExpanded(
  query: string,
  conn: CachedConnection,
  expandedNodeIds: ReadonlySet<string>,
  databaseFilters: Record<string, SchemaFilterState | undefined>,
  tableFilters: Record<string, SchemaFilterState | undefined>,
  makeTableFilterKey: (connId: string, dbName: string) => string,
  labels: SchemaSearchLabels,
  routineTypeLabel: (routineType: string) => string,
): boolean {
  const connId = `conn:${conn.config.id}`;
  if (schemaSearchMatches(query, conn.config.name)) {
    return true;
  }
  if (!isConnectionEnabled(conn.config) || !expandedNodeIds.has(connId)) {
    return false;
  }

  const visibleDatabases = getVisibleItems(conn.databases ?? [], databaseFilters[conn.config.id]);
  for (const db of visibleDatabases) {
    const dbId = makeDatabaseNodeId(conn.config.id, db.name);
    const tableFilter = tableFilters[makeTableFilterKey(conn.config.id, db.name)];
    if (
      schemaDatabaseSearchMatchesUnderExpanded(
        query,
        db,
        dbId,
        conn,
        expandedNodeIds,
        tableFilter,
        labels,
        routineTypeLabel,
      )
    ) {
      return true;
    }
  }

  const usersFolderId = connectionUsersFolderId(conn.config.id);
  if (expandedNodeIds.has(usersFolderId)) {
    if (schemaSearchMatches(query, labels.users)) {
      return true;
    }
    if ((conn.users ?? []).some((user) => schemaUserMatchesSearch(query, user))) {
      return true;
    }
  }

  return false;
}

export function schemaDatabaseSubtreeMatchesSearch(
  query: string,
  db: CachedDatabase,
  tableFilter: SchemaFilterState | undefined,
  labels: {
    tables: string;
    views: string;
    other: string;
    fields: string;
    indexes: string;
  },
  routineTypeLabel: (routineType: string) => string,
): boolean {
  if (schemaSearchMatches(query, db.name)) {
    return true;
  }
  if (schemaSearchMatches(query, labels.tables, labels.views, labels.other)) {
    return true;
  }
  const tables = getVisibleItems(db.tables ?? [], tableFilter);
  if (tables.some((tbl) => schemaTableObjectSubtreeMatchesSearch(query, tbl, "table"))) {
    return true;
  }
  if ((db.views ?? []).some((view) => schemaTableObjectSubtreeMatchesSearch(query, view, "view"))) {
    return true;
  }
  if (
    (db.routines ?? []).some((routine) =>
      schemaRoutineMatchesSearch(query, routine, routineTypeLabel(routine.routineType)),
    )
  ) {
    return true;
  }
  return false;
}

export function schemaConnectionSubtreeMatchesSearch(
  query: string,
  conn: CachedConnection,
  tableFilters: Record<string, SchemaFilterState | undefined>,
  makeTableFilterKey: (connId: string, dbName: string) => string,
  labels: {
    tables: string;
    views: string;
    other: string;
    fields: string;
    indexes: string;
    users: string;
  },
  routineTypeLabel: (routineType: string) => string,
): boolean {
  if (schemaSearchMatches(query, conn.config.name)) {
    return true;
  }
  if (schemaSearchMatches(query, labels.users)) {
    return true;
  }
  const databases = conn.databases ?? [];
  for (const db of databases) {
    const tableFilter = tableFilters[makeTableFilterKey(conn.config.id, db.name)];
    if (
      schemaDatabaseSubtreeMatchesSearch(query, db, tableFilter, labels, routineTypeLabel)
    ) {
      return true;
    }
  }
  if ((conn.users ?? []).some((user) => schemaUserMatchesSearch(query, user))) {
    return true;
  }
  return false;
}
