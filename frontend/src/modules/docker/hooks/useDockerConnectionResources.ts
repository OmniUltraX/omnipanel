import { useCallback, useEffect, useMemo } from "react";
import { useModuleSuspended } from "../../../lib/moduleVisibility";
import type { DockerConnectionInfo } from "../../../ipc/bindings";
import {
  dockerSidebarCategoryRefreshKey,
  dockerSidebarConnectionRefreshKey,
  EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY,
  isDockerSidebarCategoryLoaded,
  selectDockerSidebarCacheEntry,
  selectEmptyDockerSidebarCacheEntry,
  type DockerSidebarCategory,
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

function hasLoadedContainers(connectionId: string): boolean {
  const entry = useDockerSidebarCacheStore.getState().getEntry(connectionId);
  return isDockerSidebarCategoryLoaded(entry, "containers");
}

export type UseDockerConnectionResourcesOptions = {
  /**
   * 为 true 且尚无容器缓存时，才在后台首拉 containers。
   * 折叠节点时应关闭，避免未展开就刷列表；镜像/网络/卷由分类展开再拉。
   */
  autoFetchWhenEmpty?: boolean;
};

/**
 * 读取单个 Docker 连接的侧栏资源缓存（内存常驻）。
 * 默认不因展开/切换重复请求；仅 `autoFetchWhenEmpty` 且从未拉取过容器时补首拉（仅 containers）。
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
  const containersRefreshKey = connectionId
    ? dockerSidebarCategoryRefreshKey(connectionId, "containers")
    : null;
  const connectionRefreshing = useDockerSidebarCacheStore((state) =>
    connectionRefreshKey ? Boolean(state.refreshingKeys[connectionRefreshKey]) : false,
  );
  const containersRefreshing = useDockerSidebarCacheStore((state) =>
    containersRefreshKey ? Boolean(state.refreshingKeys[containersRefreshKey]) : false,
  );

  useEffect(() => {
    if (!connectionId || !supported || moduleSuspended || !autoFetchWhenEmpty) return;
    if (hasLoadedContainers(connectionId)) return;

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
      // 首拉只拉 containers；镜像/网络/卷在分类展开时再请求
      void refreshScope({ kind: "category", connectionId, category: "containers" });
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
    (category: DockerSidebarCategory) => {
      if (!connectionId || !supported) return;
      void refreshScope({ kind: "category", connectionId, category });
    },
    [connectionId, supported, refreshScope],
  );

  // 缺省字段用稳定空对象，避免每次渲染新引用触发下游 effect
  const loadedCategories = entry.loadedCategories ?? EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY.loadedCategories;

  // 仅在「容器从未落盘」且仍在刷新时显示连接级加载；已有 error/loaded 则不再假转圈
  const loading =
    supported &&
    (containersRefreshing || connectionRefreshing) &&
    !loadedCategories.containers &&
    entry.error == null;

  if (!supported) {
    return {
      images: [],
      containers: [],
      networks: [],
      volumes: [],
      loadedCategories: {},
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
    loadedCategories,
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
