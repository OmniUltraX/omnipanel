import { useCallback } from "react";
import type { ServerEntry } from "./serverConnection";
import { EMPTY_SERVER_PANEL_RESOURCE_CACHE } from "./serverPanelCache";
import { useServerPanelCacheStore } from "../../../stores/serverPanelCacheStore";

interface UseServerWebsitesResult {
  items: Record<string, unknown>[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** 网站列表只读本地缓存；refresh 才会回源写入缓存。 */
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

  return {
    items: entry.websites,
    loading: Boolean(server) && refreshing && !hasCache,
    error: serverId ? entry.error : null,
    refresh,
  };
}
