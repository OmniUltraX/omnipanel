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

/** 生成清空表 SQL（SQLite 用不支持 TRUNCATE 的 DELETE）。 */
export function buildClearTableSql(
  dbType: string | undefined,
  tableName: string,
): string {
  const table = quoteSqlIdent(dbType, tableName);
  if (isSqliteEngine(dbType)) {
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

/** 按 limit/offset 分页拉取查询全部结果行。 */
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

/** 将查询结果按同名列导入目标表。 */
export async function importQueryResultToTable(
  params: ImportToTableParams,
): Promise<ImportToTableResult> {
  const hardLimit = params.hardLimit ?? IMPORT_TO_TABLE_ROW_HARD_LIMIT;
  const batchSize = params.batchSize ?? IMPORT_TO_TABLE_BATCH_SIZE;

  params.onProgress?.({
    phase: "fetching",
    fetchedRows: 0,
    insertedRows: 0,
  });

  const fetched = await fetchAllQueryResultRows({
    connection: params.sourceConnection,
    sql: params.sourceSql,
    pageSize: params.pageSize,
    hardLimit,
    signal: params.signal,
    onProgress: (fetchedRows) => {
      params.onProgress?.({
        phase: "fetching",
        fetchedRows,
        insertedRows: 0,
      });
    },
  });

  const sourceColumns =
    params.sourceColumns?.length ? params.sourceColumns : fetched.columns;
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
  const mappedRows = fetched.rows.map((row) => {
    const next: Record<string, unknown> = {};
    for (const { source, target } of resolvedMatch.matched) {
      next[target] = row[source];
    }
    for (const { target, value } of constantFillEntries) {
      next[target] = value;
    }
    return next;
  });

  if (params.clearBeforeImport) {
    assertNotAborted(params.signal);
    params.onProgress?.({
      phase: "clearing",
      fetchedRows: mappedRows.length,
      insertedRows: 0,
    });
    await executeSql(
      params.targetConnection,
      buildClearTableSql(params.targetConnection.db_type, params.targetTable),
    );
  }

  let insertedRows = 0;
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
    await executeSql(params.targetConnection, sql);
    insertedRows += batch.length;
    params.onProgress?.({
      phase: "inserting",
      fetchedRows: mappedRows.length,
      insertedRows,
    });
  }

  params.onProgress?.({
    phase: "done",
    fetchedRows: mappedRows.length,
    insertedRows,
  });

  return {
    fetchedRows: mappedRows.length,
    insertedRows,
    matchedColumns: insertColumns,
  };
}
