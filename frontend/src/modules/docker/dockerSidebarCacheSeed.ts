import { useDockerSidebarCacheStore } from "@/stores/dockerSidebarCacheStore";
import type { DockerSidebarCacheEntry } from "./dockerSidebarCache";

/** 同步读取侧栏内存缓存快照（切换连接时灌入面板，避免先清空闪白）。 */
export function peekDockerSidebarCache(connectionId: string): DockerSidebarCacheEntry {
  return useDockerSidebarCacheStore.getState().getEntry(connectionId);
}
