import type { CloudMetricPoint, CloudMetricSeries } from "../../ipc/bindings";

export const CLOUD_METRIC_RANGE_PRESETS = [
  { id: "1h", hours: 1 },
  { id: "6h", hours: 6 },
  { id: "24h", hours: 24 },
  { id: "7d", hours: 24 * 7 },
] as const;

export type CloudMetricRangeId = (typeof CLOUD_METRIC_RANGE_PRESETS)[number]["id"];
export type CloudMetricCardSize = "hero" | "wide" | "compact";

export type CloudMetricPlotPoint = { x: number; y: number; ts: number; value: number };

const HERO_IDS = new Set(["CPUUtilization", "CpuUsage", "memory_usedutilization", "MemoryUsage"]);
const WIDE_IDS = new Set([
  "load_1m",
  "net_tcpconnection",
  "ConnectionUsage",
  "ActiveConnection",
  "InternetInRate",
  "InternetOutRate",
]);

export const CLOUD_METRIC_CHART_PAD = { l: 40, r: 12, t: 10, b: 22 };

export function cloudMetricQueryForRange(rangeId: CloudMetricRangeId): {
  startMs: number;
  endMs: number;
  periodSec: number;
} {
  const preset = CLOUD_METRIC_RANGE_PRESETS.find((item) => item.id === rangeId) ?? CLOUD_METRIC_RANGE_PRESETS[0];
  const endMs = Date.now();
  const startMs = endMs - preset.hours * 3600_000;
  const periodSec = preset.hours <= 1 ? 60 : preset.hours <= 6 ? 60 : preset.hours <= 24 ? 300 : 900;
  return { startMs, endMs, periodSec };
}

export function isGuestOsMetric(id: string): boolean {
  return (
    id === "memory_usedutilization" ||
    id === "load_1m" ||
    id === "load_5m" ||
    id === "load_15m" ||
    id === "net_tcpconnection"
  );
}

export function metricCardSize(id: string): CloudMetricCardSize {
  if (HERO_IDS.has(id)) return "hero";
  if (WIDE_IDS.has(id)) return "wide";
  return "compact";
}

export function formatMetricValue(value: number, unit: string): string {
  if (unit === "bps" || unit === "B/s") {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return value.toFixed(0);
  }
  if (unit === "%") return `${value.toFixed(1)}%`;
  if (unit === "IOPS" || unit === "count") return value.toFixed(value >= 10 ? 0 : 1);
  return value.toFixed(value >= 10 ? 0 : 2);
}

export function formatMetricTime(ts: number): string {
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return "—";
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

export function metricSeriesMax(series: CloudMetricSeries): number {
  const values = (series.points ?? []).map((point) => point.value);
  return Math.max(1, ...(series.unit === "%" ? [100] : []), ...values);
}

export function plotMetricPoints(
  series: CloudMetricSeries,
  width: number,
  height: number,
): { points: CloudMetricPlotPoint[]; max: number; line: string; area: string } {
  const raw = series.points ?? [];
  const max = metricSeriesMax(series);
  const innerW = width - CLOUD_METRIC_CHART_PAD.l - CLOUD_METRIC_CHART_PAD.r;
  const innerH = height - CLOUD_METRIC_CHART_PAD.t - CLOUD_METRIC_CHART_PAD.b;
  const points = raw.map((point, i) => {
    const x = CLOUD_METRIC_CHART_PAD.l + (raw.length <= 1 ? innerW / 2 : (i / (raw.length - 1)) * innerW);
    const y = CLOUD_METRIC_CHART_PAD.t + innerH - (Math.max(0, point.value) / max) * innerH;
    return { x, y, ts: point.tsMs, value: point.value };
  });
  if (points.length === 0) return { points, max, line: "", area: "" };
  const line = points
    .map((point, i) => `${i === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" ");
  const baseY = (CLOUD_METRIC_CHART_PAD.t + innerH).toFixed(1);
  const area =
    points.length < 2
      ? ""
      : `${line} L${points[points.length - 1]!.x.toFixed(1)},${baseY} L${points[0]!.x.toFixed(1)},${baseY} Z`;
  return { points, max, line, area };
}

export function nearestPlotPoint(points: CloudMetricPlotPoint[], x: number): CloudMetricPlotPoint | null {
  if (points.length === 0) return null;
  let best = points[0]!;
  let bestDist = Math.abs(best.x - x);
  for (const point of points) {
    const dist = Math.abs(point.x - x);
    if (dist < bestDist) {
      best = point;
      bestDist = dist;
    }
  }
  return best;
}

export function metricSeriesStats(points: CloudMetricPoint[] | undefined): {
  latest: number;
  min: number;
  max: number;
  avg: number;
} | null {
  const list = points ?? [];
  if (list.length === 0) return null;
  const values = list.map((point) => point.value);
  return {
    latest: values[values.length - 1]!,
    min: Math.min(...values),
    max: Math.max(...values),
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}
