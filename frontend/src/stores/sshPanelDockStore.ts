import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  findPreviewDockTab,
  findTabIdForHost,
  makeHostTabId,
  type HostDockOpenMode,
  type SshHostWorkspaceTab,
} from "../modules/server/ssh/workspaceTabs";
import { createIndexedDBStorage } from "../lib/indexedDbStorage";

interface SshPanelDockState {
  tabs: SshHostWorkspaceTab[];
  activeTabId: string | null;
  selectHost: (hostId: string, label: string, mode?: HostDockOpenMode) => void;
  promoteTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTabId: (tabId: string | null) => void;
  removeHostTabs: (hostId: string) => void;
}

function reconcileActiveTabId(
  tabs: SshHostWorkspaceTab[],
  activeTabId: string | null,
): string | null {
  if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) {
    return activeTabId;
  }
  return tabs[tabs.length - 1]?.id ?? null;
}

function makeHostTab(
  id: string,
  hostId: string,
  label: string,
  preview: boolean,
): SshHostWorkspaceTab {
  return { id, kind: "host", hostId, label, preview };
}

export const useSshPanelDockStore = create<SshPanelDockState>()(
  persist(
    (set) => ({
      tabs: [],
      activeTabId: null,

      selectHost: (hostId, label, mode = "permanent") => {
        set((state) => {
          const existingTabId = findTabIdForHost(state.tabs, hostId);
          const previewTab = findPreviewDockTab(state.tabs);

          if (mode === "permanent") {
            if (existingTabId) {
              return {
                tabs: state.tabs.map((tab) =>
                  tab.id === existingTabId ? { ...tab, preview: false, label } : tab,
                ),
                activeTabId: existingTabId,
              };
            }
            if (previewTab) {
              return {
                tabs: state.tabs.map((tab) =>
                  tab.id === previewTab.id
                    ? makeHostTab(previewTab.id, hostId, label, false)
                    : tab,
                ),
                activeTabId: previewTab.id,
              };
            }
            const id = makeHostTabId();
            return {
              tabs: [...state.tabs, makeHostTab(id, hostId, label, false)],
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
                tab.id === previewTab.id
                  ? makeHostTab(previewTab.id, hostId, label, true)
                  : tab,
              ),
              activeTabId: previewTab.id,
            };
          }

          if (existingTabId) {
            return { activeTabId: existingTabId };
          }

          const id = makeHostTabId();
          return {
            tabs: [...state.tabs, makeHostTab(id, hostId, label, true)],
            activeTabId: id,
          };
        });
      },

      promoteTab: (tabId) => {
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === tabId ? { ...tab, preview: false } : tab,
          ),
        }));
      },

      closeTab: (tabId) => {
        set((state) => {
          if (!state.tabs.some((tab) => tab.id === tabId)) {
            return state;
          }
          const tabs = state.tabs.filter((tab) => tab.id !== tabId);
          return {
            tabs,
            activeTabId: reconcileActiveTabId(tabs, state.activeTabId),
          };
        });
      },

      setActiveTabId: (tabId) => set({ activeTabId: tabId }),

      removeHostTabs: (hostId) => {
        set((state) => {
          const tabs = state.tabs.filter((tab) => tab.hostId !== hostId);
          return {
            tabs,
            activeTabId: reconcileActiveTabId(tabs, state.activeTabId),
          };
        });
      },
    }),
    {
      name: "omnipanel-ssh-panel-dock.v1",
      version: 1,
      storage: createJSONStorage(createIndexedDBStorage),
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
      }),
      migrate: (persisted) => {
        const state = persisted as SshPanelDockState | undefined;
        if (!state) return { tabs: [], activeTabId: null };
        const tabs = (state.tabs ?? []).filter(
          (tab) => tab?.kind === "host" && typeof tab.hostId === "string",
        );
        return {
          tabs,
          activeTabId: reconcileActiveTabId(tabs, state.activeTabId ?? null),
        };
      },
    },
  ),
);

export function getActiveSshPanelHostId(): string | null {
  const { tabs, activeTabId } = useSshPanelDockStore.getState();
  if (!activeTabId) return null;
  return tabs.find((tab) => tab.id === activeTabId)?.hostId ?? null;
}
