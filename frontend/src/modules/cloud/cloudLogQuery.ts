import type { CloudLogEntry } from "../../ipc/bindings";
import {
  CLOUD_METRIC_RANGE_PRESETS,
  cloudMetricQueryForRange,
  type CloudMetricRangeId,
} from "./cloudMetricChart";

export const CLOUD_LOG_RANGE_PRESETS = CLOUD_METRIC_RANGE_PRESETS;
export type CloudLogRangeId = CloudMetricRangeId | "custom";
export type CloudLogSortKey = "time" | "duration";
export type CloudLogSortDir = "asc" | "desc";

/** 阿里云慢日志查询跨度须小于 31 天。 */
export const CLOUD_LOG_MAX_SPAN_MS = 31 * 24 * 3600_000;

export function msToDatetimeLocal(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function datetimeLocalToMs(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const ms = new Date(trimmed).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function cloudLogWindow(
  rangeId: CloudLogRangeId,
  customStart: string,
  customEnd: string,
  nowMs = Date.now(),
): { startMs: number; endMs: number } {
  if (rangeId === "custom") {
    const startMs = datetimeLocalToMs(customStart);
    const endMs = datetimeLocalToMs(customEnd);
    if (startMs > 0 && endMs > startMs) {
      return clampCloudLogWindow(startMs, endMs, nowMs);
    }
  }
  const preset = rangeId === "custom" ? "24h" : rangeId;
  const query = cloudMetricQueryForRange(preset);
  return clampCloudLogWindow(query.startMs, query.endMs, nowMs);
}

export function clampCloudLogWindow(
  startMs: number,
  endMs: number,
  nowMs = Date.now(),
): { startMs: number; endMs: number } {
  let end = endMs > 0 ? endMs : nowMs;
  if (nowMs > 0 && end > nowMs) end = nowMs;
  let start = startMs > 0 ? startMs : end - 24 * 3600_000;
  if (start >= end) start = end - 3600_000;
  if (end - start > CLOUD_LOG_MAX_SPAN_MS) start = end - CLOUD_LOG_MAX_SPAN_MS;
  return { startMs: start, endMs: end };
}

export function cloudLogDuration(entry: CloudLogEntry): number {
  const raw = entry.fields?.queryTimes?.trim() ?? "";
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function collectCloudLogDbNames(
  fromChildren: string[],
  entries: CloudLogEntry[],
): string[] {
  const names = new Set<string>();
  for (const name of fromChildren) {
    const trimmed = name.trim();
    if (trimmed) names.add(trimmed);
  }
  for (const entry of entries) {
    const db = entry.fields?.db?.trim();
    if (db) names.add(db);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function filterCloudLogEntries(
  entries: CloudLogEntry[],
  minDuration: string,
  sqlContains: string,
): CloudLogEntry[] {
  const min = Number(minDuration);
  const hasMin = minDuration.trim() !== "" && Number.isFinite(min);
  const needle = sqlContains.trim().toLowerCase();
  return entries.filter((entry) => {
    if (hasMin && cloudLogDuration(entry) < min) return false;
    if (needle) {
      const sql = `${entry.summary ?? ""} ${entry.fields?.sql ?? ""}`.toLowerCase();
      if (!sql.includes(needle)) return false;
    }
    return true;
  });
}

export function cloudLogCsvRows(entries: CloudLogEntry[]): Record<string, unknown>[] {
  return entries.map((entry) => ({
    time: entry.tsMs ? new Date(entry.tsMs).toISOString() : "",
    duration: entry.fields?.queryTimes ?? "",
    host: entry.fields?.host ?? "",
    db: entry.fields?.db ?? "",
    sql: entry.fields?.sql || entry.summary || "",
  }));
}

export const CLOUD_LOG_CSV_COLUMNS = ["time", "duration", "host", "db", "sql"] as const;

export function sortCloudLogEntries(
  entries: CloudLogEntry[],
  key: CloudLogSortKey,
  dir: CloudLogSortDir,
): CloudLogEntry[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    const av = key === "duration" ? cloudLogDuration(a) : a.tsMs ?? 0;
    const bv = key === "duration" ? cloudLogDuration(b) : b.tsMs ?? 0;
    if (av === bv) return 0;
    return av > bv ? sign : -sign;
  });
}
