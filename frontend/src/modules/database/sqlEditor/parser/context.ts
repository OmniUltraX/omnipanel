import type { DatabaseSchema, TableSchema } from "../../types";
import type { Catalog } from "../catalog";
import { Catalog as CatalogClass } from "../catalog";
import { analyzeStatement, analyzeStatementAtOffset, resolvePrimaryFromTable, resolveTableByAlias } from "./analyzer";
import { sliceStatementAtOffset, statementOffsetAtPos } from "./ast";

export type SqlCompletionContext =
  | "statement_start"
  | "select_list"
  | "from_clause"
  | "where_clause"
  | "group_by"
  | "order_by"
  | "insert_into"
  | "update_table"
  | "delete_from"
  | "general";

function lastIndexOfKeyword(text: string, keyword: string): number {
  const pattern = keyword
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const re = new RegExp(`\\b${pattern}\\b`, "gi");
  let last = -1;
  for (const match of text.matchAll(re)) {
    last = match.index ?? -1;
  }
  return last;
}

function currentStatementBefore(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const start = before.lastIndexOf(";") + 1;
  return before.slice(start);
}

/** 根据光标位置推断 SQL 补全上下文（Clause 级；Parser 用于表/别名解析）。 */
export function resolveSqlCompletionContext(text: string, offset: number): SqlCompletionContext {
  const stmt = currentStatementBefore(text, offset);
  if (!stmt.trim()) {
    return "statement_start";
  }

  const idxSelect = lastIndexOfKeyword(stmt, "SELECT");
  const idxFrom = lastIndexOfKeyword(stmt, "FROM");
  const idxWhere = lastIndexOfKeyword(stmt, "WHERE");
  const idxGroup = lastIndexOfKeyword(stmt, "GROUP BY");
  const idxOrder = lastIndexOfKeyword(stmt, "ORDER BY");
  const idxInsert = lastIndexOfKeyword(stmt, "INSERT INTO");
  const idxUpdate = lastIndexOfKeyword(stmt, "UPDATE");
  const idxDelete = lastIndexOfKeyword(stmt, "DELETE");
  const idxSet = lastIndexOfKeyword(stmt, "SET");

  if (/^\s*(CREATE|ALTER|DROP)\b/i.test(stmt.trim())) {
    return "general";
  }

  if (idxInsert >= 0 && (idxSelect < 0 || idxInsert > idxSelect)) {
    return "insert_into";
  }

  if (idxDelete >= 0 && (idxSelect < 0 || idxDelete > idxSelect)) {
    if (idxFrom < 0 || idxFrom < idxDelete) {
      return "delete_from";
    }
    if (idxWhere < 0 || idxWhere < idxFrom) {
      return "from_clause";
    }
    return "where_clause";
  }

  if (idxUpdate >= 0 && (idxSelect < 0 || idxUpdate > idxSelect)) {
    if (idxSet < 0 || idxSet < idxUpdate) {
      return "update_table";
    }
    return "where_clause";
  }

  if (idxSelect >= 0 && (idxFrom < 0 || idxFrom < idxSelect)) {
    return "select_list";
  }

  if (idxFrom >= 0) {
    if (idxWhere < 0 || idxWhere < idxFrom) {
      return "from_clause";
    }
  }

  if (idxWhere >= 0) {
    if (idxGroup >= 0 && idxGroup > idxWhere && (idxOrder < 0 || idxOrder < idxGroup)) {
      return "group_by";
    }
    if (idxOrder >= 0 && idxOrder > idxWhere) {
      return "order_by";
    }
    return "where_clause";
  }

  if (idxGroup >= 0) {
    return "group_by";
  }

  if (idxOrder >= 0) {
    return "order_by";
  }

  return "statement_start";
}

function resolveFromTableRegex(
  statement: string,
  catalog: Catalog,
): { table: TableSchema; qualifiedTable: string } | null {
  const fromMatch = statement.match(/\bFROM\s+(?:(\w+)\.)?(\w+)\b/i);
  if (!fromMatch) return null;
  const resolved = catalog.findTable(fromMatch[2], fromMatch[1]);
  if (!resolved) return null;
  return {
    table: resolved.table as TableSchema,
    qualifiedTable: resolved.qualifiedTable,
  };
}

/** 解析当前语句的主表：优先 AST，回退正则。 */
export function resolveFromTableInStatement(
  text: string,
  offset: number,
  schemas: DatabaseSchema[],
  dbType?: string | null,
): { table: TableSchema; qualifiedTable: string } | null {
  const catalog = CatalogClass.fromSchemas(schemas);
  const statement = sliceStatementAtOffset(text, offset).trim();
  if (!statement) return null;

  const offsetInStatement = statementOffsetAtPos(text, offset);
  const analysis = analyzeStatementAtOffset(statement, offsetInStatement, dbType);
  if (analysis) {
    const resolved = resolvePrimaryFromTable(catalog, analysis);
    if (resolved) {
      return { table: resolved.table as TableSchema, qualifiedTable: resolved.qualifiedTable };
    }
  }

  return resolveFromTableRegex(statement, catalog);
}

/** 解析 `alias.` 前缀对应的表（Parser 别名映射）。 */
export function resolveAliasTableInStatement(
  text: string,
  offset: number,
  alias: string,
  schemas: DatabaseSchema[],
  dbType?: string | null,
): { table: TableSchema; qualifiedTable: string } | null {
  const catalog = CatalogClass.fromSchemas(schemas);
  const statement = sliceStatementAtOffset(text, offset).trim();
  const offsetInStatement = statementOffsetAtPos(text, offset);
  const analysis = analyzeStatementAtOffset(statement, offsetInStatement, dbType);
  if (!analysis) {
    const direct = catalog.findTable(alias);
    return direct ? { table: direct.table as TableSchema, qualifiedTable: direct.qualifiedTable } : null;
  }
  const resolved = resolveTableByAlias(catalog, analysis, alias);
  if (resolved) {
    return { table: resolved.table as TableSchema, qualifiedTable: resolved.qualifiedTable };
  }
  const direct = catalog.findTable(alias);
  return direct ? { table: direct.table as TableSchema, qualifiedTable: direct.qualifiedTable } : null;
}
