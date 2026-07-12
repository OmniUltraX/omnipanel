import { create } from "zustand";
import {
  dockerSidebarCategoryRefreshKey,
  dockerSidebarConnectionRefreshKey,
  EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY,
  type DockerSidebarCacheEntry,
  type DockerSidebarRefreshScope,
} from "@/modules/docker/dockerSidebarCache";
import { fetchDockerSidebarResources } from "@/modules/docker/dockerSidebarRefresh";

/** 侧栏资源缓存仅驻留内存，避免大列表 persist 阻塞首屏与每次刷新写 localStorage。 */
const LEGACY_PERSIST_KEY = "omnipanel-docker-sidebar-cache.v1";

type DockerSidebarCacheState = {
  connections: Record<string, DockerSidebarCacheEntry>;
  refreshingKeys: Record<string, true>;
  getEntry: (connectionId: string) => DockerSidebarCacheEntry;
  isRefreshing: (key: string) => boolean;
  setRefreshing: (key: string, refreshing: boolean) => void;
  patchEntry: (connectionId: string, entry: DockerSidebarCacheEntry) => void;
  refreshScope: (scope: DockerSidebarRefreshScope) => Promise<DockerSidebarCacheEntry>;
};

function refreshKeyForScope(scope: DockerSidebarRefreshScope): string {
  if (scope.kind === "connection") {
    return dockerSidebarConnectionRefreshKey(scope.connectionId);
  }
  return dockerSidebarCategoryRefreshKey(scope.connectionId, scope.category);
}

const MAX_PARALLEL_SIDEBAR_REFRESH = 2;
let activeSidebarRefreshCount = 0;
const pendingSidebarRefreshJobs: Array<{
  scope: DockerSidebarRefreshScope;
  run: () => Promise<DockerSidebarCacheEntry>;
  resolve: (entry: DockerSidebarCacheEntry) => void;
  reject: (error: unknown) => void;
}> = [];

function pumpSidebarRefreshQueue() {
  while (
    activeSidebarRefreshCount < MAX_PARALLEL_SIDEBAR_REFRESH &&
    pendingSidebarRefreshJobs.length > 0
  ) {
    const job = pendingSidebarRefreshJobs.shift();
    if (!job) return;
    activeSidebarRefreshCount += 1;
    void job
      .run()
      .then(job.resolve, job.reject)
      .finally(() => {
        activeSidebarRefreshCount -= 1;
        pumpSidebarRefreshQueue();
      });
  }
}

function enqueueSidebarRefresh(
  scope: DockerSidebarRefreshScope,
  run: () => Promise<DockerSidebarCacheEntry>,
): Promise<DockerSidebarCacheEntry> {
  return new Promise((resolve, reject) => {
    pendingSidebarRefreshJobs.push({ scope, run, resolve, reject });
    pumpSidebarRefreshQueue();
  });
}

let legacyPersistCleared = false;

function clearLegacyPersistedSidebarCache() {
  if (legacyPersistCleared || typeof localStorage === "undefined") return;
  legacyPersistCleared = true;
  try {
    localStorage.removeItem(LEGACY_PERSIST_KEY);
  } catch {
    // ignore quota / privacy mode
  }
}

export const useDockerSidebarCacheStore = create<DockerSidebarCacheState>()((set, get) => {
  clearLegacyPersistedSidebarCache();

  return {
    connections: {},
    refreshingKeys: {},

    getEntry: (connectionId) => get().connections[connectionId] ?? EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY,

    isRefreshing: (key) => Boolean(get().refreshingKeys[key]),

    setRefreshing: (key, refreshing) => {
      set((state) => {
        const next = { ...state.refreshingKeys };
        if (refreshing) {
          next[key] = true;
        } else {
          delete next[key];
        }
        return { refreshingKeys: next };
      });
    },

    patchEntry: (connectionId, entry) => {
      set((state) => ({
        connections: {
          ...state.connections,
          [connectionId]: entry,
        },
      }));
    },

    refreshScope: async (scope) => {
      const connectionId = scope.connectionId;
      const key = refreshKeyForScope(scope);
      const current = get().getEntry(connectionId);
      if (get().refreshingKeys[key]) {
        return current;
      }

      return enqueueSidebarRefresh(scope, async () => {
        get().setRefreshing(key, true);
        try {
          const next = await fetchDockerSidebarResources(scope, current);
          get().patchEntry(connectionId, next);
          return next;
        } finally {
          get().setRefreshing(key, false);
        }
      });
    },
  };
});
