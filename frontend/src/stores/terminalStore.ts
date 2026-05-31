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
  /** SSH 等模块内嵌终端（不占用顶部终端 Tab） */
  embeddedPanes: Record<string, TerminalPane>;

  addTab: (pane: Omit<TerminalPane, "terminal" | "status" | "backendSessionId">, options?: CreateTabOptions) => void;
  removeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  setActivePane: (tabId: string, paneId: string) => void;
  addPaneToTab: (tabId: string, pane: TerminalPane) => void;
  removePaneFromTab: (tabId: string, paneId: string) => void;
  setTerminal: (paneId: string, terminal: Terminal) => void;
  setStatus: (paneId: string, status: TerminalPane["status"]) => void;
  setBackendSessionId: (paneId: string, backendSessionId: string | null) => void;
  upsertEmbeddedPane: (
    pane: Omit<TerminalPane, "terminal" | "status" | "backendSessionId">,
  ) => string;
  removeEmbeddedPane: (paneId: string) => void;
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

/** 在 Tab 窗格或内嵌窗格中查找（供 useTerminal 使用） */
export function findTerminalPane(paneId: string): TerminalPane | undefined {
  const state = useTerminalStore.getState();
  const embedded = state.embeddedPanes[paneId];
  if (embedded) return embedded;
  for (const tab of state.tabs) {
    const pane = tab.panes.find((item) => item.id === paneId);
    if (pane) return pane;
  }
  return undefined;
}

function patchPaneState(
  state: Pick<TerminalState, "tabs" | "embeddedPanes">,
  paneId: string,
  updater: (pane: TerminalPane) => TerminalPane
): Pick<TerminalState, "tabs" | "embeddedPanes"> {
  if (state.embeddedPanes[paneId]) {
    return {
      tabs: state.tabs,
      embeddedPanes: {
        ...state.embeddedPanes,
        [paneId]: updater(state.embeddedPanes[paneId]),
      },
    };
  }
  return {
    tabs: updatePaneInTabs(state.tabs, paneId, updater),
    embeddedPanes: state.embeddedPanes,
  };
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

export const SSH_EMBEDDED_PANE_PREFIX = "ssh-embed:";

/** SSH 模块内嵌终端工作区 id（首个窗格可能与此 id 相同） */
export function sshEmbeddedWorkspaceId(resourceId: string) {
  return `${SSH_EMBEDDED_PANE_PREFIX}${resourceId}`;
}

/** @deprecated 请使用 sshEmbeddedWorkspaceId */
export function sshEmbeddedPaneId(resourceId: string) {
  return sshEmbeddedWorkspaceId(resourceId);
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  embeddedPanes: {},

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
    set((state) => patchPaneState(state, paneId, (pane) => ({ ...pane, terminal }))),

  setStatus: (paneId, status) =>
    set((state) => patchPaneState(state, paneId, (pane) => ({ ...pane, status }))),

  setBackendSessionId: (paneId, backendSessionId) =>
    set((state) =>
      patchPaneState(state, paneId, (pane) => ({ ...pane, backendSessionId })),
    ),

  upsertEmbeddedPane: (pane) => {
    const id = pane.id;
    set((state) => {
      const existing = state.embeddedPanes[id];
      const next = existing
        ? {
            ...existing,
            ...pane,
            terminal: existing.terminal,
            status: existing.status,
            backendSessionId: existing.backendSessionId,
          }
        : createPane(pane);
      return {
        embeddedPanes: {
          ...state.embeddedPanes,
          [id]: next,
        },
      };
    });
    return id;
  },

  removeEmbeddedPane: (paneId) =>
    set((state) => {
      const { [paneId]: _removed, ...rest } = state.embeddedPanes;
      return { embeddedPanes: rest };
    }),

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
