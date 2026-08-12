import type { RedisInfoResult } from "../api";

export function infoSection(info: RedisInfoResult | null, section: string): Record<string, string> {
  if (!info) {
    return {};
  }
  return info.sections[section] ?? info.sections[section.toLowerCase()] ?? {};
}

export function infoValue(
  info: RedisInfoResult | null,
  section: string,
  key: string,
): string | undefined {
  const map = infoSection(info, section);
  return map[key] ?? map[key.replace(/_/g, "-")];
}

export function formatBytesLabel(raw: string | undefined): string {
  if (!raw) {
    return "—";
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    return raw;
  }
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  if (n < 1024 * 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatUptime(secondsRaw: string | undefined): string {
  const sec = Number.parseInt(secondsRaw ?? "", 10);
  if (!Number.isFinite(sec)) {
    return "—";
  }
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) {
    return `${d}d ${h}h`;
  }
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  return `${m}m`;
}

export function hitRate(info: RedisInfoResult | null): string {
  const stats = infoSection(info, "Stats");
  const hits = Number.parseInt(stats.keyspace_hits ?? "0", 10);
  const misses = Number.parseInt(stats.keyspace_misses ?? "0", 10);
  const total = hits + misses;
  if (total <= 0) {
    return "—";
  }
  return `${((hits / total) * 100).toFixed(1)}%`;
}
