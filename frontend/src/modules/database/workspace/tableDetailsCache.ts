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

// ── 内存缓存 + 延迟合流写入 ──────────────────────────────────────
// 原实现每次 read/write 都全量 JSON.parse/stringify localStorage，
// 在 loadTableDetails 循环里对 N 张表调用 writeTableDetailsCache 时
// 会产生 N 次完整 localStorage 往返（profile 中占 750ms+287ms）。
// 改为：首次访问时懒加载到内存，后续读直接走内存（O(1)）；
// 写操作立即更新内存，延迟到空闲帧再合流写入 localStorage。
let memoryStore: TableDetailsCacheStore | null = null;
let writeScheduled = false;

function loadFromLocalStorage(): TableDetailsCacheStore {
  if (typeof localStorage === "undefined") {
    return {};
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as TableDetailsCacheStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 获取内存缓存（首次访问时从 localStorage 懒加载）。 */
function getStore(): TableDetailsCacheStore {
  if (memoryStore === null) {
    memoryStore = loadFromLocalStorage();
  }
  return memoryStore;
}

/** 将内存缓存延迟合流写入 localStorage（同帧多次写只产生一次 setItem）。 */
function scheduleFlush(): void {
  if (writeScheduled || typeof localStorage === "undefined") return;
  writeScheduled = true;
  const flush = () => {
    writeScheduled = false;
    if (memoryStore === null) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(memoryStore));
    } catch {
      // ignore quota / private mode errors
    }
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(flush, { timeout: 2000 });
  } else {
    setTimeout(flush, 16);
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
  const entry = getStore()[buildCacheKey(connId, dbName, tableName)];
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
  const store = getStore();
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
  const store = getStore();
  store[buildCacheKey(connId, dbName, tableName)] = {
    connectionKey: buildConnectionKey(connection),
    dbName,
    tableName,
    details,
    updatedAt: Date.now(),
  };
  scheduleFlush();
}
