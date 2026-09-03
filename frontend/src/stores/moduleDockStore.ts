import type { SerializedDockview } from "dockview-core";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  isLayoutUsable,
  normalizeDockLayout,
} from "../components/dock/dockViewLayout";
import { createSafeLocalStorage } from "../lib/zustandPersistStorage";
import {
  findModuleTabId,
  makeModuleTabId,
  openOrFocusModuleTab,
  reconcileModuleActiveTabId,
  type ModuleDockOpenMode,
  type ModuleWorkspaceTab,
} from "../modules/plugin-module/moduleWorkspaceTabs";

interface ModuleDockState {
  tabs: ModuleWorkspaceTab[];
  activeTabId: string | null;
  dockLayout: SerializedDockview | null;
  openTab: (
    moduleKey: string,
    connectionId: string,
    capabilityId: string,
    mode?: ModuleDockOpenMode,
  ) => void;
  closeTab: (tabId: string) => void;
  setActiveTabId: (tabId: string | null) => void;
  setDockLayout: (layout: SerializedDockview | null) => void;
  removeConnectionTabs: (connectionId: string) => void;
}

export const useModuleDockStore = create<ModuleDockState>()(
  persist(
    (set) => ({
      tabs: [],
      activeTabId: null,
      dockLayout: null,

      openTab: (moduleKey, connectionId, capabilityId, mode = "preview") => {
        set((state) =>
          openOrFocusModuleTab(
            state.tabs,
            state.activeTabId,
            mode,
            findModuleTabId(state.tabs, moduleKey, connectionId, capabilityId),
            (id, preview) => ({
              id: id || makeModuleTabId(moduleKey, connectionId, capabilityId),
              moduleKey,
              connectionId,
              capabilityId,
              preview,
            }),
          ),
        );
      },

      closeTab: (tabId) => {
        set((state) => {
          const tabs = state.tabs.filter((tab) => tab.id !== tabId);
          return { tabs, activeTabId: reconcileModuleActiveTabId(tabs, state.activeTabId) };
        });
      },

      setActiveTabId: (tabId) => set({ activeTabId: tabId }),
      setDockLayout: (layout) => {
        const next = normalizeDockLayout(layout);
        set({ dockLayout: next && isLayoutUsable(next) ? next : null });
      },

      removeConnectionTabs: (connectionId) => {
        set((state) => {
          const tabs = state.tabs.filter((tab) => tab.connectionId !== connectionId);
          return { tabs, activeTabId: reconcileModuleActiveTabId(tabs, state.activeTabId) };
        });
      },
    }),
    {
      name: "omnipanel.module.dock",
      version: 1,
      storage: createJSONStorage(createSafeLocalStorage),
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        dockLayout: state.dockLayout,
      }),
    },
  ),
);
