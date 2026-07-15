import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
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
 * 侧栏资源（容器/镜像/网络/卷）缓存：localStorage 持久化，启动时自动 rehydrate。
 * 写盘防抖，避免每次刷新同步阻塞；不持久化 refreshingKeys。
 * 读路径一律走本 store；写路径仅「节点刷新按钮」或业务变更后的局部 refreshScope（不自动后台刷新）。
 */
const PERSIST_KEY = "omnipanel-docker-sidebar-cache.v1";
const PERSIST_DEBOUNCE_MS = 400;

/** 含排队等待；超时后结束 loading，避免侧栏永久「加载中」 */
const SIDEBAR_REFRESH_TIMEOUT_MS = 45_000;

type DockerSidebarCacheState = {
  connections: Record<string, DockerSidebarCacheEntry>;
  refreshingKeys: Record<string, true>;
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
  return {
    ...entry,
    loadedCategories: entry.loadedCategories ?? {},
  };
}

/** 防抖写 localStorage，退出/隐藏时立刻 flush，避免丢最后一次刷新结果。 */
function createDebouncedLocalStorage(debounceMs: number): StateStorage {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { name: string; value: string } | null = null;

  const flush = () => {
    if (!pending || typeof localStorage === "undefined") return;
    const { name, value } = pending;
    pending = null;
    try {
      localStorage.setItem(name, value);
    } catch {
      // quota / privacy mode
    }
  };

  if (typeof window !== "undefined") {
    const onLeave = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flush();
    };
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
  }

  return {
    getItem: (name) => {
      if (typeof localStorage === "undefined") return null;
      try {
        return localStorage.getItem(name);
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      pending = { name, value };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, debounceMs);
    },
    removeItem: (name) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
      if (typeof localStorage === "undefined") return;
      try {
        localStorage.removeItem(name);
      } catch {
        // ignore
      }
    },
  };
}

/** 单例：createJSONStorage 每次操作会调用 getStorage()，避免重复挂 pagehide 监听 */
const debouncedSidebarCacheStorage = createDebouncedLocalStorage(PERSIST_DEBOUNCE_MS);

export const useDockerSidebarCacheStore = create<DockerSidebarCacheState>()(
  persist(
    (set, get) => {
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

        getEntry: (connectionId) => {
          const entry = get().connections[connectionId] ?? EMPTY_DOCKER_SIDEBAR_CACHE_ENTRY;
          // 兼容热更新前缓存缺省字段
          if (entry.loadedCategories) return entry;
          return { ...entry, loadedCategories: {} };
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
    },
    {
      name: PERSIST_KEY,
      version: 1,
      storage: createJSONStorage(() => debouncedSidebarCacheStorage),
      partialize: (state) => ({
        connections: state.connections,
      }),
      migrate: (persisted) => {
        if (!persisted || typeof persisted !== "object") {
          return persisted as { connections: Record<string, DockerSidebarCacheEntry> };
        }
        const state = persisted as { connections?: Record<string, DockerSidebarCacheEntry> };
        const raw = state.connections ?? {};
        const connections: Record<string, DockerSidebarCacheEntry> = {};
        for (const [id, entry] of Object.entries(raw)) {
          if (entry && typeof entry === "object") {
            connections[id] = normalizeCacheEntry(entry);
          }
        }
        return { connections };
      },
    },
  ),
);
