import type { ServerEntry } from "./serverConnection";

export type ServerPanelResourceCache = {
  websites: Record<string, unknown>[];
  certificates: Record<string, unknown>[];
  refreshedAt: number | null;
  error: string | null;
};

/** 稳定空缓存，避免 selector 每次返回新对象。 */
export const EMPTY_SERVER_PANEL_RESOURCE_CACHE: ServerPanelResourceCache = {
  websites: [],
  certificates: [],
  refreshedAt: null,
  error: null,
};

export const EMPTY_SERVER_PANEL_WEBSITES = EMPTY_SERVER_PANEL_RESOURCE_CACHE.websites;
export const EMPTY_SERVER_PANEL_CERTIFICATES = EMPTY_SERVER_PANEL_RESOURCE_CACHE.certificates;

export function emptyServerPanelResourceCache(): ServerPanelResourceCache {
  return {
    websites: [],
    certificates: [],
    refreshedAt: null,
    error: null,
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
