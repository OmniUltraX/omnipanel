import type { SerializedDockview } from "dockview-core";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  findPreviewDockTab,
  findTabIdForConnection,
  makeConnectionTabId,
  type DockerConnectionDockOpenMode,
  type DockerConnectionWorkspaceTab,
} from "../modules/docker/dockerConnectionWorkspaceTabs";

interface DockerPanelDockState {
  tabs: DockerConnectionWorkspaceTab[];
  activeTabId: string | null;
  dockLayout: SerializedDockview | null;
  selectConnection: (connectionId: string, mode?: DockerConnectionDockOpenMode) => void;
  closeTab: (tabId: string) => void;
  setActiveTabId: (tabId: string | null) => void;
  setDockLayout: (layout: SerializedDockview | null) => void;
  removeConnectionTabs: (connectionId: string) => void;
}

function getActiveConnectionId(
  tabs: DockerConnectionWorkspaceTab[],
  activeTabId: string | null,
): string | null {
  if (!activeTabId) return null;
  return tabs.find((tab) => tab.id === activeTabId)?.connectionId ?? null;
}

export const useDockerPanelDockStore = create<DockerPanelDockState>()(
  persist(
    (set) => ({
      tabs: [],
      activeTabId: null,
      dockLayout: null,

      selectConnection: (connectionId, mode = "preview") => {
        set((state) => {
          const existingTabId = findTabIdForConnection(state.tabs, connectionId);
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
                    ? { ...tab, connectionId, preview: false, label: tab.label }
                    : tab,
                ),
                activeTabId: previewTab.id,
              };
            }
            const id = makeConnectionTabId();
            return {
              tabs: [
                ...state.tabs,
                { id, kind: "connection", connectionId, preview: false, label: "" },
              ],
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
                tab.id === previewTab.id ? { ...tab, connectionId, preview: true } : tab,
              ),
              activeTabId: previewTab.id,
            };
          }

          if (existingTabId) {
            return { activeTabId: existingTabId };
          }

          const id = makeConnectionTabId();
          return {
            tabs: [
              ...state.tabs,
              { id, kind: "connection", connectionId, preview: true, label: "" },
            ],
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

      removeConnectionTabs: (connectionId) => {
        set((state) => {
          const tabs = state.tabs.filter((tab) => tab.connectionId !== connectionId);
          let activeTabId = state.activeTabId;
          if (activeTabId && !tabs.some((tab) => tab.id === activeTabId)) {
            activeTabId = tabs[tabs.length - 1]?.id ?? null;
          }
          return { tabs, activeTabId };
        });
      },
    }),
    {
      name: "omnipanel-docker-panel-dock.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        dockLayout: state.dockLayout,
      }),
    },
  ),
);

export function useActiveDockerPanelConnectionId(): string | null {
  const tabs = useDockerPanelDockStore((s) => s.tabs);
  const activeTabId = useDockerPanelDockStore((s) => s.activeTabId);
  return getActiveConnectionId(tabs, activeTabId);
}
