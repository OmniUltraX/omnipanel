import { useCallback } from "react";
import { commands } from "../../../../ipc/bindings";
import type { HostSystemStats } from "../../../../stores/sshStatsStore";
import { safePercent } from "../../../../stores/sshStatsStore";
import {
  acquireSshPoolSession,
  releaseSshPoolSession,
} from "../../../../stores/sshPoolSessionStore";
import { useHostMonitoring, useSshHostStore } from "../../../../stores/sshHostStore";

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

/** 开启 SSH 系统监控订阅（幂等；可从看板卡片等非 hook 场景调用） */
export async function enableSshMonitoring(resourceId: string): Promise<void> {
  if (useSshHostStore.getState().isMonitoring(resourceId)) return;
  useSshHostStore.getState().setMonitoringEnabled(resourceId, true);
  acquireSshPoolSession(resourceId);
  try {
    const res = await commands.sshPoolSubscribeMonitoring(resourceId);
    if (res.status !== "ok") {
      useSshHostStore.getState().setMonitoringEnabled(resourceId, false);
      releaseSshPoolSession(resourceId);
    }
  } catch {
    useSshHostStore.getState().setMonitoringEnabled(resourceId, false);
    releaseSshPoolSession(resourceId);
  }
}

/** 关闭 SSH 系统监控订阅（幂等） */
export async function disableSshMonitoring(resourceId: string): Promise<void> {
  if (!useSshHostStore.getState().isMonitoring(resourceId)) return;
  useSshHostStore.getState().setMonitoringEnabled(resourceId, false);
  releaseSshPoolSession(resourceId);
  try {
    await commands.sshPoolUnsubscribeMonitoring(resourceId);
  } catch {
    // ignore
  }
}

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

  // 订阅生命周期只跟 enable/disable 绑定，不在组件 unmount 时取消，
  // 以便离开 SSH 详情后首页「资源监控」tab 仍能持续收数。

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
