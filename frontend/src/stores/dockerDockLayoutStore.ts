import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { SerializedDockview } from "dockview-core";
import {
  removePanelFromLayout,
  collectPanelIds,
  isLayoutUsable,
} from "../components/dock/dockViewLayout";

const STORAGE_KEY = "omnipanel.dockerDockLayout.v1";
const STORAGE_VERSION = 1;

interface DockerDockLayoutState {
  savedLayout: SerializedDockview | null;
  setSavedLayout: (layout: SerializedDockview | null) => void;
  reset: () => void;
}

export const useDockerDockLayoutStore = create<DockerDockLayoutState>()(
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
      migrate: (persistedState) => {
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
export function removeTabFromDockerLayout(
  savedLayout: SerializedDockview | null,
  tabId: string,
): SerializedDockview | null {
  const next = removePanelFromLayout(savedLayout, tabId);
  if (next && collectPanelIds(next).size === 0) return null;
  return next;
}
