import { create } from "zustand";
import type { Terminal } from "@xterm/xterm";

export interface TerminalTab {
  id: string;
  title: string;
  type: "local" | "remote";
  terminal: Terminal | null;
  status: "connecting" | "connected" | "disconnected";
}

export type PaneLayout =
  | { type: "leaf"; tabId: string }
  | { type: "split"; direction: "horizontal" | "vertical"; children: PaneLayout[] };

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  layout: PaneLayout | null;

  addTab: (tab: Omit<TerminalTab, "terminal" | "status">) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setTerminal: (id: string, terminal: Terminal) => void;
  setStatus: (id: string, status: TerminalTab["status"]) => void;
  splitPane: (tabId: string, direction: "horizontal" | "vertical", newTabId: string) => void;
}

function splitInLayout(
  layout: PaneLayout,
  targetTabId: string,
  direction: "horizontal" | "vertical",
  newTabId: string
): PaneLayout {
  if (layout.type === "leaf" && layout.tabId === targetTabId) {
    return {
      type: "split",
      direction,
      children: [
        { type: "leaf", tabId: targetTabId },
        { type: "leaf", tabId: newTabId },
      ],
    };
  }
  if (layout.type === "split") {
    return {
      ...layout,
      children: layout.children.map((c) => splitInLayout(c, targetTabId, direction, newTabId)),
    };
  }
  return layout;
}

function removeFromLayout(layout: PaneLayout, tabId: string): PaneLayout | null {
  if (layout.type === "leaf") {
    return layout.tabId === tabId ? null : layout;
  }
  const remaining = layout.children
    .map((c) => removeFromLayout(c, tabId))
    .filter(Boolean) as PaneLayout[];
  if (remaining.length === 0) return null;
  if (remaining.length === 1) return remaining[0];
  return { ...layout, children: remaining };
}

export const useTerminalStore = create<TerminalState>((set) => ({
  tabs: [],
  activeTabId: null,
  layout: null,

  addTab: (tab) =>
    set((state) => {
      const newTab = { ...tab, terminal: null, status: "connecting" as const };
      const newLeaf: PaneLayout = { type: "leaf", tabId: tab.id };
      if (!state.layout) {
        return { tabs: [...state.tabs, newTab], layout: newLeaf };
      }
      // Wrap existing layout + new leaf in a horizontal split
      const newLayout: PaneLayout = {
        type: "split",
        direction: "horizontal",
        children: [state.layout, newLeaf],
      };
      return { tabs: [...state.tabs, newTab], layout: newLayout };
    }),

  removeTab: (id) =>
    set((state) => {
      const remaining = state.tabs.filter((t) => t.id !== id);
      const newActive =
        state.activeTabId === id
          ? remaining.length > 0
            ? remaining[remaining.length - 1].id
            : null
          : state.activeTabId;
      const newLayout = state.layout ? removeFromLayout(state.layout, id) : null;
      return { tabs: remaining, activeTabId: newActive, layout: newLayout };
    }),

  setActiveTab: (id) => set({ activeTabId: id }),

  setTerminal: (id, terminal) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, terminal } : t
      ),
    })),

  setStatus: (id, status) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, status } : t
      ),
    })),

  splitPane: (tabId, direction, newTabId) =>
    set((state) => ({
      layout: state.layout ? splitInLayout(state.layout, tabId, direction, newTabId) : null,
    })),
}));
