import { useCallback, useMemo } from "react";
import type { DockerConnectionInfo } from "../../../ipc/bindings";
import {
  dockerSidebarCategoryRefreshKey,
  dockerSidebarConnectionRefreshKey,
  EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY,
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

/**
 * 读取单个 Docker 连接的侧栏资源缓存（后端持久化，前端仅内存 + UI 态）。
 * 只读缓存，不在展开/挂载时自动请求；仅点击刷新按钮时 refresh / refreshCategory 写缓存并更新 UI。
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

  // 仅在用户主动刷新且尚无数据时显示加载
  const loading =
    supported &&
    (containersRefreshing || connectionRefreshing) &&
    entry.containers.length === 0 &&
    entry.error == null;

  if (!supported) {
    return {
      images: [],
      containers: [],
      networks: [],
      volumes: [],
      loadedCategories: EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY.loadedCategories,
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

export type DockerSidebarRefreshAllProgress = {
  done: number;
  total: number;
  connectionId: string;
  connectionName: string;
};

export type RefreshAllDockerSidebarCachesOptions = {
  getConnectionName?: (connectionId: string) => string;
  onStart?: (total: number) => void;
  onConnectionDone?: (progress: DockerSidebarRefreshAllProgress) => void;
  onComplete?: (total: number) => void;
};

/** 刷新当前列表中全部 Docker 连接的侧栏资源缓存。 */
export async function refreshAllDockerSidebarCaches(
  connectionIds: readonly string[],
  options?: RefreshAllDockerSidebarCachesOptions,
): Promise<void> {
  const total = connectionIds.length;
  if (total === 0) return;

  options?.onStart?.(total);
  const store = useDockerSidebarCacheStore.getState();
  let done = 0;

  await Promise.all(
    connectionIds.map(async (connectionId) => {
      await store.refreshScope({ kind: "connection", connectionId });
      done += 1;
      options?.onConnectionDone?.({
        done,
        total,
        connectionId,
        connectionName: options.getConnectionName?.(connectionId) ?? connectionId,
      });
    }),
  );

  options?.onComplete?.(total);
}

/** 判断某刷新 key 是否处于进行中。 */
export function useDockerSidebarRefreshing(refreshKey: string | null): boolean {
  return useDockerSidebarCacheStore((state) =>
    refreshKey ? Boolean(state.refreshingKeys[refreshKey]) : false,
  );
}
