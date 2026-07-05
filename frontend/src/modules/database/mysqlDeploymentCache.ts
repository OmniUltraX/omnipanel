import type { DbConnectionConfig } from "./api";
import type { MysqlDeploymentInfo } from "./mysqlDeploymentDetect";

const STORAGE_KEY = "omnipanel-mysql-deployment-cache.v3";

interface CachedMysqlDeploymentEntry {
  connectionKey: string;
  info: MysqlDeploymentInfo;
  updatedAt: number;
}

type MysqlDeploymentCacheStore = Record<string, CachedMysqlDeploymentEntry>;

function buildConnectionKey(
  connection: Pick<DbConnectionConfig, "host" | "port" | "db_type">,
): string {
  return `${connection.db_type}|${connection.host}|${connection.port}`;
}

function readStore(): MysqlDeploymentCacheStore {
  if (typeof localStorage === "undefined") {
    return {};
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as MysqlDeploymentCacheStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: MysqlDeploymentCacheStore): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore quota / private mode errors
  }
}

/** 读取本地缓存的部署信息；连接参数变更后自动视为无效。 */
export function readMysqlDeploymentCache(
  connection: DbConnectionConfig,
): MysqlDeploymentInfo | null {
  const entry = readStore()[connection.id];
  if (!entry) {
    return null;
  }
  if (entry.connectionKey !== buildConnectionKey(connection)) {
    return null;
  }
  return entry.info;
}

/** 写入本地部署信息缓存。 */
export function writeMysqlDeploymentCache(
  connection: DbConnectionConfig,
  info: MysqlDeploymentInfo,
): void {
  const store = readStore();
  store[connection.id] = {
    connectionKey: buildConnectionKey(connection),
    info,
    updatedAt: Date.now(),
  };
  writeStore(store);
}

/** 清除指定连接的部署缓存（连接删除等场景可选调用）。 */
export function clearMysqlDeploymentCache(connectionId: string): void {
  const store = readStore();
  if (!(connectionId in store)) {
    return;
  }
  delete store[connectionId];
  writeStore(store);
}
