import type { DbConnectionConfig } from "./api";
import type { SchemaCacheSnapshot } from "./schemaCache";

export interface CachedTableColumn {
  name: string;
  type: string;
  isPk?: boolean;
  isFk?: boolean;
}

export interface CachedTableIndex {
  name: string;
  columns: string[];
  unique?: boolean;
}

export interface CachedTable {
  name: string;
  comment?: string;
  columns?: CachedTableColumn[];
  indexes?: CachedTableIndex[];
  detailsError?: string;
}

export interface CachedRoutine {
  name: string;
  routineType: string;
}

export interface CachedUser {
  name: string;
  host?: string | null;
}

export interface CachedDatabase {
  name: string;
  tables?: CachedTable[];
  views?: CachedTable[];
  routines?: CachedRoutine[];
  loadError?: string;
}

export interface CachedConnection {
  config: DbConnectionConfig;
  databases?: CachedDatabase[];
  users?: CachedUser[];
  databasesError?: string;
}

function mapCachedTable(table: {
  name: string;
  comment?: string | null;
  columns: { name: string; type: string; isPk: boolean; isFk: boolean }[];
  indexes?: { name: string; columns: string[]; unique: boolean }[];
}): CachedTable {
  return {
    name: table.name,
    comment: table.comment ?? undefined,
    columns: table.columns.map((col) => ({
      name: col.name,
      type: col.type,
      isPk: col.isPk,
      isFk: col.isFk,
    })),
    indexes: (table.indexes ?? []).map((idx) => ({
      name: idx.name,
      columns: idx.columns,
      unique: idx.unique,
    })),
  };
}

export function mergeConnectionsWithCache(
  configs: DbConnectionConfig[],
  snapshot: SchemaCacheSnapshot,
): CachedConnection[] {
  return configs.map((config) => {
    const entry = snapshot.connections[config.id];
    if (!entry) {
      return { config };
    }
    return {
      config,
      databasesError: entry.error,
      users: (entry.users ?? []).map((user) => ({
        name: user.name,
        host: user.host ?? undefined,
      })),
      databases: entry.databases.map((db) => ({
        name: db.name,
        loadError: db.loadError,
        tables: db.tables.map(mapCachedTable),
        views: (db.views ?? []).map(mapCachedTable),
        routines: (db.routines ?? []).map((routine) => ({
          name: routine.name,
          routineType: routine.routineType,
        })),
      })),
    };
  });
}

export function getCachedDatabaseNames(
  snapshot: SchemaCacheSnapshot,
  connId: string,
): string[] {
  return snapshot.connections[connId]?.databases.map((db) => db.name) ?? [];
}

export function getCachedTableNames(
  snapshot: SchemaCacheSnapshot,
  connId: string,
  dbName: string,
): string[] {
  const db = snapshot.connections[connId]?.databases.find((entry) => entry.name === dbName);
  return db?.tables.map((table) => table.name) ?? [];
}

export function getCachedTableCommentMap(
  snapshot: SchemaCacheSnapshot,
  connId: string,
  dbName: string,
): Map<string, string> {
  const db = snapshot.connections[connId]?.databases.find((entry) => entry.name === dbName);
  const map = new Map<string, string>();
  for (const table of db?.tables ?? []) {
    const comment = table.comment?.trim();
    if (comment) {
      map.set(table.name, comment);
    }
  }
  return map;
}
