import { commands } from "@/ipc/bindings";
import type { DockerContainerSummary } from "@/ipc/bindings";
import { asArray } from "@/ipc/asArray";
import { unwrapCommand } from "@/ipc/result";
import { useDockerSidebarCacheStore } from "@/stores/dockerSidebarCacheStore";
import {
  dockerSidebarCategoryRefreshKey,
  mergeDockerSidebarCategoryFetch,
  type DockerSidebarCacheEntry,
  type DockerSidebarCategory,
} from "./dockerSidebarCache";
import { warmComposeMetaFromContainers } from "./dockerComposeApi";
import { handleDockerAutoFetchFailure } from "./dockerConnectionOffline";

/** 同步读取侧栏内存缓存快照（切换连接时灌入面板，避免先清空闪白）。 */
export function peekDockerSidebarCache(connectionId: string): DockerSidebarCacheEntry {
  return useDockerSidebarCacheStore.getState().getEntry(connectionId);
}

/**
 * 把已经拉到的分类写进侧栏缓存。
 * 面板和连接树共用这一份，避免表格已经有数据、树还要再排队打一轮 list。
 */
export function publishDockerSidebarCategory(
  connectionId: string,
  category: DockerSidebarCategory,
  items: DockerSidebarCacheEntry[DockerSidebarCategory],
): void {
  const store = useDockerSidebarCacheStore.getState();
  const current = store.getEntry(connectionId);
  if (sidebarCategoryUnchanged(current, category, items)) return;

  const published: DockerSidebarCacheEntry = {
    ...current,
    [category]: items,
    loadedCategories: {
      ...(current.loadedCategories ?? {}),
      [category]: true,
    },
    refreshedAt: Date.now(),
    error: null,
  };
  const merged = mergeDockerSidebarCategoryFetch(current, published, category);
  store.patchEntry(connectionId, merged);
  if (category === "containers") {
    warmComposeMetaFromContainers(connectionId, items as DockerContainerSummary[]);
  }
}

function sidebarCategoryUnchanged(
  current: DockerSidebarCacheEntry,
  category: DockerSidebarCategory,
  items: DockerSidebarCacheEntry[DockerSidebarCategory],
): boolean {
  if (!current.loadedCategories?.[category]) return false;
  const prev = current[category] as Array<{ id?: string; name?: string; running?: boolean; state?: string; statusText?: string }>;
  if (prev.length !== items.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    const a = prev[i];
    const b = items[i] as typeof a;
    if (!a || !b) return false;
    if ((a.id ?? a.name) !== (b.id ?? b.name)) return false;
    if (a.running !== b.running || a.state !== b.state || a.statusText !== b.statusText) return false;
  }
  return true;
}

const inflightContainerLists = new Map<string, Promise<DockerContainerSummary[]>>();

/**
 * 同一连接的容器 list 合并成一次。
 * 工作区表格和侧栏展开会同时触发，不能各打一遍（SSH exec 通道会互相卡住）。
 */
export function fetchDockerContainersShared(connectionId: string): Promise<DockerContainerSummary[]> {
  const existing = inflightContainerLists.get(connectionId);
  if (existing) return existing;

  const categoryKey = dockerSidebarCategoryRefreshKey(connectionId, "containers");
  useDockerSidebarCacheStore.getState().setRefreshing(categoryKey, true);
  const task = (async () => {
    try {
      const containers = asArray(
        await unwrapCommand(commands.dockerListContainers(connectionId, null), { quiet: true }),
      );
      publishDockerSidebarCategory(connectionId, "containers", containers);
      return containers;
    } catch (error) {
      handleDockerAutoFetchFailure(connectionId, error);
      throw error;
    }
  })().finally(() => {
    inflightContainerLists.delete(connectionId);
    useDockerSidebarCacheStore.getState().setRefreshing(categoryKey, false);
  });

  inflightContainerLists.set(connectionId, task);
  return task;
}

/** 展开连接时：已有且不太旧的缓存直接展示，否则补拉容器并写入侧栏。 */
const SIDEBAR_CONTAINER_FRESH_MS = 15_000;

export function ensureDockerSidebarContainers(connectionId: string): void {
  const entry = useDockerSidebarCacheStore.getState().getEntry(connectionId);
  const refreshedAt = entry.refreshedAt ?? 0;
  const fresh =
    Boolean(entry.loadedCategories?.containers) &&
    refreshedAt > 0 &&
    Date.now() - refreshedAt < SIDEBAR_CONTAINER_FRESH_MS;
  if (fresh) return;
  void fetchDockerContainersShared(connectionId).catch(() => {
    // 失败留在缓存 error / 空列表；展开可再试。调用方另有离线处理。
  });
}
