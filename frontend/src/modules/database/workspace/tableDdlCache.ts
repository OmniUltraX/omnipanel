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

// ── 内存缓存 + 延迟合流写入 ──────────────────────────────────────
// 与 tableDetailsCache 同理：避免每次 read/write 全量 JSON.parse/stringify
// localStorage。读走内存（O(1)），写立即更新内存 + 延迟合流 setItem。
let memoryStore: TableDdlCacheStore | null = null;
let writeScheduled = false;

function loadFromLocalStorage(): TableDdlCacheStore {
  if (typeof localStorage === "undefined") {
    return {};
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as TableDdlCacheStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 获取内存缓存（首次访问时从 localStorage 懒加载）。 */
function getStore(): TableDdlCacheStore {
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
  const entry = getStore()[buildCacheKey(connId, dbName, tableName)];
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
  const store = getStore();
  store[buildCacheKey(connId, dbName, tableName)] = {
    connectionKey: buildConnectionKey(connection),
    dbName,
    tableName,
    ddl,
    updatedAt: Date.now(),
  };
  scheduleFlush();
}

/** 清除指定库下所有表的 DDL 缓存。 */
export function clearTableDdlCacheForDatabase(connId: string, dbName: string): void {
  const store = getStore();
  const prefix = `${connId}|${dbName}|`;
  let changed = false;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) {
    scheduleFlush();
  }
}
