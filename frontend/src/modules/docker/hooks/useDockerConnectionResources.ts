import { useCallback, useEffect, useMemo } from "react";
import type { DockerConnectionInfo } from "../../../ipc/bindings";
import {
  dockerSidebarConnectionRefreshKey,
  selectDockerSidebarCacheEntry,
  selectEmptyDockerSidebarCacheEntry,
} from "../dockerSidebarCache";
import { isOnePanelDockerSource } from "../dockerConnectionSource";
import { useDockerSidebarCacheStore } from "@/stores/dockerSidebarCacheStore";

/** 侧栏资源树当前优先支持 1Panel / 面板适配来源。 */
export function connectionSupportsSidebarResources(connection: DockerConnectionInfo): boolean {
  return isOnePanelDockerSource(connection.source);
}

function hasCachedResources(connectionId: string): boolean {
  const entry = useDockerSidebarCacheStore.getState().getEntry(connectionId);
  return entry.refreshedAt != null;
}

/**
 * 读取单个 Docker 连接的侧栏资源缓存；展开连接时若无缓存则后台拉取并写入本地缓存。
 */
export function useDockerConnectionResources(connection: DockerConnectionInfo | null) {
  const connectionId = connection?.connectionId ?? null;
  const supported = connection != null && connectionSupportsSidebarResources(connection);

  const cacheSelector = useMemo(
    () => (connectionId ? selectDockerSidebarCacheEntry(connectionId) : selectEmptyDockerSidebarCacheEntry),
    [connectionId],
  );
  const entry = useDockerSidebarCacheStore(cacheSelector);
  const refreshScope = useDockerSidebarCacheStore((state) => state.refreshScope);
  const connectionRefreshing = useDockerSidebarCacheStore((state) =>
    connectionId ? state.isRefreshing(dockerSidebarConnectionRefreshKey(connectionId)) : false,
  );

  useEffect(() => {
    if (!connectionId || !supported) return;
    if (hasCachedResources(connectionId)) return;
    void refreshScope({ kind: "connection", connectionId });
  }, [connectionId, supported, refreshScope]);

  const refresh = useCallback(() => {
    if (!connectionId || !supported) return;
    void refreshScope({ kind: "connection", connectionId });
  }, [connectionId, supported, refreshScope]);

  const refreshCategory = useCallback(
    (category: "images" | "containers" | "networks" | "volumes") => {
      if (!connectionId || !supported) return;
      void refreshScope({ kind: "category", connectionId, category });
    },
    [connectionId, supported, refreshScope],
  );

  const loading = supported && connectionRefreshing && entry.refreshedAt == null;

  if (!supported) {
    return {
      images: [],
      containers: [],
      networks: [],
      volumes: [],
      loading: false,
      error: null,
      refresh,
      refreshCategory,
    };
  }

  return {
    images: entry.images,
    containers: entry.containers,
    networks: entry.networks,
    volumes: entry.volumes,
    loading,
    error: entry.error,
    refresh,
    refreshCategory,
  };
}

/** 供连接列表等场景触发单连接全量刷新。 */
export function refreshDockerConnectionSidebarCache(connectionId: string): void {
  void useDockerSidebarCacheStore.getState().refreshScope({ kind: "connection", connectionId });
}

/** 判断某刷新 key 是否处于进行中。 */
export function useDockerSidebarRefreshing(refreshKey: string | null): boolean {
  return useDockerSidebarCacheStore((state) => (refreshKey ? state.isRefreshing(refreshKey) : false));
}
