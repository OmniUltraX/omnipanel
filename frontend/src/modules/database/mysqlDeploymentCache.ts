import type { DbConnectionConfig } from "./api";
import type { MysqlDeploymentInfo } from "./mysqlDeploymentDetect";
import { notifyDeploymentCacheUpdated } from "./deploymentServerTag";

const STORAGE_KEY = "omnipanel-mysql-deployment-cache.v2";

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

// ── 内存缓存 + 延迟合流写入 ──────────────────────────────────────
// buildDeploymentServerTagMap 会循环遍历所有连接调用 readMysqlDeploymentCache，
// 原实现每次都全量 JSON.parse(localStorage.getItem)，N 连接 = N 次完整读。
// 且每次 write/clear 触发 notifyDeploymentCacheUpdated → 循环重读，O(N²) 放大。
// 改为：首次访问懒加载到内存，读走内存（O(1)）；写立即更新内存 + 延迟合流 setItem。
let memoryStore: MysqlDeploymentCacheStore | null = null;
let writeScheduled = false;

function loadFromLocalStorage(): MysqlDeploymentCacheStore {
  if (typeof localStorage === "undefined") {
    return {};
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as MysqlDeploymentCacheStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getStore(): MysqlDeploymentCacheStore {
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

/** 读取本地缓存的部署信息；连接参数变更后自动视为无效。 */
export function readMysqlDeploymentCache(
  connection: DbConnectionConfig,
): MysqlDeploymentInfo | null {
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
export function isMysqlDeploymentCacheUsable(info: MysqlDeploymentInfo | null | undefined): boolean {
  return info?.kind === "host" || info?.kind === "docker";
}

/** 写入本地部署信息缓存。 */
export function writeMysqlDeploymentCache(
  connection: DbConnectionConfig,
  info: MysqlDeploymentInfo,
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

/** 清除指定连接的部署缓存（连接删除等场景可选调用）。 */
export function clearMysqlDeploymentCache(connectionId: string): void {
  const store = getStore();
  if (!(connectionId in store)) {
    return;
  }
  delete store[connectionId];
  scheduleFlush();
  notifyDeploymentCacheUpdated();
}
