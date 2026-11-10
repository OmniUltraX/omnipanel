import type { HostSystemStats } from "@/stores/sshStatsStore";

export const GAUGE_RADIUS = 24;
export const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;

export function gaugeOffset(percent: number): number {
  const p = Math.min(Math.max(percent, 0), 100);
  return GAUGE_CIRCUMFERENCE - (p / 100) * GAUGE_CIRCUMFERENCE;
}

export function metricBarColor(
  val: number,
  kind: "cpu" | "gpu" | "mem" | "disk",
  accent?: string,
): string {
  if (kind === "cpu" || kind === "gpu") {
    if (val >= 80) return "var(--danger)";
    if (val >= 50) return "var(--warn)";
    return accent ?? "var(--accent)";
  }
  if (val >= 85) return "var(--danger)";
  if (val >= 60) return "var(--warn)";
  return accent ?? "var(--success)";
}

export function coreLoadLevel(usage: number): 0 | 1 | 2 | 3 | 4 {
  if (usage >= 90) return 4;
  if (usage >= 70) return 3;
  if (usage >= 45) return 2;
  if (usage >= 15) return 1;
  return 0;
}

export function formatUptime(secs: number | null | undefined): string {
  if (secs == null || secs <= 0) return "—";
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  if (days > 0) return `${days} 天 ${hours} 时`;
  const mins = Math.floor((secs % 3600) / 60);
  if (hours > 0) return `${hours} 时 ${mins} 分`;
  return `${mins} 分`;
}

export function formatRate(bytesPerSec: number | null): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return "—";
  if (bytesPerSec >= 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  if (bytesPerSec >= 1024) {
    return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  }
  return `${Math.round(bytesPerSec)} B/s`;
}

export function formatCompactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function computeByteRate(
  prev: HostSystemStats | null,
  cur: HostSystemStats,
  pick: (s: HostSystemStats) => number | null | undefined,
): number | null {
  if (!prev?.timestamp || !cur.timestamp) return null;
  const dt = cur.timestamp - prev.timestamp;
  if (dt <= 0) return null;
  const prevVal = pick(prev);
  const curVal = pick(cur);
  if (prevVal == null || curVal == null) return null;
  const delta = Math.max(0, curVal - prevVal);
  return delta / dt;
}

export function sparklinePaths(
  values: number[],
  width = 200,
  height = 28,
): { line: string; area: string } | null {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = `M${pts.join(" L")}`;
  const area = `M0,${height} L${pts.join(" L")} L${width},${height} Z`;
  return { line, area };
}

export function shortGpuName(name: string): string {
  return name
    .replace(/^NVIDIA\s+/i, "")
    .replace(/^AMD\s+/i, "")
    .replace(/^Intel\s*\(R\)\s*/i, "")
    .trim();
}

export function formatMiB(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

export type StatusBadge = {
  label: string;
  tone: "success" | "warn" | "danger" | "accent";
};

export function cpuStatusBadge(pct: number): StatusBadge {
  if (pct >= 85) return { label: "高负载", tone: "danger" };
  if (pct >= 60) return { label: "繁忙", tone: "warn" };
  return { label: "正常", tone: "success" };
}

export function memStatusBadge(pct: number, opts?: { known?: boolean }): StatusBadge {
  if (opts && opts.known === false) return { label: "未知", tone: "accent" };
  if (pct >= 90) return { label: "紧张", tone: "danger" };
  if (pct >= 70) return { label: "注意", tone: "warn" };
  return { label: "充裕", tone: "success" };
}

export function diskStatusBadge(pct: number): StatusBadge {
  if (pct >= 90) return { label: "已满", tone: "danger" };
  if (pct >= 75) return { label: "注意", tone: "warn" };
  return { label: "正常", tone: "success" };
}
