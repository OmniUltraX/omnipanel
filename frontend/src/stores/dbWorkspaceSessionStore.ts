import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  DB_RECENT_CLOSED_PANEL_LIMIT,
  sanitizeWorkspaceSession,
  type DbClosedPanelEntry,
  type DbWorkspaceSessionSnapshot,
} from "../modules/database/dbWorkspaceSession";

const STORAGE_KEY = "omnipanel.dbWorkspaceSession.v1";

interface DbWorkspaceSessionState {
  session: DbWorkspaceSessionSnapshot | null;
  recentClosedPanels: DbClosedPanelEntry[];
  setSession: (session: DbWorkspaceSessionSnapshot | null) => void;
  pushRecentClosedPanel: (entry: DbClosedPanelEntry) => void;
  removeRecentClosedPanel: (closedAt: number) => void;
}

export const useDbWorkspaceSessionStore = create<DbWorkspaceSessionState>()(
  persist(
    (set) => ({
      session: null,
      recentClosedPanels: [],
      setSession: (session) =>
        set({ session: session ? sanitizeWorkspaceSession(session) : null }),
      pushRecentClosedPanel: (entry) =>
        set((state) => {
          const filtered = state.recentClosedPanels.filter(
            (item) => item.tab.id !== entry.tab.id,
          );
          const next = [entry, ...filtered]
            .sort((a, b) => b.closedAt - a.closedAt)
            .slice(0, DB_RECENT_CLOSED_PANEL_LIMIT);
          return { recentClosedPanels: next };
        }),
      removeRecentClosedPanel: (closedAt) =>
        set((state) => ({
          recentClosedPanels: state.recentClosedPanels.filter(
            (item) => item.closedAt !== closedAt,
          ),
        })),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        session: state.session,
        recentClosedPanels: state.recentClosedPanels,
      }),
      migrate: (persistedState) => {
        const persisted = persistedState as {
          session?: DbWorkspaceSessionSnapshot | null;
          recentClosedPanels?: DbClosedPanelEntry[];
        };
        if (persisted?.session) {
          persisted.session = sanitizeWorkspaceSession(persisted.session);
        }
        if (!Array.isArray(persisted.recentClosedPanels)) {
          persisted.recentClosedPanels = [];
        } else {
          persisted.recentClosedPanels = [...persisted.recentClosedPanels]
            .sort((a, b) => b.closedAt - a.closedAt)
            .slice(0, DB_RECENT_CLOSED_PANEL_LIMIT);
        }
        return persisted as DbWorkspaceSessionState;
      },
    },
  ),
);

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function schedulePersistWorkspaceSession(snapshot: DbWorkspaceSessionSnapshot | null): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    useDbWorkspaceSessionStore.getState().setSession(snapshot);
  }, 400);
}
