import { create } from "zustand";

function newId(): string {
  return crypto.randomUUID();
}

export type ShellAgentPhase =
  | "idle"
  | "streaming"
  | "awaiting_approval"
  | "executing"
  | "observing"
  | "cancelled";

export type ShellAgentSession = {
  sessionId: string;
  agentThreadId: string;
  blockId: string | null;
  phase: ShellAgentPhase;
  turn: number;
  maxTurns: number;
  startedAt: number;
};

type ShellAgentStore = {
  bySession: Record<string, ShellAgentSession>;
  get: (sessionId: string) => ShellAgentSession | null;
  ensure: (sessionId: string) => ShellAgentSession;
  setPhase: (sessionId: string, phase: ShellAgentPhase) => void;
  setBlockId: (sessionId: string, blockId: string | null) => void;
  bumpTurn: (sessionId: string) => void;
  /** 开新会话：新 thread，清 block，保留 PTY */
  newAgentThread: (sessionId: string) => ShellAgentSession;
  cancel: (sessionId: string) => void;
  clear: (sessionId: string) => void;
  isBusy: (sessionId: string) => boolean;
};

const DEFAULT_MAX_TURNS = 24;

function freshSession(sessionId: string): ShellAgentSession {
  return {
    sessionId,
    agentThreadId: newId(),
    blockId: null,
    phase: "idle",
    turn: 0,
    maxTurns: DEFAULT_MAX_TURNS,
    startedAt: Date.now(),
  };
}

export const useShellAgentStore = create<ShellAgentStore>((set, get) => ({
  bySession: {},

  get: (sessionId) => get().bySession[sessionId] ?? null,

  ensure: (sessionId) => {
    const existing = get().bySession[sessionId];
    if (existing) return existing;
    const created = freshSession(sessionId);
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: created } }));
    return created;
  },

  setPhase: (sessionId, phase) => {
    set((s) => {
      const cur = s.bySession[sessionId] ?? freshSession(sessionId);
      return {
        bySession: { ...s.bySession, [sessionId]: { ...cur, phase } },
      };
    });
  },

  setBlockId: (sessionId, blockId) => {
    set((s) => {
      const cur = s.bySession[sessionId] ?? freshSession(sessionId);
      return {
        bySession: { ...s.bySession, [sessionId]: { ...cur, blockId } },
      };
    });
  },

  bumpTurn: (sessionId) => {
    set((s) => {
      const cur = s.bySession[sessionId] ?? freshSession(sessionId);
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: { ...cur, turn: cur.turn + 1 },
        },
      };
    });
  },

  newAgentThread: (sessionId) => {
    const created = freshSession(sessionId);
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: created } }));
    return created;
  },

  cancel: (sessionId) => {
    set((s) => {
      const cur = s.bySession[sessionId];
      if (!cur) return s;
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: { ...cur, phase: "cancelled", blockId: null },
        },
      };
    });
  },

  clear: (sessionId) => {
    set((s) => {
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    });
  },

  isBusy: (sessionId) => {
    const cur = get().bySession[sessionId];
    if (!cur) return false;
    return (
      cur.phase === "streaming" ||
      cur.phase === "awaiting_approval" ||
      cur.phase === "executing" ||
      cur.phase === "observing"
    );
  },
}));
