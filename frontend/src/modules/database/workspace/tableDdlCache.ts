import type { DbConnectionConfig } from "../api";

const STORAGE_KEY = "omnipanel-table-ddl-cache.v1";

interface CachedTableDdlEntry {
  connectionKey: string;
  dbName: string;
  tableName: string;
  ddl: string;
  updatedAt: number;
}

type TableDdlCacheStore = Record<string, CachedTableDdlEntry>;

function buildConnectionKey(
  connection: Pick<DbConnectionConfig, "host" | "port" | "db_type">,
): string {
  return `${connection.db_type}|${connection.host}|${connection.port}`;
}

function buildCacheKey(connId: string, dbName: string, tableName: string): string {
  return `${connId}|${dbName}|${tableName}`;
}

function readStore(): TableDdlCacheStore {
  if (typeof localStorage === "undefined") {
    return {};
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as TableDdlCacheStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: TableDdlCacheStore): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore quota / private mode errors
  }
}

function isEntryValid(
  entry: CachedTableDdlEntry,
  dbName: string,
  tableName: string,
  connection: DbConnectionConfig,
): boolean {
  return (
    entry.connectionKey === buildConnectionKey(connection) &&
    entry.dbName === dbName &&
    entry.tableName === tableName
  );
}

/** 读取单表 DDL 缓存（已格式化的展示文本）。 */
export function readTableDdlCache(
  connId: string,
  dbName: string,
  tableName: string,
  connection: DbConnectionConfig,
): string | null {
  const entry = readStore()[buildCacheKey(connId, dbName, tableName)];
  if (!entry) {
    return null;
  }
  if (!isEntryValid(entry, dbName, tableName, connection)) {
    return null;
  }
  return entry.ddl;
}

/** 写入单表 DDL 缓存。 */
export function writeTableDdlCache(
  connId: string,
  dbName: string,
  tableName: string,
  connection: DbConnectionConfig,
  ddl: string,
): void {
  const store = readStore();
  store[buildCacheKey(connId, dbName, tableName)] = {
    connectionKey: buildConnectionKey(connection),
    dbName,
    tableName,
    ddl,
    updatedAt: Date.now(),
  };
  writeStore(store);
}

/** 清除指定库下所有表的 DDL 缓存。 */
export function clearTableDdlCacheForDatabase(connId: string, dbName: string): void {
  const store = readStore();
  const prefix = `${connId}|${dbName}|`;
  let changed = false;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) {
    writeStore(store);
  }
}
