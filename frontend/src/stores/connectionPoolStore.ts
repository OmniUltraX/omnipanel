import { useEffect } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { commands, type PoolCategorySummary, type PoolSummary } from "../ipc/bindings";
import { SSH_POOL_SESSION, SSH_POOL_STATUS } from "../ipc/events";
import { useSshPoolSessionStore } from "./sshPoolSessionStore";

/** 连接池分类，与后端 `PoolCategorySummary.kind` 对齐。 */
export type PoolKind = "ssh" | "docker" | "database" | "redis" | "protocol" | "terminal" | "background";

const POOL_KINDS: PoolKind[] = ["ssh", "docker", "database", "redis", "protocol", "terminal", "background"];

const EMPTY_LOCAL: Record<PoolKind, Record<string, number>> = {
  ssh: {},
  docker: {},
  database: {},
  redis: {},
  protocol: {},
  terminal: {},
  background: {},
};

type ConnectionPoolState = {
  serverSummary: PoolSummary | null;
  localRefs: Record<PoolKind, Record<string, number>>;
  loading: boolean;
  setServerSummary: (summary: PoolSummary) => void;
};

/** 后端快照无实质变化时跳过 setState，避免 StatusBar 无意义重渲染。 */
function poolSummariesEqual(a: PoolSummary | null, b: PoolSummary): boolean {
  if (!a) return false;
  if (a.active !== b.active || a.idle !== b.idle) return false;
  if (a.categories.length !== b.categories.length) return false;
  for (let i = 0; i < a.categories.length; i += 1) {
    const left = a.categories[i];
    const right = b.categories[i];
    if (
      left.kind !== right.kind ||
      left.active !== right.active ||
      left.idle !== right.idle
    ) {
      return false;
    }
  }
  return true;
}

const useConnectionPoolStore = create<ConnectionPoolState>((set) => ({
  serverSummary: null,
  localRefs: { ...EMPTY_LOCAL },
  loading: false,
  setServerSummary: (summary) =>
    set((state) => {
      if (poolSummariesEqual(state.serverSummary, summary)) {
        return state.loading ? { loading: false } : state;
      }
      return { serverSummary: summary, loading: false };
    }),
}));

function sumLocalRefs(refs: Record<string, number>): number {
  return Object.values(refs).reduce((acc, n) => acc + (n > 0 ? 1 : 0), 0);
}

/** 合并后端快照与前端模块注册的活跃占用。 */
export function getMergedPoolSummary(): PoolSummary {
  const { serverSummary, localRefs } = useConnectionPoolStore.getState();
  const base: PoolCategorySummary[] =
    serverSummary?.categories ??
    POOL_KINDS.map((kind) => ({ kind, active: 0, idle: 0 }));

  const sshHeld = sumLocalRefs(localRefs.ssh);
  const sshPoolRefs = useSshPoolSessionStore.getState().refs;
  const sshFrontendHeld = Object.values(sshPoolRefs).filter((n) => n > 0).length;

  const categories = base.map((cat) => {
    let active = cat.active;
    let idle = cat.idle;

    if (cat.kind === "ssh") {
      const held = Math.max(sshHeld, sshFrontendHeld);
      active += held;
      idle = Math.max(0, idle - held);
    } else if (cat.kind === "docker" || cat.kind === "database" || cat.kind === "redis") {
      const held = sumLocalRefs(localRefs[cat.kind as PoolKind] ?? {});
      active += held;
      idle = Math.max(0, idle - held);
    } else if (cat.kind === "protocol" || cat.kind === "terminal") {
      const held = sumLocalRefs(localRefs[cat.kind as PoolKind] ?? {});
      active += held;
    }

    return { ...cat, active, idle };
  });

  const active = categories.reduce((acc, c) => acc + c.active, 0);
  const idle = categories.reduce((acc, c) => acc + c.idle, 0);
  return { active, idle, categories };
}

export function useMergedPoolSummary(): PoolSummary {
  const serverSummary = useConnectionPoolStore((s) => s.serverSummary);
  const localRefs = useConnectionPoolStore((s) => s.localRefs);
  const sshRefs = useSshPoolSessionStore((s) => s.refs);
  void serverSummary;
  void localRefs;
  void sshRefs;
  return getMergedPoolSummary();
}

function bumpLocalRef(kind: PoolKind, id: string, delta: number) {
  useConnectionPoolStore.setState((state) => {
    const bucket = { ...state.localRefs[kind] };
    const next = (bucket[id] ?? 0) + delta;
    if (next <= 0) {
      delete bucket[id];
    } else {
      bucket[id] = next;
    }
    return {
      localRefs: {
        ...state.localRefs,
        [kind]: bucket,
      },
    };
  });
}

/** 模块占用连接（查询中、面板打开等），释放时需配对调用。 */
export function acquirePoolConnection(kind: PoolKind, id: string) {
  if (!id) return;
  bumpLocalRef(kind, id, 1);
}

export function releasePoolConnection(kind: PoolKind, id: string) {
  if (!id) return;
  bumpLocalRef(kind, id, -1);
}

export async function refreshConnectionPool() {
  try {
    const res = await commands.poolGetSummary();
    if (res.status === "ok") {
      useConnectionPoolStore.getState().setServerSummary(res.data);
    }
  } catch {
    // Tauri 未就绪时忽略
  }
}

let poolInitialized = false;

/** SSH 池状态/会话事件常在健康检查时连发，合并后再刷连接池摘要。 */
const POOL_EVENT_DEBOUNCE_MS = 400;
let eventRefreshTimer: number | null = null;

function schedulePoolRefreshFromEvent() {
  if (eventRefreshTimer != null) {
    window.clearTimeout(eventRefreshTimer);
  }
  eventRefreshTimer = window.setTimeout(() => {
    eventRefreshTimer = null;
    void refreshConnectionPool();
  }, POOL_EVENT_DEBOUNCE_MS);
}

/** 启动轮询与事件监听，在 Bootstrap 中调用一次。 */
export function initConnectionPool() {
  if (poolInitialized) return;
  poolInitialized = true;

  void refreshConnectionPool();

  const timer = window.setInterval(() => {
    void refreshConnectionPool();
  }, 5000);

  const unsubs: Array<() => void> = [];
  const onPoolChange = () => {
    schedulePoolRefreshFromEvent();
  };

  listen(SSH_POOL_SESSION, onPoolChange).then((fn) => unsubs.push(fn)).catch(() => {});
  listen(SSH_POOL_STATUS, onPoolChange).then((fn) => unsubs.push(fn)).catch(() => {});

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      window.clearInterval(timer);
      if (eventRefreshTimer != null) {
        window.clearTimeout(eventRefreshTimer);
        eventRefreshTimer = null;
      }
      for (const fn of unsubs) fn();
    });
  }
}

export function poolKindLabelKey(kind: string): string {
  return `shell.connectionPool.kind.${kind}`;
}

/** 在组件内注册当前占用的连接，卸载时自动释放。 */
export function usePoolConnectionRegistration(kind: PoolKind, id: string | null | undefined) {
  useEffect(() => {
    if (!id) return;
    acquirePoolConnection(kind, id);
    return () => releasePoolConnection(kind, id);
  }, [kind, id]);
}
