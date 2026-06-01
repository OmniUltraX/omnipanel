import { useEffect } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

export type MemoryStats = {
  total: number;
  used: number;
  available: number;
};

export type DiskStats = {
  total: number;
  used: number;
  available: number;
};

export type HostSystemStats = {
  hostId: string;
  hostName: string;
  load: string;
  cpuCores: number;
  cpuUsage: number;
  memory: MemoryStats;
  disk: DiskStats;
  timestamp: number;
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

export function useSshStats(hostId: string | null): HostSystemStats | null {
  const statsMap = useSshStatsStore((s) => s.statsMap);
  useEffect(() => {
    ensureListener();
  }, []);
  return hostId ? (statsMap[hostId] ?? null) : null;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / 1024 ** i;
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatPercent(used: number, total: number): string {
  if (total === 0) return "0%";
  return `${((used / total) * 100).toFixed(0)}%`;
}
