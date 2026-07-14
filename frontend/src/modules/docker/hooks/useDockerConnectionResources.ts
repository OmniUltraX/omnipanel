import { useCallback, useEffect, useMemo } from "react";
import { useModuleSuspended } from "../../../lib/moduleVisibility";
import type { DockerConnectionInfo } from "../../../ipc/bindings";
import {
  dockerSidebarConnectionRefreshKey,
  selectDockerSidebarCacheEntry,
  selectEmptyDockerSidebarCacheEntry,
} from "../dockerSidebarCache";
import {
  isLocalDockerSource,
  isOnePanelDockerSource,
  isSshDockerSource,
} from "../dockerConnectionSource";
import { useDockerSidebarCacheStore } from "@/stores/dockerSidebarCacheStore";

/** 侧栏资源树支持本地 Engine / SSH 宿主机 / 1Panel（及面板适配）。 */
export function connectionSupportsSidebarResources(connection: DockerConnectionInfo): boolean {
  return (
    isLocalDockerSource(connection.source) ||
    isOnePanelDockerSource(connection.source) ||
    isSshDockerSource(connection.source)
  );
}

function hasCachedResources(connectionId: string): boolean {
  const entry = useDockerSidebarCacheStore.getState().getEntry(connectionId);
  return entry.refreshedAt != null;
}

export type UseDockerConnectionResourcesOptions = {
  /**
   * 为 true 且尚无缓存时，才在后台拉取一次写入缓存。
   * 折叠节点时应关闭，避免未展开就刷全量；之后仅靠树上的刷新按钮做局部刷新。
   */
  autoFetchWhenEmpty?: boolean;
};

/**
 * 读取单个 Docker 连接的侧栏资源缓存（内存常驻）。
 * 默认不因展开/切换重复请求；仅 `autoFetchWhenEmpty` 且从未拉取过时补首拉。
 */
export function useDockerConnectionResources(
  connection: DockerConnectionInfo | null,
  options?: UseDockerConnectionResourcesOptions,
) {
  const autoFetchWhenEmpty = options?.autoFetchWhenEmpty ?? true;
  const moduleSuspended = useModuleSuspended();
  const connectionId = connection?.connectionId ?? null;
  const supported = connection != null && connectionSupportsSidebarResources(connection);

  const cacheSelector = useMemo(
    () => (connectionId ? selectDockerSidebarCacheEntry(connectionId) : selectEmptyDockerSidebarCacheEntry),
    [connectionId],
  );
  const entry = useDockerSidebarCacheStore(cacheSelector);
  const refreshScope = useDockerSidebarCacheStore((state) => state.refreshScope);
  // 直接读 refreshingKeys，保证 zustand 订阅能随 key 变化触发重渲染
  const connectionRefreshKey = connectionId ? dockerSidebarConnectionRefreshKey(connectionId) : null;
  const connectionRefreshing = useDockerSidebarCacheStore((state) =>
    connectionRefreshKey ? Boolean(state.refreshingKeys[connectionRefreshKey]) : false,
  );

  useEffect(() => {
    if (!connectionId || !supported || moduleSuspended || !autoFetchWhenEmpty) return;
    if (hasCachedResources(connectionId)) return;

    let cancelled = false;
    const scheduleIdle =
      typeof requestIdleCallback === "function"
        ? (cb: () => void) => requestIdleCallback(cb, { timeout: 1500 })
        : (cb: () => void) => window.setTimeout(cb, 48);
    const cancelIdle =
      typeof cancelIdleCallback === "function"
        ? (id: number) => cancelIdleCallback(id)
        : (id: number) => window.clearTimeout(id);

    const handle = scheduleIdle(() => {
      if (cancelled) return;
      void refreshScope({ kind: "connection", connectionId });
    });

    return () => {
      cancelled = true;
      cancelIdle(handle as number);
    };
  }, [autoFetchWhenEmpty, connectionId, moduleSuspended, supported, refreshScope]);

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

  // 仅在「从未成功/失败落盘」且仍在刷新时显示加载；已有 error/refreshedAt 则不再假转圈
  const loading =
    supported && connectionRefreshing && entry.refreshedAt == null && entry.error == null;

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
  return useDockerSidebarCacheStore((state) =>
    refreshKey ? Boolean(state.refreshingKeys[refreshKey]) : false,
  );
}
