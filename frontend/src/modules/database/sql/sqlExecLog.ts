import { commands, type SqlExecAppend, type SqlExecListFilter, type SqlExecRecord, type SqlExecResultPage } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";
import { readTeamLocalStorage, writeTeamLocalStorage } from "../../../lib/teamPersist";

export type { SqlExecAppend, SqlExecListFilter, SqlExecRecord, SqlExecResultPage };

const LEGACY_HISTORY_KEY = "omnipanel.sqlQueryHistory.v1";
const listeners = new Set<() => void>();

type CursorInsert = (sql: string) => void;
type SqlFileOpen = (sqlFileId: string) => void;

let cursorInsert: CursorInsert | null = null;
let sqlFileOpen: SqlFileOpen | null = null;

const tableHistoryCache = new Map<string, SqlExecRecord[]>();

function notify() {
  for (const listener of listeners) listener();
}

export function subscribeSqlExecLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function sqlExecDisplayName(sql: string, fallback: string): string {
  const trimmed = sql.trim();
  const block = trimmed.match(/^\/\*\s*([\s\S]*?)\s*\*\//);
  const line = trimmed.match(/^--\s*(.+)$/m);
  const comment = (block?.[1] ?? line?.[1] ?? "").split("\n")[0]?.trim() ?? "";
  if (comment) return comment.slice(0, 80);
  const body = trimmed
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (body || fallback).slice(0, 80);
}

type SqlExecTimeKey =
  | "database.sqlExec.justNow"
  | "database.sqlExec.minutesAgo"
  | "database.sqlExec.hoursAgo"
  | "database.sqlExec.daysAgo";

export function formatSqlExecRelativeTime(
  executedAt: number,
  t: (key: SqlExecTimeKey, params?: Record<string, string | number>) => string,
  now = Date.now(),
): string {
  const delta = Math.max(0, now - executedAt);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return t("database.sqlExec.justNow");
  if (delta < hour) return t("database.sqlExec.minutesAgo", { n: Math.floor(delta / minute) });
  if (delta < day) return t("database.sqlExec.hoursAgo", { n: Math.floor(delta / hour) });
  if (delta < 7 * day) return t("database.sqlExec.daysAgo", { n: Math.floor(delta / day) });
  try {
    return new Date(executedAt).toLocaleString();
  } catch {
    return String(executedAt);
  }
}

export function registerSqlCursorInsert(insert: CursorInsert): () => void {
  cursorInsert = insert;
  return () => {
    if (cursorInsert === insert) cursorInsert = null;
  };
}

export function registerSqlFileOpener(open: SqlFileOpen): () => void {
  sqlFileOpen = open;
  return () => {
    if (sqlFileOpen === open) sqlFileOpen = null;
  };
}

/** 有打开的 SQL 编辑器时插到光标处；否则返回 false，由调用方另开查询。 */
export function insertSqlAtActiveCursor(sql: string): boolean {
  if (!cursorInsert) return false;
  cursorInsert(sql);
  return true;
}

export function openSqlExecutionSource(sqlFileId: string | null | undefined): boolean {
  if (!sqlFileId || !sqlFileOpen) return false;
  sqlFileOpen(sqlFileId);
  return true;
}

export function makeSqlExecId(): string {
  return crypto.randomUUID();
}

export async function appendSqlExecution(input: SqlExecAppend): Promise<void> {
  try {
    await unwrapCommand(commands.dbSqlExecAppend(input));
    notify();
  } catch (error) {
    console.error("[sql-exec] append failed", error);
  }
}

export async function listSqlExecutions(filter: Partial<SqlExecListFilter>): Promise<SqlExecRecord[]> {
  return unwrapCommand(
    commands.dbSqlExecList({
      connectionId: filter.connectionId ?? null,
      sqlFileId: filter.sqlFileId ?? null,
      tabId: filter.tabId ?? null,
      databaseName: filter.databaseName ?? null,
      status: filter.status ?? null,
      kind: filter.kind ?? null,
      keyword: filter.keyword ?? null,
      tableName: filter.tableName ?? null,
      fromMs: filter.fromMs ?? null,
      toMs: filter.toMs ?? null,
      limit: filter.limit ?? null,
    }),
  );
}

export async function getSqlExecResult(id: string): Promise<SqlExecResultPage | null> {
  return unwrapCommand(commands.dbSqlExecResult(id));
}

export async function setSqlExecPinned(id: string, pinned: boolean): Promise<void> {
  await unwrapCommand(commands.dbSqlExecSetPinned(id, pinned));
  notify();
}

export async function deleteSqlExecution(id: string): Promise<void> {
  await unwrapCommand(commands.dbSqlExecDelete(id));
  notify();
}

export async function clearSqlExecutions(connectionId: string): Promise<void> {
  await unwrapCommand(commands.dbSqlExecClear(connectionId));
  notify();
}

export async function rebindSqlExecutionFile(tabId: string, sqlFileId: string): Promise<void> {
  try {
    await unwrapCommand(commands.dbSqlExecRebindFile(tabId, sqlFileId));
    notify();
  } catch (error) {
    console.error("[sql-exec] rebind failed", error);
  }
}

function tableCacheKey(connectionId: string, database: string, table: string): string {
  return `${connectionId}\0${database}\0${table.toLowerCase()}`;
}

export function readTableSqlHistory(connectionId: string, database: string, table: string): SqlExecRecord[] {
  return tableHistoryCache.get(tableCacheKey(connectionId, database, table)) ?? [];
}

export async function prefetchTableSqlHistory(
  connectionId: string,
  database: string,
  table: string,
): Promise<SqlExecRecord[]> {
  const rows = await listSqlExecutions({
    connectionId,
    databaseName: database,
    tableName: table,
    status: "ok",
    limit: 30,
  });
  tableHistoryCache.set(tableCacheKey(connectionId, database, table), rows);
  return rows;
}

let legacyImportStarted = false;

/** 把旧的 localStorage 成功历史导成无结果页的记录，然后清掉旧 key。 */
export async function importLegacySqlQueryHistory(): Promise<void> {
  if (legacyImportStarted) return;
  legacyImportStarted = true;
  const raw = readTeamLocalStorage(LEGACY_HISTORY_KEY);
  if (!raw?.trim()) return;
  let map: Record<string, Array<{
    id?: string;
    sql?: string;
    executedAt?: number;
    elapsedMs?: number | null;
    connectionName?: string;
    database?: string;
    rowsAffected?: number;
    rowCount?: number;
  }>>;
  try {
    map = JSON.parse(raw) as typeof map;
  } catch {
    writeTeamLocalStorage(LEGACY_HISTORY_KEY, "");
    return;
  }
  const jobs: Promise<void>[] = [];
  for (const [scope, entries] of Object.entries(map)) {
    if (!Array.isArray(entries)) continue;
    const sqlFileId = scope.startsWith("file:") ? scope.slice(5) : null;
    const tabId = scope.startsWith("tab:") ? scope.slice(4) : scope;
    for (const entry of entries) {
      const sql = entry.sql?.trim();
      if (!sql) continue;
      jobs.push(
        appendSqlExecution({
          id: entry.id || `legacy-${scope}-${entry.executedAt ?? 0}`,
          executedAt: entry.executedAt ?? Date.now(),
          connectionId: "",
          connectionName: entry.connectionName ?? "",
          databaseName: entry.database ?? "",
          envTag: "",
          sqlFileId,
          tabId,
          sql,
          displayName: sqlExecDisplayName(sql, "SQL"),
          status: "ok",
          elapsedMs: entry.elapsedMs ?? null,
          rowsAffected: entry.rowsAffected ?? 0,
          error: "",
          pinned: false,
          columns: [],
          rows: [],
        }),
      );
    }
  }
  await Promise.all(jobs);
  writeTeamLocalStorage(LEGACY_HISTORY_KEY, "");
}
