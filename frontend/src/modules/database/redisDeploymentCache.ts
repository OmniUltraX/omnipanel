import type { DbConnectionConfig } from "./api";
import type { RedisDeploymentInfo } from "./redisDeploymentDetect";

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

function readStore(): RedisDeploymentCacheStore {
  if (typeof localStorage === "undefined") {
    return {};
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as RedisDeploymentCacheStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: RedisDeploymentCacheStore): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore quota / private mode errors
  }
}

/** 读取本地缓存的 Redis 部署信息；连接参数变更后自动视为无效。 */
export function readRedisDeploymentCache(
  connection: DbConnectionConfig,
): RedisDeploymentInfo | null {
  const entry = readStore()[connection.id];
  if (!entry) {
    return null;
  }
  if (entry.connectionKey !== buildConnectionKey(connection)) {
    return null;
  }
  return entry.info;
}

/** 写入本地 Redis 部署信息缓存。 */
export function writeRedisDeploymentCache(
  connection: DbConnectionConfig,
  info: RedisDeploymentInfo,
): void {
  const store = readStore();
  store[connection.id] = {
    connectionKey: buildConnectionKey(connection),
    info,
    updatedAt: Date.now(),
  };
  writeStore(store);
}

/** 清除指定连接的 Redis 部署缓存。 */
export function clearRedisDeploymentCache(connectionId: string): void {
  const store = readStore();
  if (!(connectionId in store)) {
    return;
  }
  delete store[connectionId];
  writeStore(store);
}
