import { commands } from "@/ipc/bindings";
import { asArray } from "@/ipc/asArray";
import { unwrapCommand, type CommandResult, formatIpcError } from "@/ipc/result";
import type {
  DockerSidebarCacheEntry,
  DockerSidebarCategory,
  DockerSidebarRefreshScope,
} from "./dockerSidebarCache";
import { EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY } from "./dockerSidebarCache";
import { handleDockerAutoFetchFailure } from "./dockerConnectionOffline";
import { warmComposeMetaFromContainers } from "./dockerComposeApi";
import {
  isMissingDockerBoundSshError,
  runWithDockerBoundSsh,
} from "./ensureDockerBoundSsh";
import { publishDockerSidebarRefreshFailed } from "./dockerSidebarCacheStatusLog";

/** 侧栏刷新失败会落到 entry.error，避免刷屏 console */
function unwrap<T>(promise: Promise<CommandResult<T>>): Promise<T> {
  return unwrapCommand(promise, { quiet: true });
}

const ALL_CATEGORIES: DockerSidebarCategory[] = ["images", "containers", "networks", "volumes"];

function warmComposeMetaIfNeeded(
  connectionId: string,
  containers: DockerSidebarCacheEntry["containers"] | undefined,
): void {
  if (!containers?.length) return;
  warmComposeMetaFromContainers(connectionId, containers);
}

async function fetchCategory(
  connectionId: string,
  category: DockerSidebarCategory,
): Promise<Partial<DockerSidebarCacheEntry>> {
  switch (category) {
    case "images":
      return { images: asArray(await unwrap(commands.dockerListImages(connectionId))) };
    case "containers": {
      const containers = asArray(await unwrap(commands.dockerListContainers(connectionId, null)));
      warmComposeMetaIfNeeded(connectionId, containers);
      return { containers };
    }
    case "networks":
      return { networks: asArray(await unwrap(commands.dockerListNetworks(connectionId))) };
    case "volumes":
      return { volumes: asArray(await unwrap(commands.dockerListVolumes(connectionId))) };
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

function toSidebarErrorMessage(error: unknown): string {
  return formatIpcError(
    error && typeof error === "object"
      ? (error as { message?: string; cause?: string | null; code?: string | null })
      : String(error),
  );
}

export async function fetchDockerSidebarResources(
  scope: DockerSidebarRefreshScope,
  current: DockerSidebarCacheEntry = EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY,
): Promise<DockerSidebarCacheEntry> {
  const label =
    scope.kind === "connection"
      ? `connection:${scope.connectionId}`
      : `category:${scope.connectionId}/${scope.category}`;
  console.info("[docker-sidebar] refresh start", label);
  try {
    return await runWithDockerBoundSsh(scope.connectionId, async () => {
      if (scope.kind === "connection") {
        // 手动全量刷新：顺序拉取，避免 SSH 上对多个 docker list 并发抢 exec 锁导致整次首拉挂起
        // 任一分类鉴权/封禁失败则立刻中止，避免连续打满宝塔验证计数
        const containers = await unwrap(commands.dockerListContainers(scope.connectionId, null));
        warmComposeMetaIfNeeded(scope.connectionId, containers);
        const images = await unwrap(commands.dockerListImages(scope.connectionId));
        const networks = await unwrap(commands.dockerListNetworks(scope.connectionId));
        const volumes = await unwrap(commands.dockerListVolumes(scope.connectionId));
        console.info("[docker-sidebar] refresh ok", label, {
          containers: containers.length,
          images: images.length,
          networks: networks.length,
          volumes: volumes.length,
        });
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
      console.info("[docker-sidebar] refresh ok", label, {
        images: patch.images?.length,
        containers: patch.containers?.length,
        networks: patch.networks?.length,
        volumes: patch.volumes?.length,
      });
      return {
        ...current,
        ...patch,
        loadedCategories: markLoaded(current.loadedCategories ?? {}, [scope.category]),
        refreshedAt: Date.now(),
        error: null,
      };
    });
  } catch (error) {
    const detail =
      error && typeof error === "object"
        ? {
            message: (error as { message?: string }).message,
            cause: (error as { cause?: string | null }).cause,
            code: (error as { code?: string | null }).code,
          }
        : { raw: String(error) };
    console.warn("[docker-sidebar] refresh failed", label, detail, error);
    // 用户取消打开依赖 SSH：不刷错误文案
    if (
      error &&
      typeof error === "object" &&
      (error as { code?: string }).code === "cancelled"
    ) {
      return {
        ...current,
        refreshedAt: current.refreshedAt ?? Date.now(),
        error: null,
      };
    }
    // 「未绑定 SSH」已在 recover 里弹过提示，侧栏不再重复堆长错误
    if (isMissingDockerBoundSshError(error)) {
      const message = "请绑定 SSH 连接后重试";
      publishDockerSidebarRefreshFailed(message);
      return {
        ...current,
        refreshedAt: current.refreshedAt ?? Date.now(),
        error: message,
      };
    }
    // 连不上实例：标记未连接；错误仍推到状态栏，便于排查
    if (handleDockerAutoFetchFailure(scope.connectionId, error)) {
      console.warn("[docker-sidebar] treated as offline", label, detail);
      publishDockerSidebarRefreshFailed(toSidebarErrorMessage(error));
      return {
        ...current,
        refreshedAt: current.refreshedAt ?? Date.now(),
        error: null,
      };
    }
    const message = toSidebarErrorMessage(error);
    publishDockerSidebarRefreshFailed(message);
    return {
      ...current,
      // 失败也标记已尝试，侧栏结束「加载中」并展示错误；不标记 loaded，便于展开时重试
      refreshedAt: current.refreshedAt ?? Date.now(),
      error: message,
    };
  }
}
