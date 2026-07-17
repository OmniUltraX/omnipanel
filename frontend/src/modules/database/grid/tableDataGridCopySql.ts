import { formatCellValue } from "../cell_editor/types";
import type { DbColumnMeta } from "../api";

function isMysqlEngine(dbType: string | undefined): boolean {
  const t = (dbType ?? "mysql").toLowerCase();
  return t.includes("mysql") || t.includes("mariadb");
}

function isPostgresEngine(dbType: string | undefined): boolean {
  const t = (dbType ?? "").toLowerCase();
  return t.includes("postgres") || t === "pg";
}

function isSqlServerEngine(dbType: string | undefined): boolean {
  const t = (dbType ?? "").toLowerCase();
  return t.includes("sqlserver") || t.includes("mssql");
}

export function quoteSqlIdent(dbType: string | undefined, name: string): string {
  if (isPostgresEngine(dbType)) {
    return `"${name.replace(/"/g, '""')}"`;
  }
  if (isSqlServerEngine(dbType)) {
    return `[${name.replace(/]/g, "]]")}]`;
  }
  return `\`${name.replace(/`/g, "``")}\``;
}

export function formatSqlLiteral(value: unknown, dbType?: string): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") {
    if (isPostgresEngine(dbType)) return value ? "TRUE" : "FALSE";
    return value ? "1" : "0";
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.__omni === "blob") return "NULL";
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
  const text = String(value);
  if (isMysqlEngine(dbType)) {
    return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  return `'${text.replace(/'/g, "''")}'`;
}

export function buildRowsJson(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows, null, 2);
}

export function buildColumnNamesText(columns: string[]): string {
  return columns.join("\t");
}

export function resolveCopyColumns(
  columns: string[],
  columnMeta: DbColumnMeta[] | undefined,
  excludePk: boolean,
): string[] {
  if (!excludePk || !columnMeta?.length) return columns;
  const pkNames = new Set(columnMeta.filter((c) => c.isPk).map((c) => c.name));
  return columns.filter((name) => !pkNames.has(name));
}

export function buildInsertSql(opts: {
  dbType?: string;
  tableName: string;
  columns: string[];
  rows: Record<string, unknown>[];
  mode: "merged" | "perRow";
}): string {
  const { dbType, tableName, columns, rows, mode } = opts;
  if (!tableName || columns.length === 0 || rows.length === 0) return "";

  const table = quoteSqlIdent(dbType, tableName);
  const colList = columns.map((c) => quoteSqlIdent(dbType, c)).join(", ");

  if (mode === "merged") {
    const values = rows
      .map(
        (row) =>
          `(${columns.map((col) => formatSqlLiteral(row[col], dbType)).join(", ")})`,
      )
      .join(",\n");
    return `INSERT INTO ${table} (${colList}) VALUES\n${values};`;
  }

  return rows
    .map((row) => {
      const vals = columns.map((col) => formatSqlLiteral(row[col], dbType)).join(", ");
      return `INSERT INTO ${table} (${colList}) VALUES (${vals});`;
    })
    .join("\n");
}

export function buildUpdateSql(opts: {
  dbType?: string;
  tableName: string;
  columns: string[];
  rows: Record<string, unknown>[];
  pkCols: { name: string }[];
}): string {
  const { dbType, tableName, columns, rows, pkCols } = opts;
  if (!tableName || rows.length === 0 || pkCols.length === 0) return "";

  const table = quoteSqlIdent(dbType, tableName);
  const dataCols = columns.filter((c) => !pkCols.some((pk) => pk.name === c));
  if (dataCols.length === 0) return "";

  return rows
    .map((row) => {
      const setClause = dataCols
        .map((col) => `${quoteSqlIdent(dbType, col)} = ${formatSqlLiteral(row[col], dbType)}`)
        .join(", ");
      const whereClause = pkCols
        .map((pk) => {
          const v = row[pk.name];
          if (v === null || v === undefined) {
            return `${quoteSqlIdent(dbType, pk.name)} IS NULL`;
          }
          return `${quoteSqlIdent(dbType, pk.name)} = ${formatSqlLiteral(v, dbType)}`;
        })
        .join(" AND ");
      return `UPDATE ${table} SET ${setClause} WHERE ${whereClause};`;
    })
    .join("\n");
}

export function formatCellCopyText(value: unknown): string {
  return formatCellValue(value);
}

export function compareCellValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
  const sa = String(a);
  const sb = String(b);
  const na = Number(sa);
  const nb = Number(sb);
  if (sa.trim() !== "" && sb.trim() !== "" && Number.isFinite(na) && Number.isFinite(nb)) {
    return na - nb;
  }
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: "base" });
}
