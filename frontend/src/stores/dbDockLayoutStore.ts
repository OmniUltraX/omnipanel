import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { SerializedDockview } from "dockview-core";
import {
  removePanelFromLayout,
  collectPanelIds,
  isLayoutUsable,
} from "../components/dock/dockViewLayout";

/**
 * v6：在 dockViewLayout 中新增 isLayoutUsable 校验。v5 之前写入的脏数据通过
 *     migrate 主动丢弃。
 * v5：fix dockViewLayout 中 stripMissingPanels/addMissingPanels 的 panels↔views 一致性 bug
 * v4：切换到 dockview 序列化（SerializedDockview），与旧版 rc-dock 布局不兼容。
 */
const STORAGE_KEY = "omnipanel.dbDockLayout.v6";
const STORAGE_VERSION = 6;

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
      migrate: (persistedState, _fromVersion) => {
        const p = persistedState as { savedLayout?: SerializedDockview | null } | undefined;
        if (p && !isLayoutUsable(p.savedLayout ?? null)) {
          return { savedLayout: null } as { savedLayout: SerializedDockview | null };
        }
        return p as { savedLayout: SerializedDockview | null };
      },
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
