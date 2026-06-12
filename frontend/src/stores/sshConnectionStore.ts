import { useEffect } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { commands, type PoolStatusEvent } from "../ipc/bindings";
import { useHostOverviewPhase } from "./sshHostStore";
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

export const useSshConnectionStore = create<SshConnectionState>((set) => ({
  statusMap: {},
  sessionActiveMap: {},
  setStatus: (ev) =>
    set((state) => ({
      statusMap: { ...state.statusMap, [ev.resourceId]: ev },
    })),
  hydrateStatuses: (events) =>
    set((state) => {
      const next = { ...state.statusMap };
      for (const ev of events) {
        next[ev.resourceId] = ev;
      }
      return { statusMap: next };
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
function ensureListener() {
  if (listening) return;
  listening = true;
  listen<PoolStatusEvent>("ssh-pool-status", (ev) => {
    useSshConnectionStore.getState().setStatus(ev.payload);
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

function remotePaneStatusesForHost(
  resourceId: string,
  embeddedPanes: Record<string, TerminalPane>,
  tabs: ReturnType<typeof useTerminalStore.getState>["tabs"],
): TerminalPane["status"][] {
  const statuses: TerminalPane["status"][] = [];
  for (const pane of Object.values(embeddedPanes)) {
    if (pane.resourceId === resourceId && pane.type === "remote") {
      statuses.push(pane.status);
    }
  }
  for (const tab of tabs) {
    if (tab.session.resourceId === resourceId && tab.session.type === "remote") {
      statuses.push(tab.status);
    }
  }
  return statuses;
}

/** 侧栏/详情状态点：SSH 会话已建立（终端或连接池）才显示绿色。 */
export function useHostConnectionIndicatorStatus(
  resourceId: string | null,
): "online" | "connecting" | "offline" | "unknown" {
  const embeddedPanes = useTerminalStore((s) => s.embeddedPanes);
  const tabs = useTerminalStore((s) => s.tabs);
  const sessionActiveMap = useSshConnectionStore((s) => s.sessionActiveMap);
  const overviewPhase = useHostOverviewPhase(resourceId);

  if (!resourceId) return "unknown";

  const statuses = remotePaneStatusesForHost(resourceId, embeddedPanes, tabs);
  if (statuses.some((s) => s === "connected")) return "online";
  if (sessionActiveMap[resourceId]) return "online";
  if (statuses.some((s) => s === "connecting")) return "connecting";
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

/** @deprecated 使用 useHostConnectionIndicatorStatus */
export function useHostOnlineStatus(
  resourceId: string | null,
): "online" | "connecting" | "offline" | "unknown" {
  return useHostConnectionIndicatorStatus(resourceId);
}

/** 获取状态点的 CSS 类名 */
export function hostStatusDotClass(
  status: "online" | "connecting" | "offline" | "unknown",
): string {
  if (status === "online" || status === "connecting") return "host-status--online";
  if (status === "offline") return "host-status--offline";
  return "host-status--unknown";
}
