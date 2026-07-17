import { useCallback } from "react";
import type { HostSystemStats } from "../../../../stores/sshStatsStore";
import { safePercent } from "../../../../stores/sshStatsStore";
import { useHostMonitoring, useSshHostStore } from "../../../../stores/sshHostStore";
import {
  disableSshMonitoring,
  enableSshMonitoring,
} from "../../../../stores/sshMonitoringLifecycle";

export type MonitoringPhase = "idle" | "loading" | "ready" | "error";

const MAX_POINTS = 120;

function networkMbps(prev: HostSystemStats, cur: HostSystemStats): number | null {
  if (!prev.network || !cur.network) return null;
  if (cur.timestamp == null || prev.timestamp == null) return null;
  const dt = cur.timestamp - prev.timestamp;
  if (dt <= 0) return null;
  const drx = Math.max(0, (cur.network.rxBytes ?? 0) - (prev.network.rxBytes ?? 0));
  const dtx = Math.max(0, (cur.network.txBytes ?? 0) - (prev.network.txBytes ?? 0));
  return (drx + dtx) / dt / (1024 * 1024);
}

function appendPoint(
  history: { ts: number; value: number }[],
  stats: HostSystemStats,
  extract: (s: HostSystemStats) => number | null,
): { ts: number; value: number }[] {
  const v = extract(stats);
  if (v == null || stats.timestamp == null) return history;
  const ts = stats.timestamp * 1000;
  const last = history[history.length - 1];
  if (last && last.ts === ts) return history;
  return [...history.slice(-(MAX_POINTS - 1)), { ts, value: v }];
}

export {
  enableSshMonitoring,
  disableSshMonitoring,
  restoreSshMonitoringSubscriptions,
  forgetSshMonitoring,
} from "../../../../stores/sshMonitoringLifecycle";

export function useSshMonitoring(resourceId: string | null) {
  const monitoring = useHostMonitoring(resourceId);
  const appendMonitorPoints = useSshHostStore((s) => s.appendMonitorPoints);

  const enable = useCallback(async () => {
    if (!resourceId) return;
    await enableSshMonitoring(resourceId);
  }, [resourceId]);

  const disable = useCallback(async () => {
    if (!resourceId) return;
    await disableSshMonitoring(resourceId);
  }, [resourceId]);

  const ingestStats = useCallback(
    (stats: HostSystemStats, prev: HostSystemStats | null) => {
      if (!resourceId) return;
      const cpuSeries = appendPoint(monitoring.cpuSeries, stats, (s) => s.cpuUsage);
      const memSeries = appendPoint(
        monitoring.memSeries,
        stats,
        (s) => safePercent(s.memory.used, s.memory.total),
      );
      let netSeries = monitoring.netSeries;
      if (prev && prev.timestamp != null && prev.timestamp !== stats.timestamp) {
        const mbps = networkMbps(prev, stats);
        if (mbps != null && stats.timestamp != null) {
          const ts = stats.timestamp * 1000;
          const last = netSeries[netSeries.length - 1];
          if (!last || last.ts !== ts) {
            netSeries = [...netSeries.slice(-(MAX_POINTS - 1)), { ts, value: mbps }];
          }
        }
      }
      appendMonitorPoints(resourceId, { cpuSeries, memSeries, netSeries });
    },
    [
      appendMonitorPoints,
      monitoring.cpuSeries,
      monitoring.memSeries,
      monitoring.netSeries,
      resourceId,
    ],
  );

  const phase: MonitoringPhase = !resourceId
    ? "idle"
    : monitoring.enabled
      ? monitoring.cpuSeries.length > 0
        ? "ready"
        : "loading"
      : "idle";

  return {
    phase,
    enabled: monitoring.enabled,
    cpuSeries: monitoring.cpuSeries,
    memSeries: monitoring.memSeries,
    netSeries: monitoring.netSeries,
    enable,
    disable,
    ingestStats,
  };
}
