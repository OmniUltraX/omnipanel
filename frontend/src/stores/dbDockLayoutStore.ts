import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { LayoutBase } from "rc-dock";
import { removeTabFromRcLayout, collectTabIds } from "../components/dock/dockRcLayout";

const STORAGE_KEY = "omnipanel.dbDockLayout.v3";
const STORAGE_VERSION = 3;

interface DbDockLayoutState {
  savedLayout: LayoutBase | null;
  setSavedLayout: (layout: LayoutBase | null) => void;
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

/** 关闭 tab 时从 rc-dock 布局中移除 */
export function removeTabFromLayout(savedLayout: LayoutBase | null, tabId: string): LayoutBase | null {
  if (!savedLayout) return null;
  const next = removeTabFromRcLayout(savedLayout, tabId);
  if (collectTabIds(next).size === 0) return null;
  return next;
}
