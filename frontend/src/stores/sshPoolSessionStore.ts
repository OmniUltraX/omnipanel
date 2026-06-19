import { create } from "zustand";
import { commands } from "../ipc/bindings";

/** 连接池会话引用计数 + 短期保活，避免切换主机时频繁握手。 */
const releaseTimers: Record<string, ReturnType<typeof setTimeout>> = {};

/** 无引用后延迟释放会话（毫秒） */
const IDLE_RELEASE_MS = 5 * 60 * 1000;

type PoolSessionState = {
  refs: Record<string, number>;
};

export const useSshPoolSessionStore = create<PoolSessionState>(() => ({
  refs: {},
}));

function cancelPendingRelease(resourceId: string) {
  const timer = releaseTimers[resourceId];
  if (timer) {
    clearTimeout(timer);
    delete releaseTimers[resourceId];
  }
}

function setRefCount(resourceId: string, count: number) {
  useSshPoolSessionStore.setState((state) => {
    const refs = { ...state.refs };
    if (count <= 0) {
      delete refs[resourceId];
    } else {
      refs[resourceId] = count;
    }
    return { refs };
  });
}

export function acquireSshPoolSession(resourceId: string) {
  cancelPendingRelease(resourceId);
  const current = useSshPoolSessionStore.getState().refs[resourceId] ?? 0;
  setRefCount(resourceId, current + 1);
}

export function releaseSshPoolSession(resourceId: string) {
  const current = useSshPoolSessionStore.getState().refs[resourceId] ?? 1;
  const next = current - 1;
  if (next <= 0) {
    setRefCount(resourceId, 0);
    cancelPendingRelease(resourceId);
    releaseTimers[resourceId] = setTimeout(() => {
      delete releaseTimers[resourceId];
      void commands.sshPoolRelease(resourceId);
    }, IDLE_RELEASE_MS);
  } else {
    setRefCount(resourceId, next);
  }
}

/** 立即释放（删除主机等场景） */
export function forceReleaseSshPoolSession(resourceId: string) {
  cancelPendingRelease(resourceId);
  setRefCount(resourceId, 0);
  void commands.sshPoolRelease(resourceId);
}

/** 当前主机是否持有连接池会话（概览/监控等） */
export function useSshPoolSessionActive(resourceId: string | null): boolean {
  const refs = useSshPoolSessionStore((s) => s.refs);
  if (!resourceId) return false;
  return (refs[resourceId] ?? 0) > 0;
}
