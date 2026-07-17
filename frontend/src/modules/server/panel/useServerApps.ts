import { useCallback, useEffect, useRef } from "react";
import type { OnePanelApp, OnePanelInstalledApp } from "../../../lib/onepanel";
import { useServerPanelCacheStore } from "../../../stores/serverPanelCacheStore";
import type { ServerEntry } from "./serverConnection";
import { EMPTY_SERVER_PANEL_RESOURCE_CACHE } from "./serverPanelCache";

interface UseServerAppsResult {
  apps: OnePanelApp[];
  installedApps: OnePanelInstalledApp[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** 应用市场只读本地缓存；无缓存时自动回源，refresh 强制写入缓存。 */
export function useServerApps(server: ServerEntry | null): UseServerAppsResult {
  const serverId = server?.id ?? "";
  const entry = useServerPanelCacheStore((s) =>
    serverId
      ? (s.resourcesByServerId[serverId] ?? EMPTY_SERVER_PANEL_RESOURCE_CACHE)
      : EMPTY_SERVER_PANEL_RESOURCE_CACHE,
  );
  const refreshing = useServerPanelCacheStore((s) =>
    serverId ? Boolean(s.refreshingAppsServerIds[serverId]) : false,
  );
  const refreshServerApps = useServerPanelCacheStore((s) => s.refreshServerApps);

  const hasCache = Boolean(serverId && entry.appsRefreshedAt != null);
  const autoFetchKeyRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!server) return;
    await refreshServerApps(server);
  }, [refreshServerApps, server]);

  // 首次进入或切换面板且无应用缓存时自动拉取
  useEffect(() => {
    if (!server || server.serviceType !== "1panel") return;
    if (entry.appsRefreshedAt != null) return;
    if (refreshing) return;
    const key = server.id;
    if (autoFetchKeyRef.current === key) return;
    autoFetchKeyRef.current = key;
    void refreshServerApps(server);
  }, [entry.appsRefreshedAt, refreshServerApps, refreshing, server]);

  return {
    apps: Array.isArray(entry.apps) ? entry.apps : [],
    installedApps: Array.isArray(entry.installedApps) ? entry.installedApps : [],
    loading: Boolean(server) && refreshing && !hasCache,
    refreshing,
    error: serverId ? (entry.appsError ?? null) : null,
    refresh,
  };
}
