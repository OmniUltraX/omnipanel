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
