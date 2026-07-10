import type { SerializedDockview } from "dockview-core";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  findPreviewDockTab,
  findTabIdForServer,
  makeServerTabId,
  type ServerPanelDockOpenMode,
  type ServerPanelWorkspaceTab,
} from "../modules/server/panel/serverPanelWorkspaceTabs";

interface ServerPanelDockState {
  tabs: ServerPanelWorkspaceTab[];
  activeTabId: string | null;
  dockLayout: SerializedDockview | null;
  selectServer: (serverId: string, mode?: ServerPanelDockOpenMode) => void;
  closeTab: (tabId: string) => void;
  setActiveTabId: (tabId: string | null) => void;
  setDockLayout: (layout: SerializedDockview | null) => void;
  removeServerTabs: (serverId: string) => void;
}

function getActiveServerId(tabs: ServerPanelWorkspaceTab[], activeTabId: string | null): string | null {
  if (!activeTabId) return null;
  return tabs.find((tab) => tab.id === activeTabId)?.serverId ?? null;
}

export const useServerPanelDockStore = create<ServerPanelDockState>()(
  persist(
    (set) => ({
      tabs: [],
      activeTabId: null,
      dockLayout: null,

      selectServer: (serverId, mode = "preview") => {
        set((state) => {
          const existingTabId = findTabIdForServer(state.tabs, serverId);
          const previewTab = findPreviewDockTab(state.tabs);

          if (mode === "permanent") {
            if (existingTabId) {
              return {
                tabs: state.tabs.map((tab) =>
                  tab.id === existingTabId ? { ...tab, preview: false } : tab,
                ),
                activeTabId: existingTabId,
              };
            }
            if (previewTab) {
              return {
                tabs: state.tabs.map((tab) =>
                  tab.id === previewTab.id
                    ? { ...tab, serverId, preview: false, label: tab.label }
                    : tab,
                ),
                activeTabId: previewTab.id,
              };
            }
            const id = makeServerTabId();
            return {
              tabs: [...state.tabs, { id, kind: "server", serverId, preview: false, label: "" }],
              activeTabId: id,
            };
          }

          if (existingTabId) {
            const existing = state.tabs.find((tab) => tab.id === existingTabId);
            if (existing && !existing.preview) {
              return { activeTabId: existingTabId };
            }
          }

          if (previewTab) {
            return {
              tabs: state.tabs.map((tab) =>
                tab.id === previewTab.id ? { ...tab, serverId, preview: true } : tab,
              ),
              activeTabId: previewTab.id,
            };
          }

          if (existingTabId) {
            return { activeTabId: existingTabId };
          }

          const id = makeServerTabId();
          return {
            tabs: [...state.tabs, { id, kind: "server", serverId, preview: true, label: "" }],
            activeTabId: id,
          };
        });
      },

      closeTab: (tabId) => {
        set((state) => {
          if (!state.tabs.some((tab) => tab.id === tabId)) {
            return state;
          }
          const tabs = state.tabs.filter((tab) => tab.id !== tabId);
          let activeTabId = state.activeTabId;
          if (state.activeTabId === tabId) {
            activeTabId = tabs[tabs.length - 1]?.id ?? null;
          }
          return { tabs, activeTabId };
        });
      },

      setActiveTabId: (tabId) => set({ activeTabId: tabId }),

      setDockLayout: (layout) => set({ dockLayout: layout }),

      removeServerTabs: (serverId) => {
        set((state) => {
          const tabs = state.tabs.filter((tab) => tab.serverId !== serverId);
          let activeTabId = state.activeTabId;
          if (activeTabId && !tabs.some((tab) => tab.id === activeTabId)) {
            activeTabId = tabs[tabs.length - 1]?.id ?? null;
          }
          return { tabs, activeTabId };
        });
      },
    }),
    {
      name: "omnipanel-server-panel-dock.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        dockLayout: state.dockLayout,
      }),
    },
  ),
);

export function useActiveServerPanelId(): string | null {
  const tabs = useServerPanelDockStore((s) => s.tabs);
  const activeTabId = useServerPanelDockStore((s) => s.activeTabId);
  return getActiveServerId(tabs, activeTabId);
}
