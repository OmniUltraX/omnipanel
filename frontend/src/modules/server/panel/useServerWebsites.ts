import { useCallback } from "react";
import type { ServerEntry } from "./serverConnection";
import {
  EMPTY_SERVER_PANEL_RESOURCE_CACHE,
  type ServerPanelSiteGroup,
} from "./serverPanelCache";
import { useServerPanelCacheAutoRefresh } from "./useServerPanelCacheAutoRefresh";
import { useServerPanelCacheStore } from "../../../stores/serverPanelCacheStore";

interface UseServerWebsitesResult {
  items: Record<string, unknown>[];
  siteGroups: ServerPanelSiteGroup[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** 网站列表读本地缓存；无缓存/过期时自动回源，refresh 强制写入缓存。 */
export function useServerWebsites(server: ServerEntry | null): UseServerWebsitesResult {
  const serverId = server?.id ?? "";
  const entry = useServerPanelCacheStore((s) =>
    serverId
      ? (s.resourcesByServerId[serverId] ?? EMPTY_SERVER_PANEL_RESOURCE_CACHE)
      : EMPTY_SERVER_PANEL_RESOURCE_CACHE,
  );
  const refreshing = useServerPanelCacheStore((s) =>
    serverId ? Boolean(s.refreshingServerIds[serverId]) : false,
  );
  const refreshServer = useServerPanelCacheStore((s) => s.refreshServer);

  const hasCache = Boolean(serverId && entry.refreshedAt != null);

  const refresh = useCallback(async () => {
    if (!server) return;
    await refreshServer(server);
  }, [refreshServer, server]);

  useServerPanelCacheAutoRefresh({
    server,
    refreshedAt: entry.refreshedAt,
    refreshing,
    refresh: refreshServer,
  });

  return {
    items: Array.isArray(entry.websites) ? entry.websites : [],
    siteGroups: Array.isArray(entry.siteGroups) ? entry.siteGroups : [],
    loading: Boolean(server) && refreshing && !hasCache,
    refreshing: Boolean(server) && refreshing,
    error: serverId ? entry.error : null,
    refresh,
  };
}
