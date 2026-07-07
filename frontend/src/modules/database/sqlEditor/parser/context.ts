import type { DatabaseSchema, TableSchema } from "../../types";
import { stripSqlStringLiterals } from "../../sqlIntel/sqlCompletionPosition";
import type { Catalog } from "../catalog";
import { Catalog as CatalogClass } from "../catalog";
import { analyzeStatementAtOffset, resolvePrimaryFromTable, resolveTableByAlias } from "./analyzer";
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
  | "update_set"
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
  const stmt = stripSqlStringLiterals(currentStatementBefore(text, offset));
  const trimmed = stmt.trim();
  if (!trimmed) {
    return "statement_start";
  }

  if (/^\s*(CREATE|ALTER|DROP)\b/i.test(trimmed)) {
    return "general";
  }

  const idxInsert = lastIndexOfKeyword(stmt, "INSERT INTO");
  const idxUpdate = lastIndexOfKeyword(stmt, "UPDATE");
  const idxDelete = lastIndexOfKeyword(stmt, "DELETE");
  const idxSelect = lastIndexOfKeyword(stmt, "SELECT");
  const idxSet = lastIndexOfKeyword(stmt, "SET");

  if (idxInsert >= 0 && (idxSelect < 0 || idxInsert > idxSelect)) {
    return "insert_into";
  }

  if (idxUpdate >= 0 && (idxSelect < 0 || idxUpdate > idxSelect)) {
    if (idxSet < 0 || idxSet < idxUpdate) {
      return "update_table";
    }
    const idxWhere = lastIndexOfKeyword(stmt, "WHERE");
    if (idxWhere >= 0 && idxWhere > idxSet) {
      return "where_clause";
    }
    return "update_set";
  }

  if (idxDelete >= 0 && (idxSelect < 0 || idxDelete > idxSelect)) {
    const idxFrom = lastIndexOfKeyword(stmt, "FROM");
    if (idxFrom < 0 || idxFrom < idxDelete) {
      return "delete_from";
    }
  }

  const clauseMarkers: Array<{ keyword: string; context: SqlCompletionContext }> = [
    { keyword: "ORDER BY", context: "order_by" },
    { keyword: "GROUP BY", context: "group_by" },
    { keyword: "WHERE", context: "where_clause" },
    { keyword: "FROM", context: "from_clause" },
    { keyword: "SELECT", context: "select_list" },
  ];

  let active: { index: number; context: SqlCompletionContext } | null = null;
  for (const marker of clauseMarkers) {
    const index = lastIndexOfKeyword(stmt, marker.keyword);
    if (index < 0) {
      continue;
    }
    if (!active || index >= active.index) {
      active = { index, context: marker.context };
    }
  }

  return active?.context ?? "statement_start";
}

function resolveFromTableRegex(
  statement: string,
  catalog: Catalog,
): { table: TableSchema; qualifiedTable: string } | null {
  const fromMatch = statement.match(/\bFROM\s+(?:(\w+)\.)?(\w+)\b/i);
  if (fromMatch) {
    const resolved = catalog.findTable(fromMatch[2], fromMatch[1]);
    if (resolved) {
      return {
        table: resolved.table as TableSchema,
        qualifiedTable: resolved.qualifiedTable,
      };
    }
  }

  const updateMatch = statement.match(
    /\bUPDATE\s+((?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?)(?:\s+(?:AS\s+)?[`"]?[\w$]+[`"]?)?/i,
  );
  if (updateMatch) {
    const token = updateMatch[1].replace(/^[`"]|[`"]$/g, "");
    const dot = token.lastIndexOf(".");
    const schemaName = dot >= 0 ? token.slice(0, dot).replace(/^[`"]|[`"]$/g, "") : undefined;
    const tableName = dot >= 0 ? token.slice(dot + 1).replace(/^[`"]|[`"]$/g, "") : token;
    const resolved = catalog.findTable(tableName, schemaName);
    if (resolved) {
      return {
        table: resolved.table as TableSchema,
        qualifiedTable: resolved.qualifiedTable,
      };
    }
  }

  const deleteMatch = statement.match(
    /\bDELETE\s+FROM\s+((?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?)/i,
  );
  if (deleteMatch) {
    const token = deleteMatch[1].replace(/^[`"]|[`"]$/g, "");
    const dot = token.lastIndexOf(".");
    const schemaName = dot >= 0 ? token.slice(0, dot).replace(/^[`"]|[`"]$/g, "") : undefined;
    const tableName = dot >= 0 ? token.slice(dot + 1).replace(/^[`"]|[`"]$/g, "") : token;
    const resolved = catalog.findTable(tableName, schemaName);
    if (resolved) {
      return {
        table: resolved.table as TableSchema,
        qualifiedTable: resolved.qualifiedTable,
      };
    }
  }

  return null;
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
