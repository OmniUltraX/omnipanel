/** 表对象右键菜单用的 SQL 片段（重命名、截断、生成语句、带数据复制）。 */

import { buildSelectAllFromTableSql } from "../grid/tablePreviewFilter";
import { canonicalHostEngine, catalogFamily } from "../hostCapabilities";
import { buildCloneTableSql } from "./tableCloneSql";

export type GeneratedTableSqlKind = "select" | "insert" | "update" | "delete";

export type TableColumnHint = {
  name: string;
  isPk?: boolean;
};

function isSqlEngine(dbType: string): boolean {
  return catalogFamily(dbType) !== "nonSql";
}

function isMysqlFamily(dbType: string): boolean {
  return catalogFamily(dbType) === "mysqlLike";
}

function isSqlite(dbType: string): boolean {
  return canonicalHostEngine(dbType) === "sqlite";
}

function isSqlServer(dbType: string): boolean {
  return canonicalHostEngine(dbType) === "sqlserver";
}

function quoteIdent(dbType: string, name: string): string {
  const family = catalogFamily(dbType);
  const engine = canonicalHostEngine(dbType);
  if (
    family === "postgresLike" ||
    family === "oracleLike" ||
    engine === "postgres" ||
    engine === "oracle"
  ) {
    return `"${name.replace(/"/g, '""')}"`;
  }
  if (engine === "sqlserver") {
    return `[${name.replace(/]/g, "]]")}]`;
  }
  return `\`${name.replace(/`/g, "``")}\``;
}

function tableRef(dbType: string, dbName: string, tableName: string): string {
  const table = quoteIdent(dbType, tableName);
  const db = dbName.trim();
  if (!db) return table;
  if (isMysqlFamily(dbType) || catalogFamily(dbType) === "hiveLike") {
    return `${quoteIdent(dbType, db)}.${table}`;
  }
  if (canonicalHostEngine(dbType) === "oracle" || catalogFamily(dbType) === "oracleLike") {
    return `${quoteIdent(dbType, db)}.${table}`;
  }
  return table;
}

export function buildGeneratedTableSql(
  dbType: string,
  tableName: string,
  columns: TableColumnHint[] | null,
  kind: GeneratedTableSqlKind,
): string | null {
  if (!isSqlEngine(dbType)) return null;
  if (kind === "select") {
    return buildSelectAllFromTableSql(dbType, tableName);
  }
  const table = quoteIdent(dbType, tableName);
  const cols = (columns ?? []).map((col) => col.name.trim()).filter(Boolean);
  const pk = columns?.find((col) => col.isPk && col.name.trim())?.name.trim();

  if (kind === "insert") {
    if (cols.length === 0) {
      return `INSERT INTO ${table} () VALUES ();`;
    }
    const list = cols.map((name) => quoteIdent(dbType, name)).join(", ");
    const values = cols.map(() => "?").join(", ");
    return `INSERT INTO ${table} (${list}) VALUES (${values});`;
  }

  if (kind === "update") {
    const targets = cols.length > 0 ? cols : ["column"];
    const sets = targets.map((name) => `${quoteIdent(dbType, name)} = ?`).join(", ");
    const where = pk ? `${quoteIdent(dbType, pk)} = ?` : "/* WHERE */";
    return `UPDATE ${table} SET ${sets} WHERE ${where};`;
  }

  const where = pk ? `${quoteIdent(dbType, pk)} = ?` : "/* WHERE */";
  return `DELETE FROM ${table} WHERE ${where};`;
}

export function buildRenameTableSql(
  dbType: string,
  dbName: string,
  fromTable: string,
  toTable: string,
): string | null {
  if (!isSqlEngine(dbType)) return null;
  const from = fromTable.trim();
  const to = toTable.trim();
  if (!from || !to) return null;
  if (isSqlServer(dbType)) {
    const schema = dbName.trim() ? `${dbName.trim()}.dbo.${from}` : `dbo.${from}`;
    return `EXEC sp_rename N'${schema.replace(/'/g, "''")}', N'${to.replace(/'/g, "''")}'`;
  }
  if (isMysqlFamily(dbType) || catalogFamily(dbType) === "hiveLike") {
    return `RENAME TABLE ${tableRef(dbType, dbName, from)} TO ${tableRef(dbType, dbName, to)}`;
  }
  return `ALTER TABLE ${tableRef(dbType, dbName, from)} RENAME TO ${quoteIdent(dbType, to)}`;
}

export function buildTruncateTableSql(dbType: string, dbName: string, tableName: string): string | null {
  if (!isSqlEngine(dbType) || isSqlite(dbType)) return null;
  const name = tableName.trim();
  if (!name) return null;
  return `TRUNCATE TABLE ${tableRef(dbType, dbName, name)}`;
}

export function buildClearTableDataSql(dbType: string, dbName: string, tableName: string): string | null {
  if (!isSqlEngine(dbType)) return null;
  const name = tableName.trim();
  if (!name) return null;
  return `DELETE FROM ${tableRef(dbType, dbName, name)}`;
}

export function buildSetAutoIncrementSql(
  dbType: string,
  dbName: string,
  tableName: string,
  start: number,
): string | null {
  if (!isMysqlFamily(dbType)) return null;
  if (!Number.isInteger(start) || start < 1) return null;
  const name = tableName.trim();
  if (!name) return null;
  return `ALTER TABLE ${tableRef(dbType, dbName, name)} AUTO_INCREMENT = ${start}`;
}

export function buildCopyTableStatements(
  dbType: string,
  dbName: string,
  sourceTable: string,
  targetTable: string,
): { createSql: string; insertSql: string } | null {
  const createSql = buildCloneTableSql(dbType, dbName, sourceTable, targetTable);
  if (!createSql) return null;
  const source = sourceTable.trim();
  const target = targetTable.trim();
  if (!source || !target) return null;
  const insertSql = `INSERT INTO ${tableRef(dbType, dbName, target)} SELECT * FROM ${tableRef(dbType, dbName, source)}`;
  return { createSql, insertSql };
}

/** 表名：去掉空白，拒绝引号、分号和点号，避免拼进标识符。 */
export function isSafeTableIdentifier(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 128) return false;
  return !/['"`;\\\s.]/u.test(trimmed);
}
