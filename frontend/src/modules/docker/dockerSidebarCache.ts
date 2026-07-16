import type {
  DockerContainerSummary,
  DockerImageSummary,
  DockerNetworkSummary,
  DockerVolumeSummary,
} from "@/ipc/bindings";

export type DockerSidebarCategory = "images" | "containers" | "networks" | "volumes";

export type DockerSidebarCacheEntry = {
  images: DockerImageSummary[];
  containers: DockerContainerSummary[];
  networks: DockerNetworkSummary[];
  volumes: DockerVolumeSummary[];
  /** 已成功拉取过的分类；未标记则视为尚未加载（空数组 ≠ 已加载） */
  loadedCategories: Partial<Record<DockerSidebarCategory, true>>;
  refreshedAt: number | null;
  error: string | null;
};

/** 供 selector / getSnapshot 使用的稳定空缓存，避免每次返回新对象触发无限重渲染。 */
export const EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY: DockerSidebarCacheEntry = {
  images: [],
  containers: [],
  networks: [],
  volumes: [],
  loadedCategories: {},
  refreshedAt: null,
  error: null,
};

/** 侧栏 selector 回退用的稳定空列表（禁止在 selector 内写 `?? []`）。 */
export const EMPTY_DOCKER_SIDEBAR_IMAGES = EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY.images;
export const EMPTY_DOCKER_SIDEBAR_CONTAINERS = EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY.containers;
export const EMPTY_DOCKER_SIDEBAR_NETWORKS = EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY.networks;
export const EMPTY_DOCKER_SIDEBAR_VOLUMES = EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY.volumes;

export function emptyDockerSidebarCacheEntry(): DockerSidebarCacheEntry {
  return {
    images: [],
    containers: [],
    networks: [],
    volumes: [],
    loadedCategories: {},
    refreshedAt: null,
    error: null,
  };
}

export function isDockerSidebarCategoryLoaded(
  entry: DockerSidebarCacheEntry,
  category: DockerSidebarCategory,
): boolean {
  return Boolean(entry.loadedCategories[category]);
}

export function selectDockerSidebarCacheEntry(connectionId: string) {
  return (state: { connections: Record<string, DockerSidebarCacheEntry> }) =>
    state.connections[connectionId] ?? EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY;
}

export function selectEmptyDockerSidebarCacheEntry() {
  return EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY;
}

export type DockerSidebarRefreshScope =
  | { kind: "connection"; connectionId: string }
  | { kind: "category"; connectionId: string; category: DockerSidebarCategory };

export function dockerSidebarConnectionRefreshKey(connectionId: string): string {
  return `conn:${connectionId}`;
}

export function dockerSidebarCategoryRefreshKey(
  connectionId: string,
  category: DockerSidebarCategory,
): string {
  return `cat:${connectionId}:${category}`;
}

/** 将某一分类的拉取结果合并进最新缓存，避免并行刷新互相覆盖。 */
export function mergeDockerSidebarCategoryFetch(
  latest: DockerSidebarCacheEntry,
  fetched: DockerSidebarCacheEntry,
  category: DockerSidebarCategory,
): DockerSidebarCacheEntry {
  return {
    ...latest,
    [category]: fetched[category],
    loadedCategories: {
      ...(latest.loadedCategories ?? {}),
      ...(fetched.loadedCategories ?? {}),
    },
    refreshedAt: fetched.refreshedAt ?? latest.refreshedAt,
    error: fetched.error,
  };
}
