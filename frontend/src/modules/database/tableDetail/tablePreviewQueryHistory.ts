/**
 * 表数据面板 WHERE / ORDER BY 输入历史（按表持久化）。
 * 数组为「新→旧」：index 0 为最近一次提交。
 */

import { readTeamLocalStorage, writeTeamLocalStorage } from "../../../lib/teamPersist";

export type TablePreviewQueryHistoryMode = "where" | "order";

const STORAGE_KEY = "omnipanel.db.table-query.history.v1";
const MAX_PER_FIELD = 50;

interface TableQueryHistoryEntry {
  where: string[];
  order: string[];
}

type HistoryMap = Record<string, TableQueryHistoryEntry>;

function emptyEntry(): TableQueryHistoryEntry {
  return { where: [], order: [] };
}

function normalizeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= MAX_PER_FIELD) break;
  }
  return out;
}

function readAll(): HistoryMap {
  try {
    const raw = readTeamLocalStorage(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as HistoryMap;
    if (!parsed || typeof parsed !== "object") return {};
    const out: HistoryMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key.trim() || !value || typeof value !== "object") continue;
      out[key] = {
        where: normalizeList((value as TableQueryHistoryEntry).where),
        order: normalizeList((value as TableQueryHistoryEntry).order),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(map: HistoryMap): void {
  try {
    writeTeamLocalStorage(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota / private mode
  }
}

/** 表级历史作用域：connection + database + table。 */
export function buildTablePreviewQueryHistoryKey(
  connId: string | null | undefined,
  dbName: string | null | undefined,
  tableName: string | null | undefined,
): string | null {
  const conn = connId?.trim() ?? "";
  const db = dbName?.trim() ?? "";
  const table = tableName?.trim() ?? "";
  if (!conn || !db || !table) return null;
  return `${conn}:${db}:${table}`;
}

export function listTablePreviewQueryHistory(
  tableKey: string | null | undefined,
  mode: TablePreviewQueryHistoryMode,
): string[] {
  const key = tableKey?.trim();
  if (!key) return [];
  const entry = readAll()[key];
  if (!entry) return [];
  return [...(mode === "where" ? entry.where : entry.order)];
}

/** 成功提交后记录；空串忽略；与最近一条相同则不重复写入。 */
export function pushTablePreviewQueryHistory(
  tableKey: string | null | undefined,
  mode: TablePreviewQueryHistoryMode,
  text: string,
): string[] {
  const key = tableKey?.trim();
  const value = text.trim();
  if (!key || !value) {
    return listTablePreviewQueryHistory(key, mode);
  }

  const map = readAll();
  const prev = map[key] ?? emptyEntry();
  const list = mode === "where" ? prev.where : prev.order;
  if (list[0] === value) {
    return [...list];
  }
  const nextList = [value, ...list.filter((item) => item !== value)].slice(0, MAX_PER_FIELD);
  map[key] = {
    where: mode === "where" ? nextList : prev.where,
    order: mode === "order" ? nextList : prev.order,
  };
  writeAll(map);
  return nextList;
}
