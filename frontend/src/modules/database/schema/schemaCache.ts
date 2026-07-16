import type { DbTableSchema, DbRoutineMeta, DbUserMeta } from "../api";

export interface SchemaCacheDatabaseEntry {
  name: string;
  tables: DbTableSchema[];
  views?: DbTableSchema[];
  routines?: DbRoutineMeta[];
  loadError?: string;
  /** 已拉取表/视图/例程；连接浅刷新为 false */
  objectsLoaded?: boolean;
  /** Redis：INFO keyspace 的 keys 数 */
  keyCount?: number;
}

export interface SchemaCacheConnectionEntry {
  databases: SchemaCacheDatabaseEntry[];
  users?: DbUserMeta[];
  refreshedAt?: number;
  error?: string;
}

export interface SchemaCacheSnapshot {
  connections: Record<string, SchemaCacheConnectionEntry>;
}

export function emptySchemaCacheSnapshot(): SchemaCacheSnapshot {
  return { connections: {} };
}

/** 库节点是否还需要懒加载对象列表 */
export function databaseObjectsNeedLoad(db: {
  loadError?: string;
  objectsLoaded?: boolean;
  tables?: unknown[];
  views?: unknown[];
  routines?: unknown[];
}): boolean {
  if (db.loadError) {
    return false;
  }
  if (db.objectsLoaded) {
    return false;
  }
  const tables = db.tables?.length ?? 0;
  const views = db.views?.length ?? 0;
  const routines = db.routines?.length ?? 0;
  // 旧缓存已有对象则视为已加载，避免重复全量拉取
  return tables + views + routines === 0;
}

/** 表/视图是否还需要懒加载列与索引 */
export function tableDetailsNeedLoad(table: {
  columns?: unknown[];
  detailsError?: string;
}): boolean {
  if (table.detailsError) {
    return false;
  }
  return (table.columns?.length ?? 0) === 0;
}

function mergeTableListPreservingDetails(
  previous: DbTableSchema[] | undefined,
  incoming: DbTableSchema[],
): DbTableSchema[] {
  const prevByName = new Map((previous ?? []).map((table) => [table.name, table]));
  return incoming.map((table) => {
    const old = prevByName.get(table.name);
    if ((table.columns?.length ?? 0) === 0 && old && (old.columns?.length ?? 0) > 0) {
      return {
        ...old,
        comment: table.comment ?? old.comment,
      };
    }
    return table;
  });
}

/**
 * 库级浅刷新合并：新列表可只有对象名；保留本地已拉过的列/索引。
 */
export function mergeDatabaseSchemaCacheEntry(
  previous: SchemaCacheDatabaseEntry | undefined,
  incoming: SchemaCacheDatabaseEntry,
): SchemaCacheDatabaseEntry {
  if (!previous) {
    return { ...incoming, objectsLoaded: incoming.objectsLoaded ?? true };
  }
  return {
    ...incoming,
    tables: mergeTableListPreservingDetails(previous.tables, incoming.tables),
    views: mergeTableListPreservingDetails(previous.views, incoming.views ?? []),
    routines: (incoming.routines?.length ?? 0) > 0 ? incoming.routines : previous.routines,
    objectsLoaded: incoming.objectsLoaded ?? true,
    loadError: incoming.loadError,
    keyCount: incoming.keyCount ?? previous.keyCount,
  };
}

function databaseHasLoadedObjects(db: SchemaCacheDatabaseEntry): boolean {
  return Boolean(
    db.objectsLoaded ||
      (db.tables?.length ?? 0) > 0 ||
      (db.views?.length ?? 0) > 0 ||
      (db.routines?.length ?? 0) > 0,
  );
}

/**
 * 连接级浅刷新合并：保留本地已加载的库对象。
 * 手动刷新连接时只更新库名列表，不抹掉已缓存的表结构。
 */
export function mergeConnectionSchemaCacheEntry(
  previous: SchemaCacheConnectionEntry | undefined,
  incoming: SchemaCacheConnectionEntry,
): SchemaCacheConnectionEntry {
  if (incoming.error?.trim()) {
    if (!previous) {
      return incoming;
    }
    return {
      ...previous,
      refreshedAt: incoming.refreshedAt ?? previous.refreshedAt,
      error: incoming.error,
    };
  }
  if (!previous) {
    return incoming;
  }
  const prevByName = new Map(previous.databases.map((db) => [db.name, db]));
  const databases = incoming.databases.map((db) => {
    if (databaseHasLoadedObjects(db)) {
      return { ...db, objectsLoaded: db.objectsLoaded ?? true };
    }
    const old = prevByName.get(db.name);
    if (old && databaseHasLoadedObjects(old)) {
      return {
        ...old,
        objectsLoaded: true,
        keyCount: db.keyCount ?? old.keyCount,
      };
    }
    return { ...db, objectsLoaded: db.objectsLoaded ?? false };
  });
  return {
    ...incoming,
    databases,
    users: (incoming.users?.length ?? 0) > 0 ? incoming.users : previous.users,
    refreshedAt: incoming.refreshedAt ?? previous.refreshedAt,
    error: undefined,
  };
}
