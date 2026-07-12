import type {
  DockerContainerSummary,
  DockerImageSummary,
  DockerNetworkSummary,
  DockerVolumeSummary,
} from "@/ipc/bindings";

export type DockerSidebarCacheEntry = {
  images: DockerImageSummary[];
  containers: DockerContainerSummary[];
  networks: DockerNetworkSummary[];
  volumes: DockerVolumeSummary[];
  refreshedAt: number | null;
  error: string | null;
};

/** 供 selector / getSnapshot 使用的稳定空缓存，避免每次返回新对象触发无限重渲染。 */
export const EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY: DockerSidebarCacheEntry = {
  images: [],
  containers: [],
  networks: [],
  volumes: [],
  refreshedAt: null,
  error: null,
};

export function emptyDockerSidebarCacheEntry(): DockerSidebarCacheEntry {
  return {
    images: [],
    containers: [],
    networks: [],
    volumes: [],
    refreshedAt: null,
    error: null,
  };
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
  | { kind: "category"; connectionId: string; category: "images" | "containers" | "networks" | "volumes" };

export function dockerSidebarConnectionRefreshKey(connectionId: string): string {
  return `conn:${connectionId}`;
}

export function dockerSidebarCategoryRefreshKey(
  connectionId: string,
  category: "images" | "containers" | "networks" | "volumes",
): string {
  return `cat:${connectionId}:${category}`;
}
