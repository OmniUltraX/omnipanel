import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createIndexedDBStorage } from "../../../lib/indexedDbStorage";
import { normalizeHistoryCommands } from "./internalHistoryCommands";
import { invalidateSessionHistoryIndex } from "./historyIndexCache";

type SessionShellHistory = {
  commands: string[];
  syncedAt: number;
};

export const EMPTY_READLINE_HISTORY: string[] = [];

const STORAGE_KEY = "omnipanel-terminal-shell-history.v1";

/**
 * 单 session 保留的命令数量上限。与常见 shell HISTSIZE 默认值一致，
 * 兼顾 readline 上箭头翻历史的使用场景与持久化体积。
 * 入参顺序为新 → 老，slice(0, MAX) 即保留最近的 N 条。
 */
const MAX_COMMANDS_PER_SESSION = 2000;

/**
 * 全局保留的 session 数量上限。多 session 累积会导致持久化体积无界增长
 * （曾出现 1.88MB 单 key 撑爆 localStorage 5MB 配额）。
 * 超出时按 syncedAt 升序淘汰最老的 session。
 */
const MAX_SESSIONS = 10;

interface SessionShellHistoryState {
  bySession: Record<string, SessionShellHistory>;
  setCommands: (sessionId: string, commands: string[]) => void;
  getCommands: (sessionId: string) => string[];
  getSyncedAt: (sessionId: string) => number;
}

/** 淘汰最老的 session，保留最近 MAX_SESSIONS 个。 */
function trimSessions(
  bySession: Record<string, SessionShellHistory>,
): Record<string, SessionShellHistory> {
  const ids = Object.keys(bySession);
  if (ids.length <= MAX_SESSIONS) return bySession;
  // 按 syncedAt 升序，淘汰最老的
  const sorted = ids.sort(
    (a, b) => (bySession[a]?.syncedAt ?? 0) - (bySession[b]?.syncedAt ?? 0),
  );
  const dropCount = ids.length - MAX_SESSIONS;
  const next = { ...bySession };
  for (let i = 0; i < dropCount; i++) {
    delete next[sorted[i]];
  }
  return next;
}

export const useSessionShellHistoryStore = create<SessionShellHistoryState>()(
  persist(
    (set, get) => ({
      bySession: {},
      setCommands: (sessionId, commands) => {
        const normalized = normalizeHistoryCommands(commands);
        // 数量上限：保留最近的 N 条，避免多 session 累积导致持久化体积无界增长
        const trimmed =
          normalized.length > MAX_COMMANDS_PER_SESSION
            ? normalized.slice(0, MAX_COMMANDS_PER_SESSION)
            : normalized;
        set((state) => {
          const next = trimSessions({
            ...state.bySession,
            [sessionId]: { commands: trimmed, syncedAt: Date.now() },
          });
          return { bySession: next };
        });
        invalidateSessionHistoryIndex(sessionId);
      },
      getCommands: (sessionId) =>
        get().bySession[sessionId]?.commands ?? EMPTY_READLINE_HISTORY,
      getSyncedAt: (sessionId) => get().bySession[sessionId]?.syncedAt ?? 0,
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(createIndexedDBStorage),
      partialize: (state) => ({ bySession: state.bySession }),
    },
  ),
);
