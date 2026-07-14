import { commands } from "@/ipc/bindings";
import { unwrapCommand } from "@/ipc/result";
import type {
  DockerSidebarCacheEntry,
  DockerSidebarCategory,
  DockerSidebarRefreshScope,
} from "./dockerSidebarCache";
import { EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY } from "./dockerSidebarCache";

const unwrap = unwrapCommand;

const ALL_CATEGORIES: DockerSidebarCategory[] = ["images", "containers", "networks", "volumes"];

async function fetchCategory(
  connectionId: string,
  category: DockerSidebarCategory,
): Promise<Partial<DockerSidebarCacheEntry>> {
  switch (category) {
    case "images":
      return { images: await unwrap(commands.dockerListImages(connectionId)) };
    case "containers":
      return { containers: await unwrap(commands.dockerListContainers(connectionId, null)) };
    case "networks":
      return { networks: await unwrap(commands.dockerListNetworks(connectionId)) };
    case "volumes":
      return { volumes: await unwrap(commands.dockerListVolumes(connectionId)) };
  }
}

function markLoaded(
  current: Partial<Record<DockerSidebarCategory, true>>,
  categories: DockerSidebarCategory[],
): Partial<Record<DockerSidebarCategory, true>> {
  const next = { ...current };
  for (const category of categories) {
    next[category] = true;
  }
  return next;
}

export async function fetchDockerSidebarResources(
  scope: DockerSidebarRefreshScope,
  current: DockerSidebarCacheEntry = EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY,
): Promise<DockerSidebarCacheEntry> {
  try {
    if (scope.kind === "connection") {
      // 手动全量刷新：顺序拉取，避免 SSH 上对多个 docker list 并发抢 exec 锁导致整次首拉挂起
      const containers = await unwrap(commands.dockerListContainers(scope.connectionId, null));
      const images = await unwrap(commands.dockerListImages(scope.connectionId));
      const networks = await unwrap(commands.dockerListNetworks(scope.connectionId));
      const volumes = await unwrap(commands.dockerListVolumes(scope.connectionId));
      return {
        images,
        containers,
        networks,
        volumes,
        loadedCategories: markLoaded({}, ALL_CATEGORIES),
        refreshedAt: Date.now(),
        error: null,
      };
    }

    const patch = await fetchCategory(scope.connectionId, scope.category);
    return {
      ...current,
      ...patch,
      loadedCategories: markLoaded(current.loadedCategories ?? {}, [scope.category]),
      refreshedAt: Date.now(),
      error: null,
    };
  } catch (error) {
    return {
      ...current,
      // 失败也标记已尝试，侧栏结束「加载中」并展示错误；不标记 loaded，便于展开时重试
      refreshedAt: current.refreshedAt ?? Date.now(),
      error: String(error),
    };
  }
}
