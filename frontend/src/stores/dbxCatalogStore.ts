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

export function sameDbxCatalog(
  a: DbxCatalogDriver[],
  b: DbxCatalogDriver[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (
      left.key !== right.key ||
      left.installed !== right.installed ||
      left.version !== right.version ||
      left.installedVersion !== right.installedVersion ||
      left.label !== right.label
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
            const list = await unwrapCommand(commands.pluginDbxCatalog(), {
              quiet: true,
            });
            const prev = get().drivers;
            if (sameDbxCatalog(prev, list)) {
              set({ fetchedAt: Date.now(), refreshing: false });
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
        drivers: state.drivers,
        fetchedAt: state.fetchedAt,
      }),
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
