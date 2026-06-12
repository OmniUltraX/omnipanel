import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { LayoutBase } from "rc-dock";
import { removeTabFromRcLayout, collectTabIds } from "../components/dock/dockRcLayout";

const STORAGE_KEY = "omnipanel.terminalDockLayout.v2";
const STORAGE_VERSION = 2;

interface TerminalDockLayoutState {
  savedLayout: LayoutBase | null;
  setSavedLayout: (layout: LayoutBase | null) => void;
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

export function removeTabFromLayout(savedLayout: LayoutBase | null, tabId: string): LayoutBase | null {
  if (!savedLayout) return null;
  const next = removeTabFromRcLayout(savedLayout, tabId);
  if (collectTabIds(next).size === 0) return null;
  return next;
}
