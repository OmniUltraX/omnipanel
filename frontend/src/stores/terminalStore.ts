import { create } from "zustand";
import type { Terminal } from "@xterm/xterm";

let tabCounter = 0;

export function createTerminalTabId() {
  tabCounter += 1;
  return `tab-${tabCounter}`;
}

export interface TerminalPane {
  id: string;
  backendSessionId: string | null;
  title: string;
  type: "local" | "remote";
  resourceId: string;
  shellLabel: string;
  cwd: string;
  purpose: string;
  commandPack: string[];
  terminal: Terminal | null;
  status: "connecting" | "connected" | "disconnected";
}

export interface TerminalTab {
  id: string;
  title: string;
  panes: TerminalPane[];
  activePaneId: string;
}

interface CreateTabOptions {
  title?: string;
}

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;

  addTab: (pane: Omit<TerminalPane, "terminal" | "status" | "backendSessionId">, options?: CreateTabOptions) => void;
  removeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  setActivePane: (tabId: string, paneId: string) => void;
  addPaneToTab: (tabId: string, pane: TerminalPane) => void;
  removePaneFromTab: (tabId: string, paneId: string) => void;
  setTerminal: (paneId: string, terminal: Terminal) => void;
  setStatus: (paneId: string, status: TerminalPane["status"]) => void;
  setBackendSessionId: (paneId: string, backendSessionId: string | null) => void;
  findTabByResourceId: (resourceId: string, type?: TerminalPane["type"]) => TerminalTab | undefined;
  openOrFocusSshTab: (hostId: string, title: string) => string;
  openOrFocusLocalTab: (title?: string) => string;
}

function updatePaneInTabs(
  tabs: TerminalTab[],
  paneId: string,
  updater: (pane: TerminalPane) => TerminalPane
): TerminalTab[] {
  return tabs.map((tab) => ({
    ...tab,
    panes: tab.panes.map((pane) => (pane.id === paneId ? updater(pane) : pane)),
  }));
}

function createPane(
  pane: Omit<TerminalPane, "terminal" | "status" | "backendSessionId">
): TerminalPane {
  return {
    ...pane,
    terminal: null,
    status: "connecting",
    backendSessionId: null,
  };
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTab: (pane, options) =>
    set((state) => {
      const rootPane = createPane(pane);
      const newTab: TerminalTab = {
        id: pane.id,
        title: options?.title ?? pane.title,
        panes: [rootPane],
        activePaneId: rootPane.id,
      };
      return {
        tabs: [...state.tabs, newTab],
        activeTabId: state.activeTabId ?? newTab.id,
      };
    }),

  removeTab: (tabId) =>
    set((state) => {
      const remaining = state.tabs.filter((tab) => tab.id !== tabId);
      const nextActiveTabId =
        state.activeTabId === tabId
          ? remaining.length > 0
            ? remaining[Math.max(remaining.length - 1, 0)].id
            : null
          : state.activeTabId;
      return { tabs: remaining, activeTabId: nextActiveTabId };
    }),

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  setActivePane: (tabId, paneId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, activePaneId: paneId } : tab)),
    })),

  addPaneToTab: (tabId, pane) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? { ...tab, panes: [...tab.panes, pane], activePaneId: pane.id }
          : tab
      ),
    })),

  removePaneFromTab: (tabId, paneId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const remainingPanes = tab.panes.filter((p) => p.id !== paneId);
        if (remainingPanes.length === 0) return tab;
        const newActivePaneId =
          tab.activePaneId === paneId
            ? remainingPanes[remainingPanes.length - 1].id
            : tab.activePaneId;
        return { ...tab, panes: remainingPanes, activePaneId: newActivePaneId };
      }),
    })),

  setTerminal: (paneId, terminal) =>
    set((state) => ({
      tabs: updatePaneInTabs(state.tabs, paneId, (pane) => ({ ...pane, terminal })),
    })),

  setStatus: (paneId, status) =>
    set((state) => ({
      tabs: updatePaneInTabs(state.tabs, paneId, (pane) => ({ ...pane, status })),
    })),

  setBackendSessionId: (paneId, backendSessionId) =>
    set((state) => ({
      tabs: updatePaneInTabs(state.tabs, paneId, (pane) => ({ ...pane, backendSessionId })),
    })),

  findTabByResourceId: (resourceId, type) =>
    get().tabs.find((tab) =>
      tab.panes.some((pane) => pane.resourceId === resourceId && (type ? pane.type === type : true))
    ),

  openOrFocusSshTab: (hostId, title) => {
    const existing = get().findTabByResourceId(hostId, "remote");
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }

    const id = createTerminalTabId();
    get().addTab(
      {
        id,
        title,
        type: "remote",
        resourceId: hostId,
        shellLabel: "SSH",
        cwd: "~/",
        purpose: "SSH Workbench",
        commandPack: [],
      },
      { title }
    );
    set({ activeTabId: id });
    return id;
  },

  openOrFocusLocalTab: (title = "本地终端") => {
    const existing = get().findTabByResourceId("local-terminal", "local");
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }

    const id = createTerminalTabId();
    get().addTab(
      {
        id,
        title,
        type: "local",
        resourceId: "local-terminal",
        shellLabel: "PowerShell",
        cwd: "~/workspace",
        purpose: "Local Workspace",
        commandPack: [],
      },
      { title }
    );
    set({ activeTabId: id });
    return id;
  },
}));
