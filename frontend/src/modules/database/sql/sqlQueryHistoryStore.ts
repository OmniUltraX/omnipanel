import { classifySqlHistoryKind, type SqlHistoryKind } from "./classifySqlHistoryKind";

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

/** 历史作用域：优先 SQL 文件 id，草稿用 tabId。 */
export function resolveSqlHistoryScopeId(sqlFileId: string | undefined, tabId: string): string {
  return sqlFileId?.trim() ? `file:${sqlFileId}` : `tab:${tabId}`;
}

export function listSqlQueryHistory(scopeId: string): SqlQueryHistoryEntry[] {
  const list = readAll()[scopeId] ?? [];
  return [...list].sort((a, b) => b.executedAt - a.executedAt);
}

export function listSqlQueryHistoryGrouped(scopeId: string): Record<SqlHistoryKind, SqlQueryHistoryEntry[]> {
  const list = listSqlQueryHistory(scopeId);
  const grouped: Record<SqlHistoryKind, SqlQueryHistoryEntry[]> = {
    select: [],
    dml: [],
    ddl: [],
    other: [],
  };
  for (const entry of list) {
    grouped[entry.kind].push(entry);
  }
  return grouped;
}

/** 仅记录成功执行；同 scope 最多保留最新 50 条。 */
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

  const map = readAll();
  const next = [entry, ...(map[scopeId] ?? [])].slice(0, MAX_ENTRIES);
  map[scopeId] = next;
  writeAll(map);
}

export function clearSqlQueryHistory(scopeId: string): void {
  const map = readAll();
  delete map[scopeId];
  writeAll(map);
}
