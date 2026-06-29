import type { SerializedDockview } from "dockview-core";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

type RecentClosedEntry = {
  requestId: string;
  closedAt: number;
};

interface ProtocolHttpDockState {
  openTabIds: string[];
  activeTabId: string | null;
  dockLayout: SerializedDockview | null;
  recentClosed: RecentClosedEntry[];
  openTab: (requestId: string) => void;
  closeTab: (requestId: string) => void;
  setActiveTabId: (id: string | null) => void;
  setDockLayout: (layout: SerializedDockview | null) => void;
  reopenTab: (requestId: string) => void;
  removeTab: (requestId: string) => void;
}

export const useProtocolHttpDockStore = create<ProtocolHttpDockState>()(
  persist(
    (set) => ({
      openTabIds: [],
      activeTabId: null,
      dockLayout: null,
      recentClosed: [],

      openTab: (requestId) =>
        set((state) => {
          if (state.openTabIds.includes(requestId)) {
            return { activeTabId: requestId };
          }
          return {
            openTabIds: [...state.openTabIds, requestId],
            activeTabId: requestId,
          };
        }),

      closeTab: (requestId) =>
        set((state) => {
          if (!state.openTabIds.includes(requestId)) {
            return state;
          }
          const openTabIds = state.openTabIds.filter((id) => id !== requestId);
          const recentClosed = [
            { requestId, closedAt: Date.now() },
            ...state.recentClosed.filter((entry) => entry.requestId !== requestId),
          ].slice(0, 10);
          let activeTabId = state.activeTabId;
          if (state.activeTabId === requestId) {
            activeTabId = openTabIds[openTabIds.length - 1] ?? null;
          }
          return { openTabIds, activeTabId, recentClosed };
        }),

      removeTab: (requestId) =>
        set((state) => ({
          openTabIds: state.openTabIds.filter((id) => id !== requestId),
          activeTabId: state.activeTabId === requestId ? null : state.activeTabId,
          recentClosed: state.recentClosed.filter((entry) => entry.requestId !== requestId),
        })),

      setActiveTabId: (id) => set({ activeTabId: id }),

      setDockLayout: (layout) => set({ dockLayout: layout }),

      reopenTab: (requestId) =>
        set((state) => {
          if (state.openTabIds.includes(requestId)) {
            return { activeTabId: requestId };
          }
          return {
            openTabIds: [...state.openTabIds, requestId],
            activeTabId: requestId,
            recentClosed: state.recentClosed.filter((entry) => entry.requestId !== requestId),
          };
        }),
    }),
    {
      name: "omnipanel-protocol-http-dock.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        openTabIds: state.openTabIds,
        activeTabId: state.activeTabId,
        dockLayout: state.dockLayout,
        recentClosed: state.recentClosed,
      }),
    },
  ),
);
