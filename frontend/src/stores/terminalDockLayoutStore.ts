import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { SerializedDockview } from "dockview-core";
import {
  removePanelFromLayout,
  collectPanelIds,
  isLayoutUsable,
} from "../components/dock/dockViewLayout";

const STORAGE_KEY = "omnipanel.terminalDockLayout.v1";
const STORAGE_VERSION = 1;

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

/** 关闭 tab 时从 dockview 布局中移除；nextActiveTabId 为关闭后应激活的 tab */
export function removeTabFromTerminalLayout(
  savedLayout: SerializedDockview | null,
  tabId: string,
  nextActiveTabId?: string,
): SerializedDockview | null {
  const next = removePanelFromLayout(savedLayout, tabId, nextActiveTabId);
  if (next && collectPanelIds(next).size === 0) return null;
  return next;
}
