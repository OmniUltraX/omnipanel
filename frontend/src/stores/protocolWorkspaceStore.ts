import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SerializedDockview } from "dockview-core";
import type { ProtocolTabKey } from "../lib/protocolLabConfig";
import { removePanelFromLayout } from "../components/dock/dockViewLayout";

export interface ProtocolWorkspaceTab {
  id: string;
  protocol: ProtocolTabKey;
  label: string;
  /** HTTP 等为已持久化资源 id；MQTT 等待定协议可为 null */
  resourceId: string | null;
}

export interface OpenProtocolSessionInput {
  protocol: ProtocolTabKey;
  label?: string;
  resourceId?: string | null;
}

interface ProtocolWorkspaceState {
  tabs: ProtocolWorkspaceTab[];
  activeTabId: string | null;
  savedLayout: SerializedDockview | null;
  openSessionTab: (input: OpenProtocolSessionInput) => string;
  closeTab: (tabId: string) => void;
  setActiveTabId: (tabId: string | null) => void;
  updateTabLabel: (tabId: string, label: string) => void;
  setSavedLayout: (layout: SerializedDockview | null) => void;
  reset: () => void;
}

function createProtocolTabId(protocol: ProtocolTabKey): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : String(Date.now());
  return `protocol-${protocol}-${suffix}`;
}

function pickNextActiveTabId(
  tabs: ProtocolWorkspaceTab[],
  closingTabId: string,
  currentActive: string | null,
): string | null {
  if (currentActive !== closingTabId) {
    return currentActive;
  }
  const remaining = tabs.filter((tab) => tab.id !== closingTabId);
  return remaining[remaining.length - 1]?.id ?? null;
}

const EMPTY_STATE = {
  tabs: [] as ProtocolWorkspaceTab[],
  activeTabId: null as string | null,
  savedLayout: null as SerializedDockview | null,
};

export const useProtocolWorkspaceStore = create<ProtocolWorkspaceState>()(
  persist(
    (set, get) => ({
      ...EMPTY_STATE,
      openSessionTab: (input) => {
        const resourceId = input.resourceId ?? null;
        if (resourceId) {
          const existing = get().tabs.find(
            (tab) => tab.protocol === input.protocol && tab.resourceId === resourceId,
          );
          if (existing) {
            set({ activeTabId: existing.id });
            return existing.id;
          }
        }
        const tab: ProtocolWorkspaceTab = {
          id: createProtocolTabId(input.protocol),
          protocol: input.protocol,
          label: input.label?.trim() || input.protocol,
          resourceId,
        };
        set((state) => ({
          tabs: [...state.tabs, tab],
          activeTabId: tab.id,
        }));
        return tab.id;
      },
      closeTab: (tabId) => {
        const state = get();
        const tabs = state.tabs.filter((tab) => tab.id !== tabId);
        set({
          tabs,
          activeTabId: pickNextActiveTabId(state.tabs, tabId, state.activeTabId),
          savedLayout: removePanelFromLayout(state.savedLayout, tabId),
        });
      },
      setActiveTabId: (activeTabId) => set({ activeTabId }),
      updateTabLabel: (tabId, label) => {
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === tabId ? { ...tab, label: label.trim() || tab.label } : tab,
          ),
        }));
      },
      setSavedLayout: (savedLayout) => set({ savedLayout }),
      reset: () => set({ ...EMPTY_STATE }),
    }),
    {
      name: "omnipanel-protocol-workspace.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        savedLayout: state.savedLayout,
      }),
      migrate: (persisted, _version) => {
        const state = persisted as Partial<ProtocolWorkspaceState> | undefined;
        if (!state?.tabs) return persisted;
        return {
          ...state,
          tabs: state.tabs.map((tab) => ({
            ...tab,
            label: (tab as ProtocolWorkspaceTab).label ?? tab.protocol,
            resourceId: (tab as ProtocolWorkspaceTab).resourceId ?? null,
          })),
        };
      },
      version: 1,
    },
  ),
);
