import { commands } from "@/ipc/bindings";
import { unwrapCommand } from "@/ipc/result";
import type { DockerSidebarCacheEntry, DockerSidebarRefreshScope } from "./dockerSidebarCache";
import { EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY } from "./dockerSidebarCache";

const unwrap = unwrapCommand;

async function fetchCategory(
  connectionId: string,
  category: "images" | "containers" | "networks" | "volumes",
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

export async function fetchDockerSidebarResources(
  scope: DockerSidebarRefreshScope,
  current: DockerSidebarCacheEntry = EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY,
): Promise<DockerSidebarCacheEntry> {
  try {
    if (scope.kind === "connection") {
      // 顺序拉取，避免 SSH 上对多个 docker list 并发抢 exec 锁导致整次首拉挂起
      const containers = await unwrap(commands.dockerListContainers(scope.connectionId, null));
      const images = await unwrap(commands.dockerListImages(scope.connectionId));
      const networks = await unwrap(commands.dockerListNetworks(scope.connectionId));
      const volumes = await unwrap(commands.dockerListVolumes(scope.connectionId));
      return {
        images,
        containers,
        networks,
        volumes,
        refreshedAt: Date.now(),
        error: null,
      };
    }

    const patch = await fetchCategory(scope.connectionId, scope.category);
    return {
      ...current,
      ...patch,
      refreshedAt: Date.now(),
      error: null,
    };
  } catch (error) {
    return {
      ...current,
      // 失败也标记已尝试，侧栏结束「加载中」并展示错误
      refreshedAt: current.refreshedAt ?? Date.now(),
      error: String(error),
    };
  }
}
