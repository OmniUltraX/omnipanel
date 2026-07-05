import { create } from "zustand";
import type { SshProcessInfo } from "../ipc/bindings";
import type { HostSystemStats } from "./sshStatsStore";

export type OverviewPhase = "idle" | "loading" | "ready" | "error";

export type MonitorPoint = { ts: number; value: number };

export type HostOverviewState = {
  phase: OverviewPhase;
  stats: HostSystemStats | null;
  processes: SshProcessInfo[];
  error: string | null;
  processError: string | null;
  updatedAt: number | null;
  refreshing: boolean;
};

export type HostMonitoringState = {
  enabled: boolean;
  cpuSeries: MonitorPoint[];
  memSeries: MonitorPoint[];
  netSeries: MonitorPoint[];
};

type HostSnapshot = {
  overview: HostOverviewState;
  monitoring: HostMonitoringState;
  terminalConnected: boolean;
};

const emptyOverview = (): HostOverviewState => ({
  phase: "idle",
  stats: null,
  processes: [],
  error: null,
  processError: null,
  updatedAt: null,
  refreshing: false,
});

const emptyMonitoring = (): HostMonitoringState => ({
  enabled: false,
  cpuSeries: [],
  memSeries: [],
  netSeries: [],
});

/** 稳定空快照，避免 selector 每次返回新引用触发无限重渲染 */
const EMPTY_OVERVIEW: HostOverviewState = emptyOverview();
const EMPTY_MONITORING: HostMonitoringState = emptyMonitoring();
const EMPTY_SNAPSHOT: HostSnapshot = {
  overview: EMPTY_OVERVIEW,
  monitoring: EMPTY_MONITORING,
  terminalConnected: false,
};

type SshHostStoreState = {
  hosts: Record<string, HostSnapshot>;
  getSnapshot: (resourceId: string) => HostSnapshot;
  setOverview: (resourceId: string, patch: Partial<HostOverviewState>) => void;
  setMonitoring: (resourceId: string, patch: Partial<HostMonitoringState>) => void;
  setMonitoringEnabled: (resourceId: string, enabled: boolean) => void;
  appendMonitorPoints: (
    resourceId: string,
    points: Partial<Pick<HostMonitoringState, "cpuSeries" | "memSeries" | "netSeries">>,
  ) => void;
  setTerminalConnected: (resourceId: string, connected: boolean) => void;
  clearHost: (resourceId: string) => void;
  isMonitoring: (resourceId: string) => boolean;
};

export const useSshHostStore = create<SshHostStoreState>((set, get) => ({
  hosts: {},

  getSnapshot: (resourceId) => get().hosts[resourceId] ?? EMPTY_SNAPSHOT,

  setOverview: (resourceId, patch) =>
    set((state) => {
      const prev = state.hosts[resourceId] ?? EMPTY_SNAPSHOT;
      return {
        hosts: {
          ...state.hosts,
          [resourceId]: {
            ...prev,
            overview: { ...prev.overview, ...patch },
          },
        },
      };
    }),

  setMonitoring: (resourceId, patch) =>
    set((state) => {
      const prev = state.hosts[resourceId] ?? EMPTY_SNAPSHOT;
      return {
        hosts: {
          ...state.hosts,
          [resourceId]: {
            ...prev,
            monitoring: { ...prev.monitoring, ...patch },
          },
        },
      };
    }),

  setMonitoringEnabled: (resourceId, enabled) =>
    set((state) => {
      const prev = state.hosts[resourceId] ?? EMPTY_SNAPSHOT;
      return {
        hosts: {
          ...state.hosts,
          [resourceId]: {
            ...prev,
            monitoring: {
              ...prev.monitoring,
              enabled,
              ...(enabled
                ? {}
                : { cpuSeries: [], memSeries: [], netSeries: [] }),
            },
          },
        },
      };
    }),

  appendMonitorPoints: (resourceId, points) =>
    set((state) => {
      const prev = state.hosts[resourceId] ?? EMPTY_SNAPSHOT;
      const mon = prev.monitoring;
      return {
        hosts: {
          ...state.hosts,
          [resourceId]: {
            ...prev,
            monitoring: {
              ...mon,
              cpuSeries: points.cpuSeries ?? mon.cpuSeries,
              memSeries: points.memSeries ?? mon.memSeries,
              netSeries: points.netSeries ?? mon.netSeries,
            },
          },
        },
      };
    }),

  setTerminalConnected: (resourceId, connected) =>
    set((state) => {
      const prev = state.hosts[resourceId] ?? EMPTY_SNAPSHOT;
      return {
        hosts: {
          ...state.hosts,
          [resourceId]: { ...prev, terminalConnected: connected },
        },
      };
    }),

  clearHost: (resourceId) =>
    set((state) => {
      const next = { ...state.hosts };
      delete next[resourceId];
      return { hosts: next };
    }),

  isMonitoring: (resourceId) =>
    get().hosts[resourceId]?.monitoring.enabled ?? false,
}));

export function useHostOverview(resourceId: string | null) {
  return useSshHostStore((s) =>
    resourceId ? (s.hosts[resourceId]?.overview ?? EMPTY_OVERVIEW) : EMPTY_OVERVIEW,
  );
}

export function useHostOverviewPhase(resourceId: string | null): OverviewPhase {
  return useSshHostStore((s) =>
    resourceId ? (s.hosts[resourceId]?.overview.phase ?? "idle") : "idle",
  );
}

export function useHostMonitoring(resourceId: string | null) {
  return useSshHostStore((s) =>
    resourceId
      ? (s.hosts[resourceId]?.monitoring ?? EMPTY_MONITORING)
      : EMPTY_MONITORING,
  );
}

export function useHostTerminalConnected(resourceId: string | null): boolean {
  return useSshHostStore((s) =>
    resourceId ? (s.hosts[resourceId]?.terminalConnected ?? false) : false,
  );
}
