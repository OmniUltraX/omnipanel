import type { DbConnectionConfig, DbTableDetails } from "../api";

const STORAGE_KEY = "omnipanel-table-details-cache.v1";

interface CachedTableDetailsEntry {
  connectionKey: string;
  dbName: string;
  tableName: string;
  details: DbTableDetails;
  updatedAt: number;
}

type TableDetailsCacheStore = Record<string, CachedTableDetailsEntry>;

function buildConnectionKey(
  connection: Pick<DbConnectionConfig, "host" | "port" | "db_type">,
): string {
  return `${connection.db_type}|${connection.host}|${connection.port}`;
}

function buildCacheKey(connId: string, dbName: string, tableName: string): string {
  return `${connId}|${dbName}|${tableName}`;
}

function readStore(): TableDetailsCacheStore {
  if (typeof localStorage === "undefined") {
    return {};
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as TableDetailsCacheStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: TableDetailsCacheStore): void {
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
  entry: CachedTableDetailsEntry,
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

/** 读取单表详情缓存。 */
export function readTableDetailsCache(
  connId: string,
  dbName: string,
  tableName: string,
  connection: DbConnectionConfig,
): DbTableDetails | null {
  const entry = readStore()[buildCacheKey(connId, dbName, tableName)];
  if (!entry) {
    return null;
  }
  if (!isEntryValid(entry, dbName, tableName, connection)) {
    return null;
  }
  return entry.details;
}

/** 批量读取当前库下多张表的详情缓存。 */
export function readTableDetailsCacheMap(
  connId: string,
  dbName: string,
  tableNames: string[],
  connection: DbConnectionConfig,
): Record<string, DbTableDetails> {
  const store = readStore();
  const result: Record<string, DbTableDetails> = {};
  for (const tableName of tableNames) {
    const entry = store[buildCacheKey(connId, dbName, tableName)];
    if (entry && isEntryValid(entry, dbName, tableName, connection)) {
      result[tableName] = entry.details;
    }
  }
  return result;
}

/** 写入单表详情缓存。 */
export function writeTableDetailsCache(
  connId: string,
  dbName: string,
  tableName: string,
  connection: DbConnectionConfig,
  details: DbTableDetails,
): void {
  const store = readStore();
  store[buildCacheKey(connId, dbName, tableName)] = {
    connectionKey: buildConnectionKey(connection),
    dbName,
    tableName,
    details,
    updatedAt: Date.now(),
  };
  writeStore(store);
}
