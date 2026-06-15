import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  sanitizeWorkspaceSession,
  type DbWorkspaceSessionSnapshot,
} from "../modules/database/dbWorkspaceSession";

const STORAGE_KEY = "omnipanel.dbWorkspaceSession.v1";

interface DbWorkspaceSessionState {
  session: DbWorkspaceSessionSnapshot | null;
  setSession: (session: DbWorkspaceSessionSnapshot | null) => void;
}

export const useDbWorkspaceSessionStore = create<DbWorkspaceSessionState>()(
  persist(
    (set) => ({
      session: null,
      setSession: (session) =>
        set({ session: session ? sanitizeWorkspaceSession(session) : null }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ session: state.session }),
      migrate: (persistedState) => {
        const persisted = persistedState as { session?: DbWorkspaceSessionSnapshot | null };
        if (persisted?.session) {
          persisted.session = sanitizeWorkspaceSession(persisted.session);
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
