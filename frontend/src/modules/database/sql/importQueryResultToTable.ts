import { invoke } from "@tauri-apps/api/core";
import type { DbColumnMeta, DbConnectionConfig } from "../api";
import {
  buildInsertSql,
  quoteSqlIdent,
} from "../grid/tableDataGridCopySql";
import { makeQueryRunId } from "./queryRun";
import { rowsToRecord, type QueryResult } from "../workspace/dbWorkspaceState";

/** 导入时拉取结果的硬上限（行）。 */
export const IMPORT_TO_TABLE_ROW_HARD_LIMIT = 100_000;

/** 每批 INSERT 行数。 */
export const IMPORT_TO_TABLE_BATCH_SIZE = 200;

export type ColumnNameMatch = {
  matched: Array<{ source: string; target: string }>;
  sourceOnly: string[];
  targetOnly: string[];
};

/** 按列名（忽略大小写）匹配结果列与目标表列；INSERT 使用目标表真实列名。 */
export function matchColumnsByName(
  sourceColumns: string[],
  targetColumns: string[],
): ColumnNameMatch {
  const targetByLower = new Map<string, string>();
  for (const name of targetColumns) {
    const key = name.toLowerCase();
    if (!targetByLower.has(key)) {
      targetByLower.set(key, name);
    }
  }

  const matched: Array<{ source: string; target: string }> = [];
  const usedTargets = new Set<string>();
  const sourceOnly: string[] = [];

  for (const source of sourceColumns) {
    const target = targetByLower.get(source.toLowerCase());
    if (target && !usedTargets.has(target)) {
      matched.push({ source, target });
      usedTargets.add(target);
    } else {
      sourceOnly.push(source);
    }
  }

  const targetOnly = targetColumns.filter((name) => !usedTargets.has(name));
  return { matched, sourceOnly, targetOnly };
}

/** 无来源且需手动填充常量的目标列（非空、非自增）。 */
export function listConstantFillTargetColumns(
  match: ColumnNameMatch,
  targetColumnMeta: DbColumnMeta[],
): DbColumnMeta[] {
  const metaByName = new Map(
    targetColumnMeta.map((column) => [column.name.toLowerCase(), column]),
  );
  return match.targetOnly
    .map((name) => metaByName.get(name.toLowerCase()))
    .filter((column): column is DbColumnMeta => {
      if (!column) return false;
      if (column.nullable !== false) return false;
      if (column.isAutoIncrement) return false;
      return true;
    });
}

/** 将用户输入的常量文本解析为 INSERT 用的值。 */
export function parseImportConstantValue(
  raw: string,
  meta?: DbColumnMeta,
): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^null$/i.test(trimmed)) {
    return null;
  }
  if (/^(true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === "true";
  }
  const type = (meta?.type ?? "").toLowerCase();
  const looksNumeric = /int|decimal|numeric|float|double|real|number|serial|bigint/.test(type);
  if (looksNumeric && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed.includes(".") ? Number.parseFloat(trimmed) : Number.parseInt(trimmed, 10);
  }
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isSqliteEngine(dbType: string | undefined): boolean {
  const t = (dbType ?? "").toLowerCase();
  return t.includes("sqlite");
}

/** 生成清空表 SQL。事务内导入用 DELETE（TRUNCATE 在多数引擎会隐式提交）。 */
export function buildClearTableSql(
  dbType: string | undefined,
  tableName: string,
  opts?: { transactional?: boolean },
): string {
  const table = quoteSqlIdent(dbType, tableName);
  if (isSqliteEngine(dbType) || opts?.transactional) {
    return `DELETE FROM ${table}`;
  }
  return `TRUNCATE TABLE ${table}`;
}

export type ImportFetchProgress = {
  phase: "fetching" | "clearing" | "inserting" | "done";
  fetchedRows: number;
  insertedRows: number;
  message?: string;
};

export type ImportToTableParams = {
  sourceConnection: DbConnectionConfig;
  sourceSql: string;
  targetConnection: DbConnectionConfig;
  targetTable: string;
  /** 结果列名（用于同名匹配）；若为空则用首次查询结果列。 */
  sourceColumns?: string[];
  targetColumns: string[];
  /** 无来源的非空目标列常量填充（目标列名 -> 用户输入）。 */
  constantFills?: Record<string, string>;
  targetColumnMeta?: DbColumnMeta[];
  clearBeforeImport: boolean;
  pageSize: number;
  hardLimit?: number;
  batchSize?: number;
  onProgress?: (progress: ImportFetchProgress) => void;
  signal?: AbortSignal;
};

export type ImportToTableResult = {
  fetchedRows: number;
  insertedRows: number;
  matchedColumns: string[];
};

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("aborted");
  }
}

async function executeSql(
  connection: DbConnectionConfig,
  sql: string,
  limit?: number | null,
  offset?: number | null,
): Promise<QueryResult> {
  return invoke<QueryResult>("db_execute_query", {
    connection,
    sql,
    runId: makeQueryRunId(),
    limit: limit ?? null,
    offset: offset ?? null,
  });
}

/** 在独占事务会话中执行 SQL（首次自动 BEGIN）。 */
async function executeSqlInSession(
  sessionId: string,
  connection: DbConnectionConfig,
  sql: string,
): Promise<QueryResult> {
  return invoke<QueryResult>("db_execute_query_in_session", {
    sessionId,
    connection,
    sql,
    runId: makeQueryRunId(),
    limit: null,
    offset: null,
  });
}

async function commitImportSession(sessionId: string): Promise<void> {
  await invoke("db_query_session_commit", { sessionId });
}

async function rollbackImportSession(sessionId: string): Promise<void> {
  try {
    await invoke("db_query_session_rollback", { sessionId });
  } catch {
    // 回滚失败时仍继续关闭会话
  }
}

async function closeImportSession(sessionId: string): Promise<void> {
  try {
    await invoke("db_query_session_close", { sessionId });
  } catch {
    // 关闭失败忽略
  }
}

function mapSourceRow(
  row: Record<string, unknown>,
  matched: Array<{ source: string; target: string }>,
  constantFillEntries: Array<{ target: string; value: unknown }>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const { source, target } of matched) {
    next[target] = row[source];
  }
  for (const { target, value } of constantFillEntries) {
    next[target] = value;
  }
  return next;
}

/** 按 limit/offset 分页拉取查询全部结果行（一次性入内存；导入请用 streaming 路径）。 */
export async function fetchAllQueryResultRows(opts: {
  connection: DbConnectionConfig;
  sql: string;
  pageSize: number;
  hardLimit?: number;
  onProgress?: (fetchedRows: number) => void;
  signal?: AbortSignal;
}): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const pageSize = Math.max(1, opts.pageSize);
  const hardLimit = opts.hardLimit ?? IMPORT_TO_TABLE_ROW_HARD_LIMIT;
  const allRows: Record<string, unknown>[] = [];
  let columns: string[] = [];
  let page = 0;

  for (;;) {
    assertNotAborted(opts.signal);
    const result = await executeSql(
      opts.connection,
      opts.sql,
      pageSize,
      page * pageSize,
    );
    if (result.columns.length === 0) {
      break;
    }
    if (columns.length === 0) {
      columns = result.columns;
    }
    const records = rowsToRecord(result.columns, result.rows);
    allRows.push(...records);
    opts.onProgress?.(allRows.length);

    if (allRows.length > hardLimit) {
      throw new Error(`ROW_LIMIT:${hardLimit}`);
    }
    if (result.rows.length < pageSize) {
      break;
    }
    page += 1;
  }

  return { columns, rows: allRows };
}

/** 将查询结果按同名列导入目标表：目标侧开事务，分页拉取并分批写入。 */
export async function importQueryResultToTable(
  params: ImportToTableParams,
): Promise<ImportToTableResult> {
  const hardLimit = params.hardLimit ?? IMPORT_TO_TABLE_ROW_HARD_LIMIT;
  const batchSize = params.batchSize ?? IMPORT_TO_TABLE_BATCH_SIZE;
  const pageSize = Math.max(1, params.pageSize);

  const sourceColumns =
    params.sourceColumns && params.sourceColumns.length > 0
      ? params.sourceColumns
      : null;
  if (!sourceColumns) {
    throw new Error("NO_MATCHED_COLUMNS");
  }

  const resolvedMatch = matchColumnsByName(sourceColumns, params.targetColumns);
  if (resolvedMatch.matched.length === 0) {
    throw new Error("NO_MATCHED_COLUMNS");
  }

  const metaByName = new Map(
    (params.targetColumnMeta ?? []).map((column) => [column.name.toLowerCase(), column]),
  );
  const requiredConstantColumns = listConstantFillTargetColumns(
    resolvedMatch,
    params.targetColumnMeta ?? [],
  );
  const constantFillEntries: Array<{ target: string; value: unknown }> = [];
  for (const column of requiredConstantColumns) {
    const raw = params.constantFills?.[column.name]?.trim() ?? "";
    const value = parseImportConstantValue(raw, column);
    if (value === undefined || value === null) {
      throw new Error(`MISSING_CONSTANT_FILL:${column.name}`);
    }
    constantFillEntries.push({ target: column.name, value });
  }

  for (const targetName of resolvedMatch.targetOnly) {
    if (requiredConstantColumns.some((column) => column.name === targetName)) {
      continue;
    }
    const raw = params.constantFills?.[targetName]?.trim() ?? "";
    if (!raw) continue;
    const value = parseImportConstantValue(raw, metaByName.get(targetName.toLowerCase()));
    if (value === undefined) continue;
    constantFillEntries.push({ target: targetName, value });
  }

  const insertColumns = [
    ...resolvedMatch.matched.map((m) => m.target),
    ...constantFillEntries.map((entry) => entry.target),
  ];

  const importSessionId = `import-to-table-${makeQueryRunId()}`;
  let fetchedRows = 0;
  let insertedRows = 0;
  let committed = false;

  try {
    if (params.clearBeforeImport) {
      assertNotAborted(params.signal);
      params.onProgress?.({
        phase: "clearing",
        fetchedRows: 0,
        insertedRows: 0,
      });
      await executeSqlInSession(
        importSessionId,
        params.targetConnection,
        buildClearTableSql(params.targetConnection.db_type, params.targetTable, {
          transactional: true,
        }),
      );
    }

    let page = 0;
    for (;;) {
      assertNotAborted(params.signal);
      params.onProgress?.({
        phase: "fetching",
        fetchedRows,
        insertedRows,
      });

      const result = await executeSql(
        params.sourceConnection,
        params.sourceSql,
        pageSize,
        page * pageSize,
      );
      if (result.columns.length === 0) {
        break;
      }

      const records = rowsToRecord(result.columns, result.rows);
      fetchedRows += records.length;
      if (fetchedRows > hardLimit) {
        throw new Error(`ROW_LIMIT:${hardLimit}`);
      }

      const mappedRows = records.map((row) =>
        mapSourceRow(row, resolvedMatch.matched, constantFillEntries),
      );

      for (let i = 0; i < mappedRows.length; i += batchSize) {
        assertNotAborted(params.signal);
        const batch = mappedRows.slice(i, i + batchSize);
        const sql = buildInsertSql({
          dbType: params.targetConnection.db_type,
          tableName: params.targetTable,
          columns: insertColumns,
          rows: batch,
          mode: "merged",
        });
        if (!sql) continue;
        await executeSqlInSession(importSessionId, params.targetConnection, sql);
        insertedRows += batch.length;
        params.onProgress?.({
          phase: "inserting",
          fetchedRows,
          insertedRows,
        });
      }

      if (result.rows.length < pageSize) {
        break;
      }
      page += 1;
    }

    // 无清空且无写入时也需保证会话被关闭；有写入则提交
    if (insertedRows > 0 || params.clearBeforeImport) {
      assertNotAborted(params.signal);
      await commitImportSession(importSessionId);
      committed = true;
    }

    params.onProgress?.({
      phase: "done",
      fetchedRows,
      insertedRows,
    });

    return {
      fetchedRows,
      insertedRows,
      matchedColumns: insertColumns,
    };
  } catch (err) {
    if (!committed) {
      await rollbackImportSession(importSessionId);
    }
    throw err;
  } finally {
    await closeImportSession(importSessionId);
  }
}
