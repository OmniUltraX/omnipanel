import { type Dispatch, type SetStateAction, useCallback } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface ModuleTabState {
  byModule: Record<string, string>;
  setTab: (moduleKey: string, tab: string) => void;
  resetAll: () => void;
}

const useModuleTabStore = create<ModuleTabState>()(
  persist(
    (set) => ({
      byModule: {},
      setTab: (moduleKey, tab) =>
        set((state) => ({
          byModule: { ...state.byModule, [moduleKey]: tab },
        })),
      resetAll: () => set({ byModule: {} }),
    }),
    {
      name: "omnipanel-module-tabs.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ byModule: state.byModule }),
    },
  ),
);

/** 清除模块 Tab 记忆（设置 → 清除应用缓存） */
export function resetModuleTabs(): void {
  useModuleTabStore.getState().resetAll();
}

/** 跨路由/连接切换保留模块顶栏 Tab，不因 remount 或切换资源重置。 */
export function usePersistedModuleTab<T extends string>(
  moduleKey: string,
  defaultTab: T,
  validTabs?: readonly T[],
): [T, Dispatch<SetStateAction<T>>] {
  const stored = useModuleTabStore((s) => s.byModule[moduleKey]);
  const tab =
    stored && (!validTabs || validTabs.includes(stored as T))
      ? (stored as T)
      : defaultTab;

  const setTab = useCallback(
    (next: SetStateAction<T>) => {
      const resolved =
        typeof next === "function" ? (next as (prev: T) => T)(tab) : next;
      const safeTab =
        validTabs && !validTabs.includes(resolved as T) ? defaultTab : resolved;
      useModuleTabStore.getState().setTab(moduleKey, safeTab);
    },
    [defaultTab, moduleKey, tab, validTabs],
  );

  return [tab, setTab];
}
