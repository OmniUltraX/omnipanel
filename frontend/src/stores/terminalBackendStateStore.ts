import { create } from "zustand";

/**
 * 终端后端会话运行时状态。
 *
 * 这些状态不驱动 UI 渲染，仅用于跨组件/跨调用点的命令式访问：
 * - `pendingBackendSessions`：防止同一 pane 并发创建后端会话（StrictMode / 重渲染竞争）
 * - `injectedBackendSessions`：记录已注入 shell 集成钩子的后端会话 ID，避免切 Tab 时重复注入
 *
 * 通过 Zustand 集中管理，提供统一清理入口与测试重置能力，替代原先散落在
 * `useTerminal.ts` 模块顶层的全局 Map/Set。
 */
interface TerminalBackendRuntimeState {
  pendingBackendSessions: Map<string, Promise<string>>;
  injectedBackendSessions: Set<string>;

  getPendingSession: (paneId: string) => Promise<string> | undefined;
  setPendingSession: (paneId: string, promise: Promise<string>) => void;
  clearPendingSession: (paneId: string) => void;

  hasInjectedSession: (backendSid: string) => boolean;
  addInjectedSession: (backendSid: string) => void;
  removeInjectedSession: (backendSid: string) => void;

  /** 清理某个会话的 pending 创建任务（注入状态按 backendSid 维护，需单独清理） */
  clearSessionRuntime: (sessionId: string) => void;
  /** 重置全部运行时状态（主要供测试使用） */
  clearAll: () => void;
}

export const useTerminalBackendStateStore = create<TerminalBackendRuntimeState>(
  (set, get) => ({
    pendingBackendSessions: new Map(),
    injectedBackendSessions: new Set(),

    getPendingSession: (paneId) => get().pendingBackendSessions.get(paneId),

    setPendingSession: (paneId, promise) =>
      set((state) => {
        const next = new Map(state.pendingBackendSessions);
        next.set(paneId, promise);
        return { pendingBackendSessions: next };
      }),

    clearPendingSession: (paneId) =>
      set((state) => {
        if (!state.pendingBackendSessions.has(paneId)) return state;
        const next = new Map(state.pendingBackendSessions);
        next.delete(paneId);
        return { pendingBackendSessions: next };
      }),

    hasInjectedSession: (backendSid) => get().injectedBackendSessions.has(backendSid),

    addInjectedSession: (backendSid) =>
      set((state) => {
        if (state.injectedBackendSessions.has(backendSid)) return state;
        const next = new Set(state.injectedBackendSessions);
        next.add(backendSid);
        return { injectedBackendSessions: next };
      }),

    removeInjectedSession: (backendSid) =>
      set((state) => {
        if (!state.injectedBackendSessions.has(backendSid)) return state;
        const next = new Set(state.injectedBackendSessions);
        next.delete(backendSid);
        return { injectedBackendSessions: next };
      }),

    clearSessionRuntime: (sessionId) =>
      set((state) => {
        if (!state.pendingBackendSessions.has(sessionId)) return state;
        const next = new Map(state.pendingBackendSessions);
        next.delete(sessionId);
        return { pendingBackendSessions: next };
      }),

    clearAll: () =>
      set({
        pendingBackendSessions: new Map(),
        injectedBackendSessions: new Set(),
      }),
  }),
);

/** 重置终端后端运行时状态，仅供测试在 beforeEach 中调用。 */
export function resetTerminalBackendStateStore(): void {
  useTerminalBackendStateStore.getState().clearAll();
}
