import type {
  ModuleSessionService,
  SessionHandle,
  ViewSink,
} from "../runtime/types";
import { useTerminalStore } from "../../stores/terminalStore";
import {
  clearPaneBackendPending,
  disposeSessionBackend,
} from "../../hooks/useTerminal";
import { clearTerminalPaneSender } from "./terminalPaneSenders";
import { cancelAutoReconnectSsh } from "./autoReconnectTerminalSsh";
import { useTerminalHistoryStore } from "../../stores/terminalHistoryStore";
import {
  clearTerminalBackendSessionTouch,
  startTerminalBackendLifecycle,
  touchTerminalBackendSession,
} from "./terminalBackendLifecycle";

/** ViewSink 事件：P1 先传状态；字节流仍由 useTerminal 直连 PTY */
export type TerminalViewEvent =
  | { type: "bound" }
  | { type: "unbound" }
  | { type: "status"; status: string };

const RING_LIMIT = 64;

export interface TerminalSessionService extends ModuleSessionService {
  /**
   * 仅卸 View / 关 Tab：保留后端 PTY（写入 detachedRuntime）。
   * 与 dispose（真正结束会话）相对。
   */
  detachView(sessionId: string): void;
}

let singleton: TerminalSessionService | null = null;
let lifecycleStop: (() => void) | null = null;

function ensureBackendLifecycle(): void {
  if (lifecycleStop) return;
  lifecycleStop = startTerminalBackendLifecycle();
}

function resolveBackendSessionId(sessionId: string): string | null {
  const state = useTerminalStore.getState();
  const openTab = state.tabs.find((tab) => tab.sessionId === sessionId);
  return (
    openTab?.backendSessionId ??
    state.detachedRuntime[sessionId]?.backendSessionId ??
    null
  );
}

function buildTerminalSessionService(): TerminalSessionService {
  ensureBackendLifecycle();

  const sinks = new Map<string, Set<ViewSink>>();
  const rings = new Map<string, TerminalViewEvent[]>();

  const pushOrBuffer = (sessionId: string, event: TerminalViewEvent): void => {
    const bound = sinks.get(sessionId);
    if (bound && bound.size > 0) {
      for (const sink of bound) sink.push(event);
      return;
    }
    const ring = rings.get(sessionId) ?? [];
    ring.push(event);
    if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
    rings.set(sessionId, ring);
  };

  return {
    list(): SessionHandle[] {
      return useTerminalStore
        .getState()
        .sessions.filter((s) => s.lifecycle !== "ended")
        .map((s) => ({ id: s.id }));
    },

    get(id: string): SessionHandle | null {
      const session = useTerminalStore.getState().getSession(id);
      if (!session || session.lifecycle === "ended") return null;
      return { id: session.id };
    },

    bindView(id: string, sink: ViewSink): () => void {
      if (!this.get(id)) {
        return () => undefined;
      }
      let set = sinks.get(id);
      if (!set) {
        set = new Set();
        sinks.set(id, set);
      }
      set.add(sink);
      const pending = rings.get(id) ?? [];
      rings.set(id, []);
      for (const event of pending) sink.push(event);
      sink.push({ type: "bound" } satisfies TerminalViewEvent);

      return () => {
        const current = sinks.get(id);
        if (!current) return;
        current.delete(sink);
        if (current.size === 0) sinks.delete(id);
        sink.push({ type: "unbound" } satisfies TerminalViewEvent);
      };
    },

    async dispose(id: string): Promise<void> {
      cancelAutoReconnectSsh(id);
      clearTerminalPaneSender(id);
      clearPaneBackendPending(id);
      clearTerminalBackendSessionTouch(id);
      sinks.delete(id);
      rings.delete(id);

      const backendSessionId = resolveBackendSessionId(id);
      useTerminalStore.getState().endSession(id);
      disposeSessionBackend(id, backendSessionId);
      void useTerminalHistoryStore.getState().clearSession(id);
      void import("./tmuxPaneSessionIndex").then(({ useTmuxPaneSessionIndex }) => {
        useTmuxPaneSessionIndex.getState().removeBySessionId(id);
      });
    },

    detachView(sessionId: string): void {
      clearTerminalPaneSender(sessionId);
      clearPaneBackendPending(sessionId);
      touchTerminalBackendSession(sessionId);
      useTerminalStore.getState().closeTabOnly(sessionId);
      pushOrBuffer(sessionId, { type: "unbound" });
    },

    /** LRU 踢掉终端模块 View 时：保留全部 Session / PTY */
    onModuleEvicted(): void {
      // no-op：会话真相在 terminalStore + 后端；View 可再 bind
    },
  };
}

/** 单例：生命周期定时器不随 TerminalPanel 卸载而停止 */
export function createTerminalSessionService(): TerminalSessionService {
  if (!singleton) {
    singleton = buildTerminalSessionService();
  }
  return singleton;
}

export function getTerminalSessionService(): TerminalSessionService {
  return createTerminalSessionService();
}

/** 单测重置 */
export function resetTerminalSessionServiceForTests(): void {
  singleton = null;
  if (lifecycleStop) {
    lifecycleStop();
    lifecycleStop = null;
  }
}
