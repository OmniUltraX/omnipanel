import { useCallback } from "react";
import type { ServerEntry } from "./serverConnection";
import { EMPTY_SERVER_PANEL_RESOURCE_CACHE } from "./serverPanelCache";
import { useServerPanelCacheAutoRefresh } from "./useServerPanelCacheAutoRefresh";
import { useServerPanelCacheStore } from "../../../stores/serverPanelCacheStore";

interface UseServerCertificatesResult {
  items: Record<string, unknown>[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

type UseServerCertificatesOptions = {
  /** 默认 true；网站页签已通过 refreshServer 一并拉取时可关，避免重复触发 */
  autoRefresh?: boolean;
};

/** 证书列表读本地缓存；无缓存/过期时自动回源，refresh 强制写入缓存。 */
export function useServerCertificates(
  server: ServerEntry | null,
  options?: UseServerCertificatesOptions,
): UseServerCertificatesResult {
  const autoRefresh = options?.autoRefresh !== false;
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
    enabled: autoRefresh,
  });

  return {
    items: entry.certificates,
    loading: Boolean(server) && refreshing && !hasCache,
    refreshing: Boolean(server) && refreshing,
    error: serverId ? entry.error : null,
    refresh,
  };
}
