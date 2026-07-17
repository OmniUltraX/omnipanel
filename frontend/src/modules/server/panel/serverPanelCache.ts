import type { OnePanelApp, OnePanelInstalledApp } from "../../../lib/onepanel";
import type { ServerEntry } from "./serverConnection";

export type ServerPanelResourceCache = {
  websites: Record<string, unknown>[];
  certificates: Record<string, unknown>[];
  /** 应用市场列表（1Panel） */
  apps: OnePanelApp[];
  /** 已安装应用（用于市场卡片「已安装」标记） */
  installedApps: OnePanelInstalledApp[];
  refreshedAt: number | null;
  /** 应用商店单独刷新时间，与 websites/certificates 解耦 */
  appsRefreshedAt: number | null;
  error: string | null;
  appsError: string | null;
};

/** 稳定空缓存，避免 selector 每次返回新对象。 */
export const EMPTY_SERVER_PANEL_RESOURCE_CACHE: ServerPanelResourceCache = {
  websites: [],
  certificates: [],
  apps: [],
  installedApps: [],
  refreshedAt: null,
  appsRefreshedAt: null,
  error: null,
  appsError: null,
};

export const EMPTY_SERVER_PANEL_WEBSITES = EMPTY_SERVER_PANEL_RESOURCE_CACHE.websites;
export const EMPTY_SERVER_PANEL_CERTIFICATES = EMPTY_SERVER_PANEL_RESOURCE_CACHE.certificates;
export const EMPTY_SERVER_PANEL_APPS = EMPTY_SERVER_PANEL_RESOURCE_CACHE.apps;
export const EMPTY_SERVER_PANEL_INSTALLED_APPS = EMPTY_SERVER_PANEL_RESOURCE_CACHE.installedApps;

export function emptyServerPanelResourceCache(): ServerPanelResourceCache {
  return {
    websites: [],
    certificates: [],
    apps: [],
    installedApps: [],
    refreshedAt: null,
    appsRefreshedAt: null,
    error: null,
    appsError: null,
  };
}

/** 兼容旧版本地缓存缺少 apps 字段。 */
export function normalizeServerPanelResourceCache(
  raw: Partial<ServerPanelResourceCache> | null | undefined,
): ServerPanelResourceCache {
  if (!raw) return emptyServerPanelResourceCache();
  return {
    websites: Array.isArray(raw.websites) ? raw.websites : [],
    certificates: Array.isArray(raw.certificates) ? raw.certificates : [],
    apps: Array.isArray(raw.apps) ? raw.apps : [],
    installedApps: Array.isArray(raw.installedApps) ? raw.installedApps : [],
    refreshedAt: typeof raw.refreshedAt === "number" ? raw.refreshedAt : null,
    appsRefreshedAt: typeof raw.appsRefreshedAt === "number" ? raw.appsRefreshedAt : null,
    error: typeof raw.error === "string" ? raw.error : null,
    appsError: typeof raw.appsError === "string" ? raw.appsError : null,
  };
}

export function selectServerPanelResourceCache(serverId: string) {
  return (state: { resourcesByServerId: Record<string, ServerPanelResourceCache> }) =>
    state.resourcesByServerId[serverId] ?? EMPTY_SERVER_PANEL_RESOURCE_CACHE;
}

export function serverPanelResourceRefreshKey(serverId: string): string {
  return `server-panel:${serverId}`;
}

export type ServerPanelCacheServerMeta = Pick<
  ServerEntry,
  "id" | "name" | "address" | "serviceType" | "createdAt"
> & {
  /** 刷新远程资源时需要；持久化在本地缓存中 */
  key: string;
};
