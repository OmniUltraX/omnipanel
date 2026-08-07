import {
  classifySqlHistoryKind,
  type SqlHistoryKind,
} from "./classifySqlHistoryKind";

const STORAGE_KEY = "omnipanel.sqlQueryHistory.v1";
const MAX_ENTRIES = 50;

export interface SqlQueryHistoryEntry {
  id: string;
  sql: string;
  kind: SqlHistoryKind;
  executedAt: number;
  elapsedMs: number | null;
  connectionName?: string;
  database?: string;
  rowsAffected?: number;
  rowCount?: number;
}

type HistoryMap = Record<string, SqlQueryHistoryEntry[]>;

function readAll(): HistoryMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as HistoryMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(map: HistoryMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota
  }
}

/** 比较用：去首尾空白与尾部分号。 */
export function normalizeHistorySql(sql: string): string {
  return sql.trim().replace(/;+\s*$/u, "").trimEnd();
}

/** 历史作用域：优先 SQL 文件 id，草稿用 tabId。 */
export function resolveSqlHistoryScopeId(sqlFileId: string | undefined, tabId: string): string {
  return sqlFileId?.trim() ? `file:${sqlFileId}` : `tab:${tabId}`;
}

export function listSqlQueryHistory(scopeId: string): SqlQueryHistoryEntry[] {
  const list = readAll()[scopeId] ?? [];
  return [...list].sort((a, b) => b.executedAt - a.executedAt);
}

/** @deprecated 历史列表改为时间序 + tag；保留供兼容。 */
export function listSqlQueryHistoryGrouped(scopeId: string): Record<string, SqlQueryHistoryEntry[]> {
  const list = listSqlQueryHistory(scopeId);
  const grouped: Record<string, SqlQueryHistoryEntry[]> = {};
  for (const entry of list) {
    const key = entry.kind;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(entry);
  }
  return grouped;
}

/** 仅记录成功执行；连续相同 SQL 只保留一条并刷新元数据；同 scope 最多 50 条。 */
export function appendSuccessfulSqlQueryHistory(
  scopeId: string,
  input: {
    sql: string;
    elapsedMs?: number | null;
    connectionName?: string;
    database?: string;
    rowsAffected?: number;
    rowCount?: number;
  },
): void {
  const sql = input.sql.trim();
  if (!sql) return;

  const map = readAll();
  const prev = map[scopeId] ?? [];
  const newest = prev[0];

  if (newest && normalizeHistorySql(newest.sql) === normalizeHistorySql(sql)) {
    map[scopeId] = [
      {
        ...newest,
        sql,
        kind: classifySqlHistoryKind(sql),
        executedAt: Date.now(),
        elapsedMs: input.elapsedMs ?? null,
        connectionName: input.connectionName ?? newest.connectionName,
        database: input.database ?? newest.database,
        rowsAffected: input.rowsAffected,
        rowCount: input.rowCount,
      },
      ...prev.slice(1),
    ];
    writeAll(map);
    return;
  }

  const entry: SqlQueryHistoryEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    sql,
    kind: classifySqlHistoryKind(sql),
    executedAt: Date.now(),
    elapsedMs: input.elapsedMs ?? null,
    connectionName: input.connectionName,
    database: input.database,
    rowsAffected: input.rowsAffected,
    rowCount: input.rowCount,
  };

  map[scopeId] = [entry, ...prev].slice(0, MAX_ENTRIES);
  writeAll(map);
}

export function clearSqlQueryHistory(scopeId: string): void {
  const map = readAll();
  delete map[scopeId];
  writeAll(map);
}
