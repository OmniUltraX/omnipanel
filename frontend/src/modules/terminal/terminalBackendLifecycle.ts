import { disposeTabBackendSessions } from "../../hooks/useTerminal";
import { useTerminalStore } from "../../stores/terminalStore";

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const MAX_DETACHED_SESSIONS = 12;

const lastTouchedAt = new Map<string, number>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function touchTerminalBackendSession(sessionId: string): void {
  lastTouchedAt.set(sessionId, Date.now());
}

export function clearTerminalBackendSessionTouch(sessionId: string): void {
  lastTouchedAt.delete(sessionId);
}

export function disposeDetachedBackend(sessionId: string): void {
  disposeTabBackendSessions(sessionId);
  clearTerminalBackendSessionTouch(sessionId);
  const state = useTerminalStore.getState();
  const { [sessionId]: _removed, ...rest } = state.detachedRuntime;
  if (_removed) {
    useTerminalStore.setState({ detachedRuntime: rest });
  }
}

function sweepDetachedBackends(ttlMs: number): void {
  const state = useTerminalStore.getState();
  const now = Date.now();
  const detachedIds = Object.keys(state.detachedRuntime);
  if (detachedIds.length === 0) return;

  const sorted = detachedIds
    .map((id) => ({ id, touched: lastTouchedAt.get(id) ?? 0 }))
    .sort((a, b) => a.touched - b.touched);

  for (const entry of sorted) {
    const runtime = state.detachedRuntime[entry.id];
    if (!runtime?.backendSessionId) continue;
    const idleFor = now - (entry.touched || 0);
    const overCapacity = detachedIds.length > MAX_DETACHED_SESSIONS;
    if (idleFor > ttlMs || overCapacity) {
      disposeDetachedBackend(entry.id);
      detachedIds.splice(detachedIds.indexOf(entry.id), 1);
    }
  }
}

export function startTerminalBackendLifecycle(
  ttlMs = DEFAULT_IDLE_TTL_MS,
): () => void {
  if (sweepTimer) return () => undefined;
  sweepTimer = setInterval(() => sweepDetachedBackends(ttlMs), 60_000);
  return () => {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  };
}

export function disposeAllDetachedBackends(): void {
  const state = useTerminalStore.getState();
  for (const sessionId of Object.keys(state.detachedRuntime)) {
    disposeDetachedBackend(sessionId);
  }
}
