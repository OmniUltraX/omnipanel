import { create } from "zustand";

function newId(): string {
  return crypto.randomUUID();
}

export type ShellAgentPhase =
  | "idle"
  | "streaming"
  | "awaiting_approval"
  | "awaiting_user_input"
  | "executing"
  | "observing"
  | "cancelled";

export type ShellAgentSession = {
  sessionId: string;
  agentThreadId: string;
  blockId: string | null;
  phase: ShellAgentPhase;
  /** 直通询问卡当前 formId（omni_ask_user） */
  pendingAskFormId: string | null;
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
  setPendingAskFormId: (sessionId: string, formId: string | null) => void;
  bumpTurn: (sessionId: string) => void;
  /** 开新会话：新 thread，清 block，保留 PTY */
  newAgentThread: (sessionId: string) => ShellAgentSession;
  cancel: (sessionId: string) => void;
  clear: (sessionId: string) => void;
  isBusy: (sessionId: string) => boolean;
};

/**
 * 直通 Shell Agent 是否正绑着这张 AI 卡片。
 * 命令栏内联也会走同一套 PTY 执行，但不会 setBlockId；
 * 若仅看 isBusy，第一次 omni_terminal_exec 的 notifyShellAgentExecuting
 * 会污染 store，导致第二次工具误等确认卡而永远卡住。
 */
export function isLiveShellAgentForBlock(
  sessionId: string,
  blockId: string,
): boolean {
  const agent = useShellAgentStore.getState().get(sessionId);
  if (!agent) return false;
  if (agent.phase === "idle" || agent.phase === "cancelled") return false;
  return Boolean(agent.blockId) && agent.blockId === blockId;
}

const DEFAULT_MAX_TURNS = 24;

function freshSession(sessionId: string): ShellAgentSession {
  return {
    sessionId,
    agentThreadId: newId(),
    blockId: null,
    phase: "idle",
    pendingAskFormId: null,
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

  setPendingAskFormId: (sessionId, formId) => {
    set((s) => {
      const cur = s.bySession[sessionId] ?? freshSession(sessionId);
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: { ...cur, pendingAskFormId: formId },
        },
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
          [sessionId]: {
            ...cur,
            phase: "cancelled",
            blockId: null,
            pendingAskFormId: null,
          },
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
      cur.phase === "awaiting_user_input" ||
      cur.phase === "executing" ||
      cur.phase === "observing"
    );
  },
}));
