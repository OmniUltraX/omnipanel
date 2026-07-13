import type { SerializedDockview } from "dockview-core";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  findPreviewDockTab,
  findTabIdForCompose,
  findTabIdForConnection,
  findTabIdForContainer,
  findTabIdForImages,
  findTabIdForNetworks,
  findTabIdForVolumes,
  makeComposeTabId,
  makeConnectionTabId,
  makeContainerTabId,
  makeImagesTabId,
  makeNetworksTabId,
  makeVolumesTabId,
  sanitizeDockerDockTabs,
  type DockerConnectionDockOpenMode,
  type DockerConnectionPanelTab,
  type DockerConnectionWorkspaceTab,
  type DockerComposePanelTab,
  type DockerContainerPanelTab,
  type DockerImagesPanelTab,
  type DockerNetworksPanelTab,
  type DockerVolumesPanelTab,
} from "../modules/docker/dockerConnectionWorkspaceTabs";

interface DockerPanelDockState {
  tabs: DockerConnectionWorkspaceTab[];
  activeTabId: string | null;
  dockLayout: SerializedDockview | null;
  selectConnection: (connectionId: string, mode?: DockerConnectionDockOpenMode) => void;
  selectContainer: (
    connectionId: string,
    containerId: string,
    mode?: DockerConnectionDockOpenMode,
  ) => void;
  selectImages: (connectionId: string, mode?: DockerConnectionDockOpenMode) => void;
  selectNetworks: (connectionId: string, mode?: DockerConnectionDockOpenMode) => void;
  selectVolumes: (connectionId: string, mode?: DockerConnectionDockOpenMode) => void;
  selectCompose: (
    connectionId: string,
    composeProject: string,
    mode?: DockerConnectionDockOpenMode,
  ) => void;
  closeTab: (tabId: string) => void;
  setActiveTabId: (tabId: string | null) => void;
  setDockLayout: (layout: SerializedDockview | null) => void;
  removeConnectionTabs: (connectionId: string) => void;
  removeContainerTabs: (connectionId: string, containerId: string) => void;
}

function getActiveConnectionId(
  tabs: DockerConnectionWorkspaceTab[],
  activeTabId: string | null,
): string | null {
  if (!activeTabId) return null;
  return tabs.find((tab) => tab.id === activeTabId)?.connectionId ?? null;
}

function makeConnectionTab(
  id: string,
  connectionId: string,
  preview: boolean,
): DockerConnectionPanelTab {
  return { id, kind: "connection", connectionId, preview, label: "" };
}

function makeContainerTab(
  id: string,
  connectionId: string,
  containerId: string,
  preview: boolean,
): DockerContainerPanelTab {
  return { id, kind: "container", connectionId, containerId, preview, label: "" };
}

function makeImagesTab(
  id: string,
  connectionId: string,
  preview: boolean,
): DockerImagesPanelTab {
  return { id, kind: "images", connectionId, preview, label: "" };
}

function makeNetworksTab(
  id: string,
  connectionId: string,
  preview: boolean,
): DockerNetworksPanelTab {
  return { id, kind: "networks", connectionId, preview, label: "" };
}

function makeVolumesTab(
  id: string,
  connectionId: string,
  preview: boolean,
): DockerVolumesPanelTab {
  return { id, kind: "volumes", connectionId, preview, label: "" };
}

function makeComposeTab(
  id: string,
  connectionId: string,
  composeProject: string,
  preview: boolean,
): DockerComposePanelTab {
  return { id, kind: "compose", connectionId, composeProject, preview, label: "" };
}

function reconcileActiveTabId(
  tabs: DockerConnectionWorkspaceTab[],
  activeTabId: string | null,
): string | null {
  if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) {
    return activeTabId;
  }
  return tabs[tabs.length - 1]?.id ?? null;
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
                    ? makeConnectionTab(previewTab.id, connectionId, false)
                    : tab,
                ),
                activeTabId: previewTab.id,
              };
            }
            const id = makeConnectionTabId();
            return {
              tabs: [...state.tabs, makeConnectionTab(id, connectionId, false)],
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
                  ? makeConnectionTab(previewTab.id, connectionId, true)
                  : tab,
              ),
              activeTabId: previewTab.id,
            };
          }

          if (existingTabId) {
            return { activeTabId: existingTabId };
          }

          const id = makeConnectionTabId();
          return {
            tabs: [...state.tabs, makeConnectionTab(id, connectionId, true)],
            activeTabId: id,
          };
        });
      },

      selectContainer: (connectionId, containerId, mode = "preview") => {
        set((state) => {
          const existingTabId = findTabIdForContainer(state.tabs, connectionId, containerId);
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
                    ? makeContainerTab(previewTab.id, connectionId, containerId, false)
                    : tab,
                ),
                activeTabId: previewTab.id,
              };
            }
            const id = makeContainerTabId();
            return {
              tabs: [...state.tabs, makeContainerTab(id, connectionId, containerId, false)],
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
                  ? makeContainerTab(previewTab.id, connectionId, containerId, true)
                  : tab,
              ),
              activeTabId: previewTab.id,
            };
          }

          if (existingTabId) {
            return { activeTabId: existingTabId };
          }

          const id = makeContainerTabId();
          return {
            tabs: [...state.tabs, makeContainerTab(id, connectionId, containerId, true)],
            activeTabId: id,
          };
        });
      },

      selectImages: (connectionId, mode = "preview") => {
        set((state) => {
          const existingTabId = findTabIdForImages(state.tabs, connectionId);
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
                    ? makeImagesTab(previewTab.id, connectionId, false)
                    : tab,
                ),
                activeTabId: previewTab.id,
              };
            }
            const id = makeImagesTabId();
            return {
              tabs: [...state.tabs, makeImagesTab(id, connectionId, false)],
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
                  ? makeImagesTab(previewTab.id, connectionId, true)
                  : tab,
              ),
              activeTabId: previewTab.id,
            };
          }

          if (existingTabId) {
            return { activeTabId: existingTabId };
          }

          const id = makeImagesTabId();
          return {
            tabs: [...state.tabs, makeImagesTab(id, connectionId, true)],
            activeTabId: id,
          };
        });
      },

      selectNetworks: (connectionId, mode = "preview") => {
        set((state) => {
          const existingTabId = findTabIdForNetworks(state.tabs, connectionId);
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
                    ? makeNetworksTab(previewTab.id, connectionId, false)
                    : tab,
                ),
                activeTabId: previewTab.id,
              };
            }
            const id = makeNetworksTabId();
            return {
              tabs: [...state.tabs, makeNetworksTab(id, connectionId, false)],
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
                  ? makeNetworksTab(previewTab.id, connectionId, true)
                  : tab,
              ),
              activeTabId: previewTab.id,
            };
          }

          if (existingTabId) {
            return { activeTabId: existingTabId };
          }

          const id = makeNetworksTabId();
          return {
            tabs: [...state.tabs, makeNetworksTab(id, connectionId, true)],
            activeTabId: id,
          };
        });
      },

      selectVolumes: (connectionId, mode = "preview") => {
        set((state) => {
          const existingTabId = findTabIdForVolumes(state.tabs, connectionId);
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
                    ? makeVolumesTab(previewTab.id, connectionId, false)
                    : tab,
                ),
                activeTabId: previewTab.id,
              };
            }
            const id = makeVolumesTabId();
            return {
              tabs: [...state.tabs, makeVolumesTab(id, connectionId, false)],
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
                  ? makeVolumesTab(previewTab.id, connectionId, true)
                  : tab,
              ),
              activeTabId: previewTab.id,
            };
          }

          if (existingTabId) {
            return { activeTabId: existingTabId };
          }

          const id = makeVolumesTabId();
          return {
            tabs: [...state.tabs, makeVolumesTab(id, connectionId, true)],
            activeTabId: id,
          };
        });
      },

      selectCompose: (connectionId, composeProject, mode = "preview") => {
        set((state) => {
          const existingTabId = findTabIdForCompose(state.tabs, connectionId, composeProject);
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
                    ? makeComposeTab(previewTab.id, connectionId, composeProject, false)
                    : tab,
                ),
                activeTabId: previewTab.id,
              };
            }
            const id = makeComposeTabId();
            return {
              tabs: [...state.tabs, makeComposeTab(id, connectionId, composeProject, false)],
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
                  ? makeComposeTab(previewTab.id, connectionId, composeProject, true)
                  : tab,
              ),
              activeTabId: previewTab.id,
            };
          }

          if (existingTabId) {
            return { activeTabId: existingTabId };
          }

          const id = makeComposeTabId();
          return {
            tabs: [...state.tabs, makeComposeTab(id, connectionId, composeProject, true)],
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
          return {
            tabs,
            activeTabId: reconcileActiveTabId(tabs, state.activeTabId),
          };
        });
      },

      setActiveTabId: (tabId) => set({ activeTabId: tabId }),

      setDockLayout: (layout) => set({ dockLayout: layout }),

      removeConnectionTabs: (connectionId) => {
        set((state) => {
          const tabs = state.tabs.filter((tab) => tab.connectionId !== connectionId);
          return {
            tabs,
            activeTabId: reconcileActiveTabId(tabs, state.activeTabId),
          };
        });
      },

      removeContainerTabs: (connectionId, containerId) => {
        set((state) => {
          const normalized = containerId.trim().toLowerCase();
          const tabs = state.tabs.filter(
            (tab) =>
              !(
                tab.kind === "container" &&
                tab.connectionId === connectionId &&
                tab.containerId.trim().toLowerCase() === normalized
              ),
          );
          return {
            tabs,
            activeTabId: reconcileActiveTabId(tabs, state.activeTabId),
          };
        });
      },
    }),
    {
      name: "omnipanel-docker-panel-dock.v1",
      version: 2,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted) => {
        if (!persisted || typeof persisted !== "object") {
          return persisted as DockerPanelDockState;
        }
        const state = persisted as DockerPanelDockState;
        const tabs = sanitizeDockerDockTabs(state.tabs ?? []);
        return {
          ...state,
          tabs,
          activeTabId: reconcileActiveTabId(tabs, state.activeTabId ?? null),
        };
      },
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
