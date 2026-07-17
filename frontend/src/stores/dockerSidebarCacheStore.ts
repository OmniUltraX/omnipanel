import { create } from "zustand";
import { commands } from "@/ipc/bindings";
import type { DockerSidebarCacheEntry as BackendSidebarCacheEntry } from "@/ipc/bindings";
import { unwrapCommand } from "@/ipc/result";
import {
  dockerSidebarCategoryRefreshKey,
  dockerSidebarConnectionRefreshKey,
  EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY,
  mergeDockerSidebarCategoryFetch,
  type DockerSidebarCacheEntry,
  type DockerSidebarRefreshScope,
} from "@/modules/docker/dockerSidebarCache";
import { fetchDockerSidebarResources } from "@/modules/docker/dockerSidebarRefresh";

/**
 * 侧栏资源（容器/镜像/网络/卷）缓存：后端 `~/.omnipd/docker/sidebar-cache.json` 持久化。
 * 前端仅保留内存态 + refreshingKeys（UI 态）；不再写 localStorage 大 JSON。
 * 读路径一律走本 store；写路径仅「节点刷新按钮」或业务变更后的局部 refreshScope。
 */
const PERSIST_DEBOUNCE_MS = 400;

/** 含排队等待；超时后结束 loading，避免侧栏永久「加载中」 */
const SIDEBAR_REFRESH_TIMEOUT_MS = 45_000;

type DockerSidebarCacheState = {
  connections: Record<string, DockerSidebarCacheEntry>;
  refreshingKeys: Record<string, true>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  getEntry: (connectionId: string) => DockerSidebarCacheEntry;
  isRefreshing: (key: string) => boolean;
  setRefreshing: (key: string, refreshing: boolean) => void;
  patchEntry: (connectionId: string, entry: DockerSidebarCacheEntry) => void;
  removeConnection: (connectionId: string) => void;
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

let persistTimer: ReturnType<typeof setTimeout> | null = null;
const pendingPersistIds = new Set<string>();
let hydrateInFlight: Promise<void> | null = null;

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

function failedEntry(current: DockerSidebarCacheEntry, error: unknown): DockerSidebarCacheEntry {
  return {
    ...current,
    // 失败也写入 refreshedAt，结束「从未拉取」态，避免 UI 永久停在加载中
    refreshedAt: current.refreshedAt ?? Date.now(),
    error: String(error),
  };
}

function normalizeCacheEntry(entry: DockerSidebarCacheEntry): DockerSidebarCacheEntry {
  if (entry.loadedCategories) {
    return entry;
  }
  return {
    ...entry,
    loadedCategories: EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY.loadedCategories,
  };
}

function toBackendEntry(entry: DockerSidebarCacheEntry): BackendSidebarCacheEntry {
  return {
    images: entry.images,
    containers: entry.containers,
    networks: entry.networks,
    volumes: entry.volumes,
    loadedCategories: Object.keys(entry.loadedCategories ?? {}).filter(
      (key) => entry.loadedCategories[key as keyof typeof entry.loadedCategories],
    ),
    refreshedAt: entry.refreshedAt,
    error: entry.error,
  };
}

function fromBackendEntry(entry: BackendSidebarCacheEntry): DockerSidebarCacheEntry {
  const loadedCategories: DockerSidebarCacheEntry["loadedCategories"] = {};
  for (const key of entry.loadedCategories ?? []) {
    if (
      key === "images" ||
      key === "containers" ||
      key === "networks" ||
      key === "volumes"
    ) {
      loadedCategories[key] = true;
    }
  }
  return normalizeCacheEntry({
    images: entry.images ?? EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY.images,
    containers: entry.containers ?? EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY.containers,
    networks: entry.networks ?? EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY.networks,
    volumes: entry.volumes ?? EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY.volumes,
    loadedCategories,
    refreshedAt: entry.refreshedAt ?? null,
    error: entry.error ?? null,
  });
}

function schedulePersistConnection(
  connectionId: string,
  getEntry: (id: string) => DockerSidebarCacheEntry,
) {
  pendingPersistIds.add(connectionId);
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const ids = [...pendingPersistIds];
    pendingPersistIds.clear();
    // 串行写盘，避免并发 patch 打满后端文件锁 / 触发 Windows rename 竞态
    void (async () => {
      for (const id of ids) {
        const entry = getEntry(id);
        try {
          await unwrapCommand(commands.dockerPatchSidebarCache(id, toBackendEntry(entry)));
        } catch {
          // 持久化失败不阻断 UI；下次刷新会重试
        }
      }
    })();
  }, PERSIST_DEBOUNCE_MS);
}

export const useDockerSidebarCacheStore = create<DockerSidebarCacheState>((set, get) => {
  /** 将拉取结果落到最新缓存上；分类刷新必须与并发结果合并，否则后完成的会抹掉先完成的分类。 */
  const commitFetchedEntry = (
    connectionId: string,
    scope: DockerSidebarRefreshScope,
    fetched: DockerSidebarCacheEntry,
  ): DockerSidebarCacheEntry => {
    if (scope.kind === "category") {
      const merged = mergeDockerSidebarCategoryFetch(
        get().getEntry(connectionId),
        fetched,
        scope.category,
      );
      get().patchEntry(connectionId, merged);
      return merged;
    }
    get().patchEntry(connectionId, fetched);
    return fetched;
  };

  return {
    connections: {},
    refreshingKeys: {},
    hydrated: false,

    hydrate: async () => {
      if (get().hydrated) {
        return;
      }
      if (hydrateInFlight) {
        await hydrateInFlight;
        return;
      }
      hydrateInFlight = (async () => {
        try {
          // 清理旧版 localStorage 大 JSON，避免与后端缓存双写
          try {
            localStorage.removeItem("omnipanel-docker-sidebar-cache.v1");
          } catch {
            // ignore
          }
          const snapshot = await unwrapCommand(commands.dockerLoadSidebarCache());
          set((state) => {
            const connections: Record<string, DockerSidebarCacheEntry> = {
              ...state.connections,
            };
            for (const [id, entry] of Object.entries(snapshot.connections ?? {})) {
              const loaded = fromBackendEntry(entry);
              const current = connections[id];
              // 并发 refresh 已写入更新结果时，不覆盖
              if (
                current &&
                current.refreshedAt != null &&
                (loaded.refreshedAt == null || current.refreshedAt >= loaded.refreshedAt)
              ) {
                continue;
              }
              connections[id] = loaded;
            }
            return { connections, hydrated: true };
          });
        } catch {
          set({ hydrated: true });
        }
      })();
      try {
        await hydrateInFlight;
      } finally {
        hydrateInFlight = null;
      }
    },

    getEntry: (connectionId) => {
      const entry = get().connections[connectionId];
      if (!entry) {
        return EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY;
      }
      return entry.loadedCategories ? entry : normalizeCacheEntry(entry);
    },

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
      const normalized = normalizeCacheEntry(entry);
      // 同步写入：若用 startTransition，会出现 refreshing 已结束但数据未到的空窗，侧栏「加载中」闪烁
      set((state) => ({
        connections: {
          ...state.connections,
          [connectionId]: normalized,
        },
      }));
      schedulePersistConnection(connectionId, (id) => get().getEntry(id));
    },

    removeConnection: (connectionId) => {
      set((state) => {
        if (!(connectionId in state.connections)) {
          return state;
        }
        const connections = { ...state.connections };
        delete connections[connectionId];
        return { connections };
      });
      void unwrapCommand(commands.dockerRemoveSidebarCache(connectionId)).catch(() => {});
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
            const fetched = await fetchDockerSidebarResources(scope, current);
            if (refreshEpochByKey.get(key) !== epoch) {
              return get().getEntry(connectionId);
            }
            return commitFetchedEntry(connectionId, scope, fetched);
          } catch (error) {
            if (refreshEpochByKey.get(key) !== epoch) {
              return get().getEntry(connectionId);
            }
            // 失败时也基于最新缓存合并，避免抹掉其它分类
            const failed = failedEntry(get().getEntry(connectionId), error);
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
