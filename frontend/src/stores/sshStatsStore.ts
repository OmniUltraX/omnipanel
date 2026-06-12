import { useEffect } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { useTerminalStore } from "./terminalStore";

export type MemoryStats = {
  total: number | null;
  used: number | null;
  available: number | null;
};

export type DiskStats = {
  total: number | null;
  used: number | null;
  available: number | null;
};

export type NetworkStats = {
  rxBytes: number | null;
  txBytes: number | null;
};

export type HostSystemStats = {
  hostId: string;
  hostName: string;
  load: string;
  cpuCores: number;
  cpuUsage: number | null;
  memory: MemoryStats;
  disk: DiskStats;
  network: NetworkStats;
  osInfo: string;
  timestamp: number | null;
};

type SshStatsState = {
  statsMap: Record<string, HostSystemStats>;
  setStats: (stats: HostSystemStats[]) => void;
  getStats: (hostId: string) => HostSystemStats | null;
};

export const useSshStatsStore = create<SshStatsState>((set, get) => ({
  statsMap: {},
  setStats: (stats: HostSystemStats[]) => {
    const map: Record<string, HostSystemStats> = {};
    for (const s of stats) {
      map[s.hostId] = s;
    }
    set((state) => ({
      statsMap: { ...state.statsMap, ...map },
    }));
  },
  getStats: (hostId: string) => get().statsMap[hostId] ?? null,
}));

/** Backend emits stats keyed by SSH session ID ("ssh-1").  The frontend
 *  looks up by resource (connection) ID.  Bridge the two via the terminal
 *  store's pane data. */
function findBackendSessionId(resourceId: string): string | null {
  const state = useTerminalStore.getState();
  for (const pane of Object.values(state.embeddedPanes)) {
    if (pane.resourceId === resourceId && pane.backendSessionId) {
      return pane.backendSessionId;
    }
  }
  for (const tab of state.tabs) {
    if (tab.session.resourceId === resourceId && tab.backendSessionId) {
      return tab.backendSessionId;
    }
  }
  return null;
}

let listening = false;
function ensureListener() {
  if (listening) return;
  listening = true;
  listen<HostSystemStats[]>("ssh-system-stats", (ev) => {
    useSshStatsStore.getState().setStats(ev.payload);
  }).catch(() => {
    listening = false;
  });
}

if (typeof window !== "undefined") {
  ensureListener();
}

/** 根据资源 ID（connection UUID 或 openssh:alias）获取对应主机的实时系统状态。
 *  优先直接按 resource ID 查找（连接池模式），
 *  兜底按后端 SSH 会话 ID 查找（交互式终端模式）。 */
export function useSshStats(resourceId: string | null): HostSystemStats | null {
  const statsMap = useSshStatsStore((s) => s.statsMap);
  useEffect(() => {
    ensureListener();
  }, []);
  if (!resourceId) return null;
  if (statsMap[resourceId]) return statsMap[resourceId];
  const backendSessionId = findBackendSessionId(resourceId);
  return backendSessionId ? (statsMap[backendSessionId] ?? null) : null;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / 1024 ** i;
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 安全计算使用率百分比，total 无效时返回 0 */
export function safePercent(
  used: number | null | undefined,
  total: number | null | undefined,
): number {
  if (total == null || total <= 0) return 0;
  const u = used ?? 0;
  return Math.min(100, Math.max(0, Math.round((u / total) * 100)));
}

/** 格式化使用率，total 无效时显示 — */
export function formatUsagePercent(
  used: number | null | undefined,
  total: number | null | undefined,
): string {
  if (total == null || total <= 0) return "—";
  return `${safePercent(used, total)}%`;
}

/** 格式化已用/总量，任一无效时显示 — */
export function formatUsageBytes(
  used: number | null | undefined,
  total: number | null | undefined,
): string {
  if (total == null || total <= 0) return "—";
  return `${formatBytes(used)} / ${formatBytes(total)}`;
}

export function formatPercent(used: number, total: number): string {
  return formatUsagePercent(used, total);
}
