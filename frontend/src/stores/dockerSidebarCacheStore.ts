import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  dockerSidebarCategoryRefreshKey,
  dockerSidebarConnectionRefreshKey,
  EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY,
  type DockerSidebarCacheEntry,
  type DockerSidebarRefreshScope,
} from "@/modules/docker/dockerSidebarCache";
import { fetchDockerSidebarResources } from "@/modules/docker/dockerSidebarRefresh";

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

export const useDockerSidebarCacheStore = create<DockerSidebarCacheState>()(
  persist(
    (set, get) => ({
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
        get().setRefreshing(key, true);
        try {
          const next = await fetchDockerSidebarResources(scope, current);
          get().patchEntry(connectionId, next);
          return next;
        } finally {
          get().setRefreshing(key, false);
        }
      },
    }),
    {
      name: "omnipanel-docker-sidebar-cache.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ connections: state.connections }),
    },
  ),
);
