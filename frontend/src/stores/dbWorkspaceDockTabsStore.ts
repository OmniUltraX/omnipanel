import { create } from "zustand";
import type { DbWorkspaceTab } from "../modules/database/workspace/workspaceTabs";

type TabsUpdate =
  | DbWorkspaceTab[]
  | ((prev: DbWorkspaceTab[]) => DbWorkspaceTab[]);

interface DbWorkspaceDockTabsState {
  tabs: DbWorkspaceTab[];
  initialized: boolean;
  setTabs: (update: TabsUpdate) => void;
  setInitialized: (initialized: boolean) => void;
  reset: () => void;
}

/**
 * 数据库模块 Dock Tab 列表真相源（与 React Panel 解耦）。
 * SessionService / 持久化 / Panel 均读此 store，避免 LRU 卸载丢本地 useState。
 */
export const useDbWorkspaceDockTabsStore = create<DbWorkspaceDockTabsState>((set, get) => ({
  tabs: [],
  initialized: false,
  setTabs: (update) => {
    const prev = get().tabs;
    const next = typeof update === "function" ? update(prev) : update;
    if (next === prev) return;
    set({ tabs: next });
  },
  setInitialized: (initialized) =>
    set((state) => (state.initialized === initialized ? state : { initialized })),
  reset: () => set({ tabs: [], initialized: false }),
}));
