import type { SerializedDockview } from "dockview-core";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  findPreviewDockTab,
  findTabIdForServer,
  findTabIdForServerResource,
  makeServerResourceTab,
  makeServerResourceTabId,
  makeServerTabId,
  sanitizeServerPanelDockTabs,
  type ServerPanelDockOpenMode,
  type ServerPanelResourceKind,
  type ServerPanelWorkspaceTab,
} from "../modules/server/panel/serverPanelWorkspaceTabs";

interface ServerPanelDockState {
  tabs: ServerPanelWorkspaceTab[];
  activeTabId: string | null;
  dockLayout: SerializedDockview | null;
  selectServer: (serverId: string, mode?: ServerPanelDockOpenMode) => void;
  selectServerResource: (
    serverId: string,
    kind: ServerPanelResourceKind,
    mode?: ServerPanelDockOpenMode,
  ) => void;
  closeTab: (tabId: string) => void;
  setActiveTabId: (tabId: string | null) => void;
  setDockLayout: (layout: SerializedDockview | null) => void;
  removeServerTabs: (serverId: string) => void;
}

function getActiveServerId(tabs: ServerPanelWorkspaceTab[], activeTabId: string | null): string | null {
  if (!activeTabId) return null;
  return tabs.find((tab) => tab.id === activeTabId)?.serverId ?? null;
}

function openOrFocusTab(
  state: Pick<ServerPanelDockState, "tabs" | "activeTabId">,
  mode: ServerPanelDockOpenMode,
  existingTabId: string | undefined,
  createTab: (id: string, preview: boolean) => ServerPanelWorkspaceTab,
): Partial<ServerPanelDockState> {
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
          tab.id === previewTab.id ? createTab(previewTab.id, false) : tab,
        ),
        activeTabId: previewTab.id,
      };
    }
    const tab = createTab("", false);
    return {
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
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
        tab.id === previewTab.id ? createTab(previewTab.id, true) : tab,
      ),
      activeTabId: previewTab.id,
    };
  }

  if (existingTabId) {
    return { activeTabId: existingTabId };
  }

  const tab = createTab("", true);
  return {
    tabs: [...state.tabs, tab],
    activeTabId: tab.id,
  };
}

export const useServerPanelDockStore = create<ServerPanelDockState>()(
  persist(
    (set) => ({
      tabs: [],
      activeTabId: null,
      dockLayout: null,

      selectServer: (serverId, mode = "permanent") => {
        set((state) =>
          openOrFocusTab(state, mode, findTabIdForServer(state.tabs, serverId), (id, preview) => ({
            id: id || makeServerTabId(),
            kind: "server",
            serverId,
            preview,
            label: "",
          })),
        );
      },

      selectServerResource: (serverId, kind, mode = "permanent") => {
        set((state) =>
          openOrFocusTab(
            state,
            mode,
            findTabIdForServerResource(state.tabs, serverId, kind),
            (id, preview) =>
              makeServerResourceTab(
                id || makeServerResourceTabId(kind),
                serverId,
                kind,
                preview,
              ),
          ),
        );
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
      version: 3,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted) => {
        if (!persisted || typeof persisted !== "object") {
          return persisted as ServerPanelDockState;
        }
        const state = persisted as ServerPanelDockState;
        const tabs = sanitizeServerPanelDockTabs(state.tabs ?? []);
        let activeTabId = state.activeTabId ?? null;
        if (activeTabId && !tabs.some((tab) => tab.id === activeTabId)) {
          activeTabId = tabs[tabs.length - 1]?.id ?? null;
        }
        return { ...state, tabs, activeTabId };
      },
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
