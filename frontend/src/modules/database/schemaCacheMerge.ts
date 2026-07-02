import type { DbColumnMeta, DbConnectionConfig } from "./api";
import type { SchemaCacheSnapshot } from "./schemaCache";

export interface CachedTableColumn {
  name: string;
  type: string;
  isPk?: boolean;
  isFk?: boolean;
  comment?: string | null;
  nullable?: boolean;
  isAutoIncrement?: boolean;
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
  columns: {
    name: string;
    type: string;
    isPk: boolean;
    isFk: boolean;
    comment?: string | null;
    nullable?: boolean;
    isAutoIncrement?: boolean;
  }[];
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
      comment: col.comment ?? undefined,
      nullable: col.nullable,
      isAutoIncrement: col.isAutoIncrement,
    })),
    indexes: (table.indexes ?? []).map((idx) => ({
      name: idx.name,
      columns: idx.columns,
      unique: idx.unique,
    })),
  };
}

function cachedTableEqual(a: CachedTable, b: CachedTable): boolean {
  if (a.name !== b.name || a.comment !== b.comment || a.detailsError !== b.detailsError) {
    return false;
  }
  const aCols = a.columns ?? [];
  const bCols = b.columns ?? [];
  if (aCols.length !== bCols.length) return false;
  for (let i = 0; i < aCols.length; i += 1) {
    const left = aCols[i]!;
    const right = bCols[i]!;
    if (
      left.name !== right.name ||
      left.type !== right.type ||
      left.isPk !== right.isPk ||
      left.isFk !== right.isFk ||
      left.comment !== right.comment ||
      left.nullable !== right.nullable ||
      left.isAutoIncrement !== right.isAutoIncrement
    ) {
      return false;
    }
  }
  const aIdx = a.indexes ?? [];
  const bIdx = b.indexes ?? [];
  if (aIdx.length !== bIdx.length) return false;
  for (let i = 0; i < aIdx.length; i += 1) {
    const left = aIdx[i]!;
    const right = bIdx[i]!;
    if (
      left.name !== right.name ||
      left.unique !== right.unique ||
      left.columns.length !== right.columns.length ||
      left.columns.some((col, j) => col !== right.columns[j])
    ) {
      return false;
    }
  }
  return true;
}

function mapCachedTableWithReuse(
  prev: CachedTable | undefined,
  table: Parameters<typeof mapCachedTable>[0],
): CachedTable {
  const next = mapCachedTable(table);
  if (prev && cachedTableEqual(prev, next)) {
    return prev;
  }
  return next;
}

function mapCachedDatabaseWithReuse(
  prev: CachedDatabase | undefined,
  db: {
    name: string;
    loadError?: string;
    tables: Parameters<typeof mapCachedTable>[0][];
    views?: Parameters<typeof mapCachedTable>[0][];
    routines?: { name: string; routineType: string }[];
  },
): CachedDatabase {
  const prevTables = prev?.tables ?? [];
  const prevViews = prev?.views ?? [];
  const prevRoutines = prev?.routines ?? [];
  const tables = db.tables.map((table) =>
    mapCachedTableWithReuse(
      prevTables.find((item) => item.name === table.name),
      table,
    ),
  );
  const views = (db.views ?? []).map((view) =>
    mapCachedTableWithReuse(
      prevViews.find((item) => item.name === view.name),
      view,
    ),
  );
  const routines = (db.routines ?? []).map((routine) => {
    const prevRoutine = prevRoutines.find((item) => item.name === routine.name);
    if (
      prevRoutine &&
      prevRoutine.name === routine.name &&
      prevRoutine.routineType === routine.routineType
    ) {
      return prevRoutine;
    }
    return { name: routine.name, routineType: routine.routineType };
  });
  const next: CachedDatabase = {
    name: db.name,
    loadError: db.loadError,
    tables,
    views,
    routines,
  };
  if (
    prev &&
    prev.name === next.name &&
    prev.loadError === next.loadError &&
    prev.tables === next.tables &&
    prev.views === next.views &&
    prev.routines === next.routines
  ) {
    return prev;
  }
  return next;
}

export function mergeConnectionsWithCache(
  configs: DbConnectionConfig[],
  snapshot: SchemaCacheSnapshot,
  previous?: CachedConnection[] | null,
): CachedConnection[] {
  return configs.map((config) => {
    const entry = snapshot.connections[config.id];
    const prev = previous?.find((item) => item.config.id === config.id);
    if (!entry) {
      return prev?.config === config ? prev : { config };
    }
    const users = (entry.users ?? []).map((user) => ({
      name: user.name,
      host: user.host ?? undefined,
    }));
    const databases = entry.databases.map((db) =>
      mapCachedDatabaseWithReuse(
        prev?.databases?.find((item) => item.name === db.name),
        db,
      ),
    );
    const next: CachedConnection = {
      config,
      databasesError: entry.error,
      users,
      databases,
    };
    if (
      prev &&
      prev.config === config &&
      prev.databasesError === next.databasesError &&
      prev.databases === next.databases &&
      prev.users === next.users
    ) {
      return prev;
    }
    return next;
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

export function getCachedTableColumns(
  snapshot: SchemaCacheSnapshot,
  connId: string,
  dbName: string,
  tableName: string,
): DbColumnMeta[] | null {
  const db = snapshot.connections[connId]?.databases.find((entry) => entry.name === dbName);
  const table = db?.tables.find((entry) => entry.name === tableName);
  if (!table?.columns?.length) {
    return null;
  }
  return table.columns.map((col) => ({
    name: col.name,
    type: col.type,
    isPk: col.isPk,
    isFk: col.isFk,
    nullable: col.nullable,
    isAutoIncrement: col.isAutoIncrement,
    comment: col.comment ?? undefined,
  }));
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
