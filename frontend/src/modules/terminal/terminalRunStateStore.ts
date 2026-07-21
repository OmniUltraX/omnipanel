import { create } from "zustand";

/** 终端运行态：Command Bar / Block Feed / 全屏 xterm 的统一生命周期。 */
export type TerminalRunState =
  | "prompt"
  | "block-running"
  | "ai-tool-running"
  | "inline-running"
  | "full-terminal"
  | "recovering";

export interface TerminalRunSessionMeta {
  state: TerminalRunState;
  activeBlockId?: string;
  command?: string;
  /** AI 工具静默采集时不抢占 live xterm */
  captureMode?: "user" | "ai";
  since: number;
}

export const FULL_TERMINAL_BLOCK_SUMMARY = "[交互式终端会话]";

const LIVE_XTERM_STATES: ReadonlySet<TerminalRunState> = new Set([
  "block-running",
  "inline-running",
  "full-terminal",
]);

const ACTIVE_RUN_STATES: ReadonlySet<TerminalRunState> = new Set([
  "block-running",
  "ai-tool-running",
  "inline-running",
  "full-terminal",
]);

/** Command Bar / Block 模式下禁止再发新命令的运行态（不含 full-terminal）。 */
const COMMAND_BAR_BUSY_STATES: ReadonlySet<TerminalRunState> = new Set([
  "block-running",
  "ai-tool-running",
  "inline-running",
]);

export function isCommandBarBusyState(state: TerminalRunState): boolean {
  return COMMAND_BAR_BUSY_STATES.has(state);
}

interface TerminalRunStateStore {
  sessions: Record<string, TerminalRunSessionMeta>;

  getRunState: (sessionId: string) => TerminalRunState;
  getSessionMeta: (sessionId: string) => TerminalRunSessionMeta;
  beginBlockRun: (
    sessionId: string,
    options: { blockId?: string; command?: string },
  ) => void;
  beginAiToolRun: (
    sessionId: string,
    options: { blockId?: string; command?: string },
  ) => void;
  promoteToInlineRun: (sessionId: string) => void;
  enterFullTerminal: (sessionId: string, blockId?: string) => void;
  enterRecovering: (sessionId: string) => void;
  returnToPrompt: (sessionId: string) => void;
  clearSession: (sessionId: string) => void;

  isCommandLive: (sessionId: string) => boolean;
  /** block/inline/ai-tool 运行中（不含 full-terminal）：应拒绝新命令。 */
  isCommandBarBusy: (sessionId: string) => boolean;
  isFullTerminal: (sessionId: string) => boolean;
  isAiToolRunning: (sessionId: string) => boolean;
  shouldCaptureBlockOutput: (sessionId: string, hasBoundBlock: boolean) => boolean;
  shouldAppendBlockOutput: (sessionId: string) => boolean;
  shouldShowLiveXterm: (sessionId: string) => boolean;
}

function defaultMeta(): TerminalRunSessionMeta {
  return { state: "prompt", since: Date.now() };
}

function patchSession(
  sessions: Record<string, TerminalRunSessionMeta>,
  sessionId: string,
  patch: Partial<TerminalRunSessionMeta> & { state: TerminalRunState },
): Record<string, TerminalRunSessionMeta> {
  const prev = sessions[sessionId] ?? defaultMeta();
  return {
    ...sessions,
    [sessionId]: {
      ...prev,
      ...patch,
      since: Date.now(),
    },
  };
}

export const useTerminalRunStateStore = create<TerminalRunStateStore>((set, get) => ({
  sessions: {},

  getRunState: (sessionId) => get().sessions[sessionId]?.state ?? "prompt",

  getSessionMeta: (sessionId) => get().sessions[sessionId] ?? defaultMeta(),

  beginBlockRun: (sessionId, options) =>
    set((state) => ({
      sessions: patchSession(state.sessions, sessionId, {
        state: "block-running",
        activeBlockId: options.blockId,
        command: options.command,
        captureMode: "user",
      }),
    })),

  beginAiToolRun: (sessionId, options) =>
    set((state) => ({
      sessions: patchSession(state.sessions, sessionId, {
        state: "ai-tool-running",
        activeBlockId: options.blockId,
        command: options.command,
        captureMode: "ai",
      }),
    })),

  promoteToInlineRun: (sessionId) => {
    const current = get().getRunState(sessionId);
    if (current !== "block-running" && current !== "ai-tool-running") return;
    set((state) => ({
      sessions: patchSession(state.sessions, sessionId, { state: "inline-running" }),
    }));
  },

  enterFullTerminal: (sessionId, blockId) =>
    set((state) => {
      const prev = state.sessions[sessionId] ?? defaultMeta();
      return {
        sessions: patchSession(state.sessions, sessionId, {
          state: "full-terminal",
          activeBlockId: blockId ?? prev.activeBlockId,
        }),
      };
    }),

  enterRecovering: (sessionId) =>
    set((state) => ({
      sessions: patchSession(state.sessions, sessionId, { state: "recovering" }),
    })),

  returnToPrompt: (sessionId) =>
    set((state) => {
      if (!state.sessions[sessionId]) return state;
      const next = { ...state.sessions };
      delete next[sessionId];
      return { sessions: next };
    }),

  clearSession: (sessionId) =>
    set((state) => {
      if (!state.sessions[sessionId]) return state;
      const next = { ...state.sessions };
      delete next[sessionId];
      return { sessions: next };
    }),

  isCommandLive: (sessionId) => ACTIVE_RUN_STATES.has(get().getRunState(sessionId)),

  isCommandBarBusy: (sessionId) =>
    isCommandBarBusyState(get().getRunState(sessionId)),

  isFullTerminal: (sessionId) => get().getRunState(sessionId) === "full-terminal",

  isAiToolRunning: (sessionId) => {
    const meta = get().sessions[sessionId];
    if (!meta || meta.captureMode !== "ai") return false;
    return meta.state === "ai-tool-running" || meta.state === "inline-running";
  },

  shouldCaptureBlockOutput: (sessionId, hasBoundBlock) => {
    if (!hasBoundBlock) return false;
    return !get().isFullTerminal(sessionId);
  },

  shouldAppendBlockOutput: (sessionId) => {
    const runState = get().getRunState(sessionId);
    return (
      runState === "block-running" ||
      runState === "ai-tool-running" ||
      runState === "inline-running"
    );
  },

  shouldShowLiveXterm: (sessionId) => {
    const meta = get().sessions[sessionId];
    if (!meta || meta.captureMode === "ai") return false;
    return LIVE_XTERM_STATES.has(meta.state);
  },
}));

/** 会话关闭 / detach 时清理运行态与关联 UI 状态。 */
export function clearTerminalSessionRuntime(sessionId: string): void {
  useTerminalRunStateStore.getState().clearSession(sessionId);
}
