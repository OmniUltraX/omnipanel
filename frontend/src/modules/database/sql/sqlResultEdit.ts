import type { DbColumnMeta } from "../api";
import { isSameCellValue } from "../cell_editor/types";
import { extractTableRefsFromRegex } from "../sqlEditor/parser/analyzer";
import { escapeSqlLiteral } from "./escapeSqlLiteral";
import { quoteSqlIdent } from "../grid/tableDataGridCopySql";
import { readRowKeyValue } from "../workspace/dbWorkspaceTabHelpers";
import { resolvePreviewRowKey } from "../workspace/dbWorkspaceState";

export type SqlResultEditTarget = {
  schemaName?: string;
  tableName: string;
};

export type SqlResultEditColumns = {
  /** 结果列名上的元数据（主键标记用结果列名，便于网格按列 id 查找） */
  columnMeta: DbColumnMeta[];
  pkResultNames: string[];
  resultToTableName: Record<string, string>;
  columnTypeByResultName: Record<string, string>;
};

export type SqlResultDirtyRows = Record<string, Record<string, unknown>>;

/** 单表、无聚合的 SELECT 才能按主键写回。JOIN / DISTINCT / GROUP BY 保持只读。 */
export function resolveSqlResultEditTarget(sql: string): SqlResultEditTarget | null {
  const normalized = stripSqlComments(sql).trim().replace(/;+\s*$/u, "").trim();
  if (!normalized) return null;
  const scanned = maskSqlStrings(normalized);
  if (scanned.includes(";")) return null;
  if (!/^select\b/i.test(scanned)) return null;
  if (/\b(union|intersect|except|minus)\b/i.test(scanned)) return null;
  if (/\bgroup\s+by\b/i.test(scanned)) return null;
  if (/\bhaving\b/i.test(scanned)) return null;
  if (/\bjoin\b/i.test(scanned)) return null;
  if (/\bdistinct\b/i.test(scanned)) return null;
  if (/\binto\b/i.test(scanned)) return null;
  if (/\bfrom\s*\(/i.test(scanned)) return null;
  if (/\b(count|sum|avg|min|max|group_concat|json_arrayagg|json_objectagg)\s*\(/i.test(scanned)) {
    return null;
  }

  const refs = extractTableRefsFromRegex(normalized);
  if (refs.length !== 1) return null;
  const tableName = refs[0]?.tableName.trim();
  if (!tableName) return null;
  const schemaName = refs[0]?.schemaName?.trim();
  return schemaName ? { schemaName, tableName } : { tableName };
}

/** 结果列能对上表列，且主键都在结果里，才允许编辑。 */
export function matchSqlResultEditColumns(
  resultColumns: string[],
  tableColumns: DbColumnMeta[],
): SqlResultEditColumns | null {
  const tablePkCount = tableColumns.filter((column) => column.isPk).length;
  if (tablePkCount === 0) return null;

  const columnMeta: DbColumnMeta[] = [];
  const resultToTableName: Record<string, string> = {};
  const columnTypeByResultName: Record<string, string> = {};
  const usedTableNames = new Set<string>();

  for (const resultName of resultColumns) {
    const meta =
      tableColumns.find((column) => column.name === resultName) ??
      tableColumns.find((column) => column.name.toLowerCase() === resultName.toLowerCase());
    if (!meta || usedTableNames.has(meta.name)) continue;
    usedTableNames.add(meta.name);
    columnMeta.push({ ...meta, name: resultName });
    resultToTableName[resultName] = meta.name;
    columnTypeByResultName[resultName] = meta.type;
  }

  const pkResultNames = columnMeta.filter((column) => column.isPk).map((column) => column.name);
  if (pkResultNames.length !== tablePkCount) return null;
  return { columnMeta, pkResultNames, resultToTableName, columnTypeByResultName };
}

export function sqlResultCellDirty(
  dirty: SqlResultDirtyRows,
  row: Record<string, unknown>,
  pkResultNames: string[],
  column: string,
  value: unknown,
  baseValue?: unknown,
): SqlResultDirtyRows {
  const rowKey = resolvePreviewRowKey(
    row,
    pkResultNames.map((name) => ({ name })),
  );
  if (!rowKey) return dirty;
  const original = baseValue !== undefined ? baseValue : row[column];
  const next: SqlResultDirtyRows = { ...dirty };
  const rowDirty = { ...(next[rowKey] ?? {}) };
  if (isSameCellValue(original, value)) {
    delete rowDirty[column];
  } else {
    rowDirty[column] = value;
  }
  if (Object.keys(rowDirty).length === 0) {
    delete next[rowKey];
  } else {
    next[rowKey] = rowDirty;
  }
  return next;
}

export function mergeSqlResultOverrides(
  committed: SqlResultDirtyRows,
  dirty: SqlResultDirtyRows,
): SqlResultDirtyRows {
  const merged: SqlResultDirtyRows = { ...committed };
  for (const [rowKey, columns] of Object.entries(dirty)) {
    merged[rowKey] = { ...(merged[rowKey] ?? {}), ...columns };
  }
  return merged;
}

export function countSqlResultDirtyCells(dirty: SqlResultDirtyRows): number {
  let count = 0;
  for (const columns of Object.values(dirty)) {
    count += Object.keys(columns).length;
  }
  return count;
}

export function buildSqlResultUpdateStatements(opts: {
  dbType?: string;
  schemaName?: string;
  tableName: string;
  dirty: SqlResultDirtyRows;
  pkResultNames: string[];
  resultToTableName: Record<string, string>;
  columnTypeByResultName: Record<string, string>;
}): string[] {
  const {
    dbType,
    schemaName,
    tableName,
    dirty,
    pkResultNames,
    resultToTableName,
    columnTypeByResultName,
  } = opts;
  if (!tableName || pkResultNames.length === 0) return [];

  const tableSql = schemaName
    ? `${quoteSqlIdent(dbType, schemaName)}.${quoteSqlIdent(dbType, tableName)}`
    : quoteSqlIdent(dbType, tableName);
  const limit = isMysqlEngine(dbType) ? " LIMIT 1" : "";
  const statements: string[] = [];

  for (const [rowKey, changes] of Object.entries(dirty)) {
    const entries = Object.entries(changes);
    if (entries.length === 0) continue;
    const setClause = entries
      .map(([resultName, value]) => {
        const tableColumn = resultToTableName[resultName] ?? resultName;
        return `${quoteSqlIdent(dbType, tableColumn)} = ${escapeSqlLiteral(value, {
          dbType,
          columnType: columnTypeByResultName[resultName] ?? null,
        })}`;
      })
      .join(", ");
    const whereClause = pkResultNames
      .map((resultName) => {
        const tableColumn = resultToTableName[resultName] ?? resultName;
        const ident = quoteSqlIdent(dbType, tableColumn);
        const raw = readRowKeyValue(rowKey, resultName);
        if (raw === "") return `${ident} IS NULL`;
        return `${ident} = ${escapeSqlLiteral(raw, {
          dbType,
          columnType: columnTypeByResultName[resultName] ?? null,
        })}`;
      })
      .join(" AND ");
    statements.push(`UPDATE ${tableSql} SET ${setClause} WHERE ${whereClause}${limit}`);
  }

  return statements;
}

function isMysqlEngine(dbType: string | undefined): boolean {
  const type = (dbType ?? "mysql").toLowerCase();
  return type.includes("mysql") || type.includes("mariadb");
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function maskSqlStrings(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}
