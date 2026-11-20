import { useEffect } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { commands, type PoolStatusEvent } from "../ipc/bindings";
import type { StatusDotStatus } from "../components/ui/primitives/StatusDot";
import { useHostOverviewPhase } from "./sshHostStore";
import { useSshPoolSessionStore } from "./sshPoolSessionStore";
import { useTerminalStore, type TerminalPane } from "./terminalStore";

type PoolSessionEvent = {
  resourceId: string;
  active: boolean;
};

type SshConnectionState = {
  statusMap: Record<string, PoolStatusEvent>;
  sessionActiveMap: Record<string, boolean>;
  setStatus: (ev: PoolStatusEvent) => void;
  hydrateStatuses: (events: PoolStatusEvent[]) => void;
  setSessionActive: (resourceId: string, active: boolean) => void;
  hydrateActiveSessions: (resourceIds: string[]) => void;
};

function statusEventUnchanged(prev: PoolStatusEvent | undefined, next: PoolStatusEvent): boolean {
  return (
    prev != null &&
    prev.status === next.status &&
    (prev.error ?? null) === (next.error ?? null)
  );
}

export const useSshConnectionStore = create<SshConnectionState>((set) => ({
  statusMap: {},
  sessionActiveMap: {},
  setStatus: (ev) =>
    set((state) => {
      if (statusEventUnchanged(state.statusMap[ev.resourceId], ev)) {
        return state;
      }
      return {
        statusMap: { ...state.statusMap, [ev.resourceId]: ev },
      };
    }),
  hydrateStatuses: (events) =>
    set((state) => {
      let changed = false;
      const next = { ...state.statusMap };
      for (const ev of events) {
        if (statusEventUnchanged(next[ev.resourceId], ev)) {
          continue;
        }
        changed = true;
        next[ev.resourceId] = ev;
      }
      return changed ? { statusMap: next } : state;
    }),
  setSessionActive: (resourceId, active) =>
    set((state) => {
      const sessionActiveMap = { ...state.sessionActiveMap };
      if (active) {
        sessionActiveMap[resourceId] = true;
      } else {
        delete sessionActiveMap[resourceId];
      }
      return { sessionActiveMap };
    }),
  hydrateActiveSessions: (resourceIds) =>
    set(() => {
      const sessionActiveMap: Record<string, boolean> = {};
      for (const id of resourceIds) {
        sessionActiveMap[id] = true;
      }
      return { sessionActiveMap };
    }),
}));

let statusSnapshotLoaded = false;
let sessionSnapshotLoaded = false;

export async function loadSshPoolStatuses() {
  if (statusSnapshotLoaded) return;
  try {
    const res = await commands.sshPoolGetStatuses();
    if (res.status === "ok") {
      useSshConnectionStore.getState().hydrateStatuses(res.data);
      statusSnapshotLoaded = true;
    }
  } catch {
    // Tauri 未就绪时忽略
  }
}

export async function loadSshPoolActiveSessions() {
  if (sessionSnapshotLoaded) return;
  try {
    const res = await commands.sshPoolGetActiveSessions();
    if (res.status === "ok") {
      useSshConnectionStore.getState().hydrateActiveSessions(res.data);
      sessionSnapshotLoaded = true;
    }
  } catch {
    // Tauri 未就绪时忽略
  }
}

let listening = false;

/** 健康检查会短时间连发多主机状态；合并到同一 microtask 再 hydrate，降低侧栏重渲染次数。 */
let pendingStatusEvents: PoolStatusEvent[] = [];
let statusFlushScheduled = false;

function queueStatusEvent(ev: PoolStatusEvent) {
  pendingStatusEvents.push(ev);
  if (statusFlushScheduled) return;
  statusFlushScheduled = true;
  queueMicrotask(() => {
    statusFlushScheduled = false;
    const batch = pendingStatusEvents;
    pendingStatusEvents = [];
    if (batch.length === 0) return;
    if (batch.length === 1) {
      useSshConnectionStore.getState().setStatus(batch[0]);
      return;
    }
    useSshConnectionStore.getState().hydrateStatuses(batch);
  });
}

function ensureListener() {
  if (listening) return;
  listening = true;
  listen<PoolStatusEvent>("ssh-pool-status", (ev) => {
    queueStatusEvent(ev.payload);
  }).catch(() => {
    listening = false;
  });
  listen<PoolSessionEvent>("ssh-pool-session", (ev) => {
    useSshConnectionStore.getState().setSessionActive(ev.payload.resourceId, ev.payload.active);
  }).catch(() => {});
}

if (typeof window !== "undefined") {
  ensureListener();
  void loadSshPoolStatuses();
  void loadSshPoolActiveSessions();
}

function remoteRuntimesForHost(
  resourceId: string,
  embeddedPanes: Record<string, TerminalPane>,
  tabs: ReturnType<typeof useTerminalStore.getState>["tabs"],
): Array<{ status: TerminalPane["status"]; backendSessionId: string | null }> {
  const runtimes: Array<{ status: TerminalPane["status"]; backendSessionId: string | null }> = [];
  for (const pane of Object.values(embeddedPanes)) {
    if (pane.resourceId === resourceId && pane.type === "remote") {
      runtimes.push({ status: pane.status, backendSessionId: pane.backendSessionId });
    }
  }
  for (const tab of tabs) {
    if (tab.session.resourceId === resourceId && tab.session.type === "remote") {
      runtimes.push({ status: tab.status, backendSessionId: tab.backendSessionId });
    }
  }
  return runtimes;
}

/**
 * 侧栏/详情状态点。
 * 绿色只表示这个页面里真有一条终端会话，或当前界面正握着这条主机的连接池会话。
 * 刷新后池里残留的会话不再把整列主机点亮。
 */
export function useHostConnectionIndicatorStatus(
  resourceId: string | null,
): "online" | "connecting" | "offline" | "unknown" {
  const embeddedPanes = useTerminalStore((s) => s.embeddedPanes);
  const tabs = useTerminalStore((s) => s.tabs);
  const sessionActiveMap = useSshConnectionStore((s) => s.sessionActiveMap);
  const poolHeld = useSshPoolSessionStore((s) =>
    resourceId ? (s.refs[resourceId] ?? 0) > 0 : false,
  );
  const overviewPhase = useHostOverviewPhase(resourceId);

  if (!resourceId) return "unknown";

  const runtimes = remoteRuntimesForHost(resourceId, embeddedPanes, tabs);
  if (runtimes.some((item) => item.status === "connected" && item.backendSessionId)) return "online";
  if (poolHeld && sessionActiveMap[resourceId]) return "online";
  if (runtimes.some((item) => item.status === "connecting")) return "connecting";
  if (overviewPhase === "loading") return "connecting";
  return "offline";
}

/** TCP 端口可达性（供 tooltip 等次要信息，不用于状态点颜色）。 */
export function useHostReachabilityStatus(
  resourceId: string | null,
): "online" | "connecting" | "offline" | "unknown" {
  const statusMap = useSshConnectionStore((s) => s.statusMap);
  useEffect(() => {
    ensureListener();
  }, []);

  if (!resourceId) return "unknown";
  const entry = statusMap[resourceId];
  if (!entry) return "unknown";
  if (entry.status === "connected") return "online";
  if (entry.status === "connecting") return "connecting";
  if (
    entry.status === "error" ||
    entry.status === "disconnected" ||
    entry.status === "idle"
  ) {
    return "offline";
  }
  return "unknown";
}

/** 获取状态点的通用状态（StatusDot）；SSH 离线为中性灰（idle）而非红色错误 */
export function hostStatusDotStatus(
  status: "online" | "connecting" | "offline" | "unknown",
): StatusDotStatus {
  if (status === "online") return "online";
  if (status === "connecting") return "connecting";
  if (status === "offline") return "idle";
  return "unknown";
}
