import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { SerializedDockview } from "dockview-core";
import { removePanelFromLayout, collectPanelIds } from "../components/dock/dockViewLayout";

/**
 * v5：fix dockViewLayout 中 stripMissingPanels/addMissingPanels 的 panels↔views 一致性 bug
 *     （旧版可能产生"view 引用了 panels 中没有的 id"，触发 fromJSON 抛
 *     "Cannot read properties of undefined (reading 'id')"）。v4 期间写入的脏数据一并丢弃。
 * v4：切换到 dockview 序列化（SerializedDockview），与旧版 rc-dock 布局不兼容。
 */
const STORAGE_KEY = "omnipanel.dbDockLayout.v5";
const STORAGE_VERSION = 5;

interface DbDockLayoutState {
  savedLayout: SerializedDockview | null;
  setSavedLayout: (layout: SerializedDockview | null) => void;
  reset: () => void;
}

export const useDbDockLayoutStore = create<DbDockLayoutState>()(
  persist(
    (set) => ({
      savedLayout: null,
      setSavedLayout: (savedLayout) => set({ savedLayout }),
      reset: () => set({ savedLayout: null }),
    }),
    {
      name: STORAGE_KEY,
      version: STORAGE_VERSION,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ savedLayout: state.savedLayout }),
    },
  ),
);

/** 关闭 tab 时从 dockview 布局中移除 */
export function removeTabFromLayout(
  savedLayout: SerializedDockview | null,
  tabId: string,
): SerializedDockview | null {
  const next = removePanelFromLayout(savedLayout, tabId);
  if (next && collectPanelIds(next).size === 0) return null;
  return next;
}
