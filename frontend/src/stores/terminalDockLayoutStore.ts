import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { SerializedDockview } from "dockview-core";
import { removePanelFromLayout, collectPanelIds } from "../components/dock/dockViewLayout";

/**
 * v4：fix dockViewLayout 中 stripMissingPanels/addMissingPanels 的 panels↔views 一致性 bug
 *     （旧版可能产生"view 引用了 panels 中没有的 id"，触发 fromJSON 抛
 *     "Cannot read properties of undefined (reading 'id')"）。v3 期间写入的脏数据一并丢弃。
 * v3：切换到 dockview 序列化（SerializedDockview），与旧版 rc-dock 布局不兼容。
 */
const STORAGE_KEY = "omnipanel.terminalDockLayout.v4";
const STORAGE_VERSION = 4;

interface TerminalDockLayoutState {
  savedLayout: SerializedDockview | null;
  setSavedLayout: (layout: SerializedDockview | null) => void;
  reset: () => void;
}

export const useTerminalDockLayoutStore = create<TerminalDockLayoutState>()(
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

export function removeTabFromLayout(
  savedLayout: SerializedDockview | null,
  tabId: string,
): SerializedDockview | null {
  const next = removePanelFromLayout(savedLayout, tabId);
  if (next && collectPanelIds(next).size === 0) return null;
  return next;
}
