import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { normalizeHistoryCommands } from "./internalHistoryCommands";
import { invalidateSessionHistoryIndex } from "./historyIndexCache";

type SessionShellHistory = {
  commands: string[];
  syncedAt: number;
};

export const EMPTY_READLINE_HISTORY: string[] = [];

const STORAGE_KEY = "omnipanel-terminal-shell-history.v1";

interface SessionShellHistoryState {
  bySession: Record<string, SessionShellHistory>;
  setCommands: (sessionId: string, commands: string[]) => void;
  getCommands: (sessionId: string) => string[];
  getSyncedAt: (sessionId: string) => number;
}

export const useSessionShellHistoryStore = create<SessionShellHistoryState>()(
  persist(
    (set, get) => ({
      bySession: {},
      setCommands: (sessionId, commands) => {
        const normalized = normalizeHistoryCommands(commands);
        set((state) => ({
          bySession: {
            ...state.bySession,
            [sessionId]: { commands: normalized, syncedAt: Date.now() },
          },
        }));
        invalidateSessionHistoryIndex(sessionId);
      },
      getCommands: (sessionId) =>
        get().bySession[sessionId]?.commands ?? EMPTY_READLINE_HISTORY,
      getSyncedAt: (sessionId) => get().bySession[sessionId]?.syncedAt ?? 0,
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ bySession: state.bySession }),
    },
  ),
);
