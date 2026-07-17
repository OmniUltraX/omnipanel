import type { HostSystemStats } from "../../stores/sshStatsStore";
import { safePercent } from "../../stores/sshStatsStore";

export type HostMonitorStatus = "ok" | "warn" | "danger";

export function resolveHostMonitorStatus(stats: HostSystemStats | null): HostMonitorStatus {
  if (!stats) return "ok";
  const cpu = Math.round(stats.cpuUsage ?? stats.cpu?.usage ?? 0);
  // 与 SSH 概览 MonMetricCards 一致：内存环/告警按 used/total，不含 cache/buffers
  const memPct = safePercent(stats.memory.used, stats.memory.total);
  const diskPct = safePercent(stats.disk.used, stats.disk.total);
  // 阈值对齐 memStatusBadge / cpuStatusBadge / diskStatusBadge
  if (diskPct >= 90 || cpu >= 85 || memPct >= 90) return "danger";
  if (cpu >= 60 || memPct >= 70 || diskPct >= 75) return "warn";
  return "ok";
}

export function levelColor(pct: number): string {
  if (pct >= 85) return "var(--danger)";
  if (pct >= 60) return "var(--warn)";
  return "var(--success)";
}

const DONUT_R = 20;
const DONUT_C = 2 * Math.PI * DONUT_R;

export function donutOffset(pct: number): number {
  return DONUT_C - (Math.min(100, Math.max(0, pct)) / 100) * DONUT_C;
}

export { DONUT_R, DONUT_C };
