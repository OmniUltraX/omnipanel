import { create } from "zustand";

export type ConnectionInfoNavSubTab = "databases" | "users" | "connections" | "status" | "cli";

interface DbConnectionInfoNavState {
  requestedSubTabByConnId: Record<string, ConnectionInfoNavSubTab>;
  requestSubTab: (connId: string, subTab: ConnectionInfoNavSubTab) => void;
  consumeSubTab: (connId: string) => ConnectionInfoNavSubTab | null;
}

export const useDbConnectionInfoNavStore = create<DbConnectionInfoNavState>((set, get) => ({
  requestedSubTabByConnId: {},

  requestSubTab: (connId, subTab) =>
    set((state) => ({
      requestedSubTabByConnId: {
        ...state.requestedSubTabByConnId,
        [connId]: subTab,
      },
    })),

  consumeSubTab: (connId) => {
    const subTab = get().requestedSubTabByConnId[connId] ?? null;
    if (!subTab) {
      return null;
    }
    set((state) => {
      const next = { ...state.requestedSubTabByConnId };
      delete next[connId];
      return { requestedSubTabByConnId: next };
    });
    return subTab;
  },
}));
