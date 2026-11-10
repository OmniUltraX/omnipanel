import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createSafeLocalStorage } from "../lib/zustandPersistStorage";
import { commands, type DbxCatalogDriver } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";

const STORAGE_KEY = "omnipanel.dbxCatalog.v1";

type DbxCatalogState = {
  drivers: DbxCatalogDriver[];
  fetchedAt: number | null;
  refreshing: boolean;
  /** 有缓存则立刻返回；后台拉新列表，失败保留旧数据。 */
  refresh: () => Promise<void>;
};

let inFlight: Promise<void> | null = null;

const EMPTY_DBX_DRIVERS: DbxCatalogDriver[] = [];

export function isDbxCatalogDriver(item: unknown): item is DbxCatalogDriver {
  return !!item && typeof item === "object" && typeof (item as DbxCatalogDriver).key === "string";
}

/**
 * 把未知 catalog 收成数组。已是合法数组时必须返回同一引用，
 * 否则 Zustand selector 每次 render 都拿到新数组，会触发 React #185（Maximum update depth exceeded）。
 */
export function asDbxCatalogDrivers(value: unknown): DbxCatalogDriver[] {
  if (!Array.isArray(value)) return EMPTY_DBX_DRIVERS;
  for (const item of value) {
    if (!isDbxCatalogDriver(item)) {
      return value.filter(isDbxCatalogDriver);
    }
  }
  return value;
}

export function sameDbxCatalog(
  a: DbxCatalogDriver[] | unknown,
  b: DbxCatalogDriver[] | unknown,
): boolean {
  const leftList = asDbxCatalogDrivers(a);
  const rightList = asDbxCatalogDrivers(b);
  if (leftList.length !== rightList.length) return false;
  for (let i = 0; i < leftList.length; i += 1) {
    const left = leftList[i];
    const right = rightList[i];
    if (!left || !right) return false;
    if (
      left.key !== right.key ||
      left.installed !== right.installed ||
      left.version !== right.version ||
      left.installedVersion !== right.installedVersion ||
      left.label !== right.label ||
      left.downloads !== right.downloads ||
      left.updatedAt !== right.updatedAt
    ) {
      return false;
    }
  }
  return true;
}

export const useDbxCatalogStore = create<DbxCatalogState>()(
  persist(
    (set, get) => ({
      drivers: [],
      fetchedAt: null,
      refreshing: false,
      refresh: async () => {
        if (inFlight) return inFlight;
        const run = (async () => {
          set({ refreshing: true });
          try {
            const list = asDbxCatalogDrivers(
              await unwrapCommand(commands.pluginDbxCatalog(), {
                quiet: true,
              }),
            );
            const currentDrivers = get().drivers;
            const prev = asDbxCatalogDrivers(currentDrivers);
            if (sameDbxCatalog(prev, list)) {
              // 不要写入新的 drivers 引用，避免订阅组件进入更新环。
              if (prev !== currentDrivers) {
                set({ drivers: prev, fetchedAt: Date.now(), refreshing: false });
              } else {
                set({ fetchedAt: Date.now(), refreshing: false });
              }
              return;
            }
            set({ drivers: list, fetchedAt: Date.now(), refreshing: false });
          } catch {
            set({ refreshing: false });
          } finally {
            inFlight = null;
          }
        })();
        inFlight = run;
        return run;
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(createSafeLocalStorage),
      partialize: (state) => ({
        drivers: asDbxCatalogDrivers(state.drivers),
        fetchedAt: state.fetchedAt,
      }),
      merge: (persisted, current) => {
        const incoming = (persisted ?? {}) as Partial<DbxCatalogState>;
        return {
          ...current,
          ...incoming,
          drivers: asDbxCatalogDrivers(incoming.drivers ?? current.drivers),
        };
      },
    },
  ),
);

/** 启动时预热：不阻塞 UI，有本地缓存时打开对话框即可用。 */
export function warmDbxCatalogCache(): void {
  void useDbxCatalogStore.getState().refresh();
}

/** 仅测试：清空内存态与 in-flight。 */
export function resetDbxCatalogStoreForTests(): void {
  inFlight = null;
  useDbxCatalogStore.setState({
    drivers: [],
    fetchedAt: null,
    refreshing: false,
  });
}
