import { create } from "zustand";
import {
  dockerSidebarCategoryRefreshKey,
  dockerSidebarConnectionRefreshKey,
  EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY,
  type DockerSidebarCacheEntry,
  type DockerSidebarRefreshScope,
} from "@/modules/docker/dockerSidebarCache";
import { fetchDockerSidebarResources } from "@/modules/docker/dockerSidebarRefresh";

/**
 * 侧栏资源（容器/镜像/网络/卷）缓存：进程内内存常驻。
 * 故意不 persist localStorage，避免大列表阻塞首屏与每次刷新写盘。
 * 读路径一律走本 store；写路径仅「节点刷新按钮」或业务变更后的局部 refreshScope。
 */
const LEGACY_PERSIST_KEY = "omnipanel-docker-sidebar-cache.v1";

/** 含排队等待；超时后结束 loading，避免侧栏永久「加载中」 */
const SIDEBAR_REFRESH_TIMEOUT_MS = 45_000;

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
  run: () => Promise<DockerSidebarCacheEntry>;
  resolve: (entry: DockerSidebarCacheEntry) => void;
  reject: (error: unknown) => void;
}> = [];

/** 同一 refreshKey 共用进行中的 Promise，避免竞态早退 */
const inflightByKey = new Map<string, Promise<DockerSidebarCacheEntry>>();
/** 超时后 bump，使迟到的 IPC 结果不再覆盖失败态 */
const refreshEpochByKey = new Map<string, number>();

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

function enqueueSidebarRefresh(run: () => Promise<DockerSidebarCacheEntry>): Promise<DockerSidebarCacheEntry> {
  return new Promise((resolve, reject) => {
    pendingSidebarRefreshJobs.push({ run, resolve, reject });
    pumpSidebarRefreshQueue();
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} 超时 (${ms}ms)`));
    }, ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
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

function failedEntry(current: DockerSidebarCacheEntry, error: unknown): DockerSidebarCacheEntry {
  return {
    ...current,
    // 失败也写入 refreshedAt，结束「从未拉取」态，避免 UI 永久停在加载中
    refreshedAt: current.refreshedAt ?? Date.now(),
    error: String(error),
  };
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

      const existing = inflightByKey.get(key);
      if (existing) {
        return existing;
      }

      const epoch = (refreshEpochByKey.get(key) ?? 0) + 1;
      refreshEpochByKey.set(key, epoch);
      get().setRefreshing(key, true);

      const promise = withTimeout(
        enqueueSidebarRefresh(async () => {
          if (refreshEpochByKey.get(key) !== epoch) {
            return get().getEntry(connectionId);
          }
          const current = get().getEntry(connectionId);
          try {
            const next = await fetchDockerSidebarResources(scope, current);
            if (refreshEpochByKey.get(key) !== epoch) {
              return get().getEntry(connectionId);
            }
            get().patchEntry(connectionId, next);
            return next;
          } catch (error) {
            if (refreshEpochByKey.get(key) !== epoch) {
              return get().getEntry(connectionId);
            }
            const failed = failedEntry(current, error);
            get().patchEntry(connectionId, failed);
            return failed;
          }
        }),
        SIDEBAR_REFRESH_TIMEOUT_MS,
        `docker sidebar refresh ${key}`,
      )
        .catch((error) => {
          // 使迟到的队列任务 / IPC 失效
          refreshEpochByKey.set(key, epoch + 1);
          const failed = failedEntry(get().getEntry(connectionId), error);
          get().patchEntry(connectionId, failed);
          return failed;
        })
        .finally(() => {
          get().setRefreshing(key, false);
          inflightByKey.delete(key);
        });

      inflightByKey.set(key, promise);
      return promise;
    },
  };
});
