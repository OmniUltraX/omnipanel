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
          persisted.session = sanitizeWorkspaceSession({
            ...persisted.session,
            tablePreviewStates: persisted.session.tablePreviewStates ?? {},
            tableDesignerStates: persisted.session.tableDesignerStates ?? {},
          });
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
let pendingSnapshot: DbWorkspaceSessionSnapshot | null | undefined;

export function schedulePersistWorkspaceSession(snapshot: DbWorkspaceSessionSnapshot | null): void {
  pendingSnapshot = snapshot;
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    useDbWorkspaceSessionStore.getState().setSession(snapshot);
    pendingSnapshot = undefined;
  }, 400);
}

/** 应用退出前立即写入待持久化的会话，避免 debounce 导致表预览元数据丢失。 */
export function flushPersistWorkspaceSession(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (pendingSnapshot !== undefined) {
    useDbWorkspaceSessionStore.getState().setSession(pendingSnapshot);
    pendingSnapshot = undefined;
  }
}
