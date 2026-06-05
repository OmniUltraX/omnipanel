import { create } from "zustand";
import { persist } from "zustand/middleware";

interface GroupServerTabs {
  openServerIds: string[];
  activeServerId: string | null;
}

const emptyGroupTabs = (): GroupServerTabs => ({
  openServerIds: [],
  activeServerId: null,
});

interface ServerTabState {
  byGroup: Record<string, GroupServerTabs>;
  getTabs: (groupId: string) => GroupServerTabs;
  openServer: (groupId: string, serverId: string) => void;
  setActiveServer: (groupId: string, serverId: string) => void;
  closeServer: (groupId: string, serverId: string) => void;
  pruneServers: (groupId: string, validServerIds: string[]) => void;
}

export const useServerTabStore = create<ServerTabState>()(
  persist(
    (set, get) => ({
      byGroup: {},
      getTabs: (groupId) => get().byGroup[groupId] ?? emptyGroupTabs(),
      openServer: (groupId, serverId) =>
        set((state) => {
          const current = state.byGroup[groupId] ?? emptyGroupTabs();
          const openServerIds = current.openServerIds.includes(serverId)
            ? current.openServerIds
            : [...current.openServerIds, serverId];
          return {
            byGroup: {
              ...state.byGroup,
              [groupId]: { openServerIds, activeServerId: serverId },
            },
          };
        }),
      setActiveServer: (groupId, serverId) =>
        set((state) => {
          const current = state.byGroup[groupId] ?? emptyGroupTabs();
          if (!current.openServerIds.includes(serverId)) return state;
          return {
            byGroup: {
              ...state.byGroup,
              [groupId]: { ...current, activeServerId: serverId },
            },
          };
        }),
      closeServer: (groupId, serverId) =>
        set((state) => {
          const current = state.byGroup[groupId] ?? emptyGroupTabs();
          if (!current.openServerIds.includes(serverId)) return state;

          const closedIndex = current.openServerIds.indexOf(serverId);
          const openServerIds = current.openServerIds.filter((id) => id !== serverId);
          let activeServerId = current.activeServerId;

          if (activeServerId === serverId) {
            activeServerId =
              openServerIds[closedIndex] ??
              openServerIds[closedIndex - 1] ??
              openServerIds[0] ??
              null;
          }

          return {
            byGroup: {
              ...state.byGroup,
              [groupId]: { openServerIds, activeServerId },
            },
          };
        }),
      pruneServers: (groupId, validServerIds) =>
        set((state) => {
          const current = state.byGroup[groupId] ?? emptyGroupTabs();
          const valid = new Set(validServerIds);
          const openServerIds = current.openServerIds.filter((id) => valid.has(id));
          const activeServerId =
            current.activeServerId && valid.has(current.activeServerId)
              ? current.activeServerId
              : (openServerIds[0] ?? null);
          return {
            byGroup: {
              ...state.byGroup,
              [groupId]: { openServerIds, activeServerId },
            },
          };
        }),
    }),
    {
      name: "omnipanel-server-tabs",
      partialize: (state) => ({ byGroup: state.byGroup }),
    },
  ),
);
