import { create } from "zustand";

/**
 * 远程终端的传输模式。
 *
 * - `tmux`：经远端 tmux control mode，同主机多个 Tab 复用一条 SSH 连接，
 *   且会话在应用退出后仍存活，重开可续上。
 * - `direct`：一个 Tab 一条 SSH 连接的直连 shell。远端没有可用 tmux 时自动降级，
 *   用户也可手动切到该模式。
 */
export type TerminalTransportMode = "tmux" | "direct";

export interface TerminalTransportInfo {
  mode: TerminalTransportMode;
  /** `user@host:port`，同一主机的 Tab 共用一条 tmux 连接。 */
  host: string;
  tmuxVersion: string | null;
  tmuxSession: string | null;
  /** tmux pane id（数值），用于重连时 attach 回原 window 恢复进程与历史。 */
  tmuxPaneId: number | null;
  /** 降级到直连的原因，`tmux` 模式下为 null。 */
  fallbackReason: string | null;
}

interface TerminalTransportState {
  /** 前端会话 id → 传输信息。只有远程 SSH 会话有值。 */
  transports: Record<string, TerminalTransportInfo>;
  getTransport: (sessionId: string) => TerminalTransportInfo | undefined;
  setTransport: (sessionId: string, info: TerminalTransportInfo) => void;
  clearTransport: (sessionId: string) => void;
  clearAll: () => void;
}

export const useTerminalTransportStore = create<TerminalTransportState>((set, get) => ({
  transports: {},

  getTransport: (sessionId) => get().transports[sessionId],

  setTransport: (sessionId, info) =>
    set((state) => {
      const prev = state.transports[sessionId];
      if (
        prev &&
        prev.mode === info.mode &&
        prev.host === info.host &&
        prev.tmuxVersion === info.tmuxVersion &&
        prev.tmuxSession === info.tmuxSession &&
        prev.tmuxPaneId === info.tmuxPaneId &&
        prev.fallbackReason === info.fallbackReason
      ) {
        return state;
      }
      return { transports: { ...state.transports, [sessionId]: info } };
    }),

  clearTransport: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.transports)) return state;
      const next = { ...state.transports };
      delete next[sessionId];
      return { transports: next };
    }),

  clearAll: () => set({ transports: {} }),
}));

/** 重置传输模式状态，仅供测试在 beforeEach 中调用。 */
export function resetTerminalTransportStore(): void {
  useTerminalTransportStore.getState().clearAll();
}
