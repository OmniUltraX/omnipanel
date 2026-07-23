import type { DbConnectionConfig } from "./api";
import type { RedisDeploymentInfo } from "./redisDeploymentDetect";
import { notifyDeploymentCacheUpdated } from "./deploymentServerTag";

const STORAGE_KEY = "omnipanel-redis-deployment-cache.v2";

interface CachedRedisDeploymentEntry {
  connectionKey: string;
  info: RedisDeploymentInfo;
  updatedAt: number;
}

type RedisDeploymentCacheStore = Record<string, CachedRedisDeploymentEntry>;

function buildConnectionKey(
  connection: Pick<DbConnectionConfig, "host" | "port" | "db_type">,
): string {
  return `${connection.db_type}|${connection.host}|${connection.port}`;
}

// ── 内存缓存 + 延迟合流写入 ──────────────────────────────────────
// buildDeploymentServerTagMap 会循环遍历所有连接调用 readRedisDeploymentCache，
// 原实现每次都全量 JSON.parse(localStorage.getItem)，N 连接 = N 次完整读。
// 且每次 write/clear 触发 notifyDeploymentCacheUpdated → 循环重读，O(N²) 放大。
// 改为：首次访问懒加载到内存，读走内存（O(1)）；写立即更新内存 + 延迟合流 setItem。
let memoryStore: RedisDeploymentCacheStore | null = null;
let writeScheduled = false;

function loadFromLocalStorage(): RedisDeploymentCacheStore {
  if (typeof localStorage === "undefined") {
    return {};
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as RedisDeploymentCacheStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getStore(): RedisDeploymentCacheStore {
  if (memoryStore === null) {
    memoryStore = loadFromLocalStorage();
  }
  return memoryStore;
}

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

/** 读取本地缓存的 Redis 部署信息；连接参数变更后自动视为无效。 */
export function readRedisDeploymentCache(
  connection: DbConnectionConfig,
): RedisDeploymentInfo | null {
  const entry = getStore()[connection.id];
  if (!entry) {
    return null;
  }
  if (entry.connectionKey !== buildConnectionKey(connection)) {
    return null;
  }
  return entry.info;
}

/** 缓存是否可直接展示（无需再次探测）。 */
export function isRedisDeploymentCacheUsable(info: RedisDeploymentInfo | null | undefined): boolean {
  return info?.kind === "host" || info?.kind === "docker";
}

/** 写入本地 Redis 部署信息缓存。 */
export function writeRedisDeploymentCache(
  connection: DbConnectionConfig,
  info: RedisDeploymentInfo,
): void {
  const store = getStore();
  store[connection.id] = {
    connectionKey: buildConnectionKey(connection),
    info,
    updatedAt: Date.now(),
  };
  scheduleFlush();
  notifyDeploymentCacheUpdated();
}

/** 清除指定连接的 Redis 部署缓存。 */
export function clearRedisDeploymentCache(connectionId: string): void {
  const store = getStore();
  if (!(connectionId in store)) {
    return;
  }
  delete store[connectionId];
  scheduleFlush();
  notifyDeploymentCacheUpdated();
}
