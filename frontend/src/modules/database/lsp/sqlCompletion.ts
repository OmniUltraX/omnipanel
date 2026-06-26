import type { DatabaseSchema, TableSchema } from "../types";
import { filterAndRankByFuzzy } from "../../../lib/fuzzyMatch";
import { buildFunctionCompletionItems, type SqlFunctionCompletionContext } from "../sqlIntel/sqlFunctionCatalog";

interface CompletionItem {
  label: string;
  kind: number;
  insertText?: string;
  detail?: string;
  snippet?: boolean;
  boost?: number;
  info?: string;
}

const KEYWORD_KIND = 14;
const FUNCTION_KIND = 3;
const COLUMN_KIND = 5;
const TABLE_KIND = 22;
const DATABASE_KIND = 9;

const SQL_KEYWORDS: CompletionItem[] = [
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "INNER JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "ORDER BY",
  "GROUP BY",
  "HAVING",
  "LIMIT",
  "INSERT INTO",
  "UPDATE",
  "DELETE",
  "CREATE TABLE",
  "ALTER TABLE",
  "DROP TABLE",
  "UNION",
  "DISTINCT",
  "AND",
  "OR",
  "ON",
  "SET",
  "VALUES",
].map((label) => ({ label, kind: KEYWORD_KIND, insertText: `${label} `, detail: "SQL 关键字" }));

/** 补全上下文：按光标前 SQL 子句过滤关键字与 schema 项。 */
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

const STATEMENT_START_KEYWORDS = new Set([
  "SELECT",
  "INSERT INTO",
  "UPDATE",
  "DELETE",
  "CREATE TABLE",
  "ALTER TABLE",
  "DROP TABLE",
  "UNION",
  "WITH",
]);

const SELECT_LIST_KEYWORDS = new Set(["DISTINCT"]);

const FROM_CLAUSE_KEYWORDS = new Set([
  "WHERE",
  "INNER JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "JOIN",
  "GROUP BY",
  "ORDER BY",
  "LIMIT",
  "HAVING",
  "ON",
]);

const WHERE_CLAUSE_KEYWORDS = new Set(["AND", "OR", "ORDER BY", "GROUP BY", "LIMIT", "HAVING"]);

const GROUP_BY_KEYWORDS = new Set(["HAVING", "ORDER BY", "LIMIT"]);

const ORDER_BY_KEYWORDS = new Set(["LIMIT"]);

const DELETE_FROM_KEYWORDS = new Set(["FROM"]);

function lastIndexOfKeyword(text: string, keyword: string): number {
  const pattern = keyword.trim().split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
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

/** 根据光标位置推断当前 SQL 补全上下文。 */
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
  const idxJoin = Math.max(
    lastIndexOfKeyword(stmt, "INNER JOIN"),
    lastIndexOfKeyword(stmt, "LEFT JOIN"),
    lastIndexOfKeyword(stmt, "RIGHT JOIN"),
    lastIndexOfKeyword(stmt, "JOIN"),
  );

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
      if (idxJoin >= idxFrom) {
        return "from_clause";
      }
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

function allowedKeywordsForContext(context: SqlCompletionContext): Set<string> | null {
  switch (context) {
    case "statement_start":
      return STATEMENT_START_KEYWORDS;
    case "select_list":
      return SELECT_LIST_KEYWORDS;
    case "from_clause":
      return FROM_CLAUSE_KEYWORDS;
    case "where_clause":
      return WHERE_CLAUSE_KEYWORDS;
    case "group_by":
      return GROUP_BY_KEYWORDS;
    case "order_by":
      return ORDER_BY_KEYWORDS;
    case "delete_from":
      return DELETE_FROM_KEYWORDS;
    case "insert_into":
    case "update_table":
      return new Set<string>();
    case "general":
      return null;
    default:
      return null;
  }
}

function filterKeywordsByContext(items: CompletionItem[], context: SqlCompletionContext): CompletionItem[] {
  const allowed = allowedKeywordsForContext(context);
  if (allowed === null) {
    return items;
  }
  return items.filter((item) => allowed.has(item.label.toUpperCase()));
}

function includeFunctions(context: SqlCompletionContext): boolean {
  return (
    context === "select_list" ||
    context === "where_clause" ||
    context === "group_by" ||
    context === "order_by" ||
    context === "general"
  );
}

function includeColumns(context: SqlCompletionContext): boolean {
  return (
    context === "select_list" ||
    context === "where_clause" ||
    context === "group_by" ||
    context === "order_by" ||
    context === "general"
  );
}

function includeTables(context: SqlCompletionContext): boolean {
  return (
    context === "statement_start" ||
    context === "from_clause" ||
    context === "insert_into" ||
    context === "update_table" ||
    context === "delete_from" ||
    context === "general"
  );
}

function includeDatabases(context: SqlCompletionContext): boolean {
  return context === "general" || context === "statement_start";
}

function findDatabaseByName(schemas: DatabaseSchema[], name: string): DatabaseSchema | undefined {
  const key = name.toLowerCase();
  return schemas.find((db) => db.name.toLowerCase() === key);
}

function findTableByName(
  database: DatabaseSchema | undefined,
  name: string,
): TableSchema | undefined {
  if (!database) {
    return undefined;
  }
  const key = name.toLowerCase();
  return database.tables.find((table) => table.name.toLowerCase() === key);
}

function findTableInSchemas(
  schemas: DatabaseSchema[],
  tableName: string,
  databaseName?: string,
): { table: TableSchema; qualifiedTable: string } | null {
  if (databaseName) {
    const database = findDatabaseByName(schemas, databaseName);
    const table = findTableByName(database, tableName);
    if (table && database) {
      return { table, qualifiedTable: `${database.name}.${table.name}` };
    }
    return null;
  }

  for (const database of schemas) {
    const table = findTableByName(database, tableName);
    if (table) {
      return { table, qualifiedTable: table.name };
    }
  }
  return null;
}

/** 从当前语句的 FROM 子句解析主表（支持光标在 SELECT 列表、FROM 写在后面的情况）。 */
export function resolveFromTableInStatement(
  text: string,
  offset: number,
  schemas: DatabaseSchema[],
): { table: TableSchema; qualifiedTable: string } | null {
  const stmtStart = text.lastIndexOf(";", offset - 1) + 1;
  const stmtEnd = text.indexOf(";", offset);
  const statement = text.slice(stmtStart, stmtEnd >= 0 ? stmtEnd : text.length);
  const fromMatch = statement.match(/\bFROM\s+(?:(\w+)\.)?(\w+)\b/i);
  if (!fromMatch) {
    return null;
  }
  const databaseName = fromMatch[1];
  const tableName = fromMatch[2];
  return findTableInSchemas(schemas, tableName, databaseName);
}

function buildAllColumnsCompletionItem(
  table: TableSchema,
  qualifiedTable: string,
): CompletionItem | null {
  if (table.columns.length === 0) {
    return null;
  }
  const insertText = table.columns.map((column) => column.name).join(", ");
  const label =
    insertText.length > 96 ? `${insertText.slice(0, 93)}...` : insertText;
  return {
    label,
    kind: COLUMN_KIND,
    insertText,
    detail: `全部字段 · ${qualifiedTable}`,
    boost: 100,
  };
}

function currentPrefix(text: string, offset: number) {
  const before = text.slice(0, offset);
  const line = before.split("\n").pop() ?? "";
  return line.match(/(\w+)$/)?.[1] ?? "";
}

/** IS / NOT 谓词尾部：此位置只应补关键字（如 NULL），不应出现字段名。 */
export type IsNotCompletionTail = "is" | "is_not" | "not" | null;

export function resolveIsNotCompletionTail(text: string, offset: number): IsNotCompletionTail {
  const before = currentStatementBefore(text, offset);
  const linePrefix = before.split("\n").pop() ?? before;
  const trimmed = linePrefix.trimEnd();
  if (/\bIS\s+NOT\s*$/i.test(trimmed)) {
    return "is_not";
  }
  if (/\bIS\s*$/i.test(trimmed)) {
    return "is";
  }
  if (/\bNOT\s*$/i.test(trimmed)) {
    return "not";
  }
  return null;
}

function buildIsNotTailCompletions(tail: Exclude<IsNotCompletionTail, null>): CompletionItem[] {
  const nullItem: CompletionItem = {
    label: "NULL",
    kind: KEYWORD_KIND,
    insertText: "NULL",
    detail: "SQL 关键字",
  };
  if (tail === "is") {
    return [
      nullItem,
      {
        label: "NOT",
        kind: KEYWORD_KIND,
        insertText: "NOT NULL",
        detail: "SQL 关键字",
      },
    ];
  }
  if (tail === "is_not") {
    return [nullItem];
  }
  return [
    nullItem,
    { label: "IN", kind: KEYWORD_KIND, insertText: "IN ()", detail: "SQL 关键字" },
    { label: "LIKE", kind: KEYWORD_KIND, insertText: "LIKE ", detail: "SQL 关键字" },
    { label: "EXISTS", kind: KEYWORD_KIND, insertText: "EXISTS ()", detail: "SQL 关键字" },
    { label: "BETWEEN", kind: KEYWORD_KIND, insertText: "BETWEEN ", detail: "SQL 关键字" },
  ];
}

function filterItems(items: CompletionItem[], prefix: string): CompletionItem[] {
  if (!prefix) return items;
  return filterAndRankByFuzzy(items, prefix);
}

export function buildDatabaseSchema(databaseName: string, tables: TableSchema[]): DatabaseSchema {
  return { name: databaseName, tables };
}

/** 表名后的快捷片段：select / count / update / insert */
export function buildTableActionSnippets(
  qualifiedTable: string,
  table: TableSchema,
  whereClause?: string,
): CompletionItem[] {
  const cols = table.columns.map((c) => c.name);
  const selectCols = cols.length > 0 ? cols.join(", ") : "*";
  const insertColList = cols.length > 0 ? cols.join(", ") : "column1, column2";
  const insertValues =
    cols.length > 0
      ? cols.map((c, i) => `\${${i + 1}:${c}}`).join(", ")
      : "${1:value1}, ${2:value2}";
  const setClause =
    cols.length > 0
      ? cols.map((c, i) => `${c} = \${${i + 1}}`).join(",\n  ")
      : "${1:column} = ${2:value}";

  const whereText = whereClause?.trim();
  const wherePart = whereText || "${1:1=1}";
  const whereIsPlaceholder = !whereText;

  return [
    {
      label: "select",
      kind: KEYWORD_KIND,
      detail: "生成 SELECT 查询",
      insertText: `SELECT ${selectCols}\nFROM ${qualifiedTable}\nWHERE ${wherePart};`,
      snippet: whereIsPlaceholder,
    },
    {
      label: "count",
      kind: FUNCTION_KIND,
      detail: "生成 COUNT 统计",
      insertText: whereText
        ? `SELECT COUNT(*) AS total\nFROM ${qualifiedTable}\nWHERE ${whereText};`
        : `SELECT COUNT(*) AS total\nFROM ${qualifiedTable};`,
    },
    {
      label: "update",
      kind: KEYWORD_KIND,
      detail: "生成 UPDATE 语句",
      insertText: whereText
        ? `UPDATE ${qualifiedTable}\nSET ${setClause}\nWHERE ${whereText};`
        : `UPDATE ${qualifiedTable}\nSET ${setClause}\nWHERE \${${cols.length > 0 ? cols.length + 1 : 3}:1=1};`,
      snippet: true,
    },
    {
      label: "insert",
      kind: KEYWORD_KIND,
      detail: "生成 INSERT 语句",
      insertText: `INSERT INTO ${qualifiedTable} (${insertColList})\nVALUES (${insertValues});`,
      snippet: true,
    },
    {
      label: "delete",
      kind: KEYWORD_KIND,
      detail: "生成 DELETE 语句",
      insertText: `DELETE FROM ${qualifiedTable}\nWHERE ${wherePart};`,
      snippet: whereIsPlaceholder,
    },
  ];
}

export function introspectToTableSchemas(
  tables: { name: string; columns: { name: string; type: string; isPk?: boolean; isFk?: boolean }[] }[],
  kind: TableSchema["kind"] = "table",
): TableSchema[] {
  return tables.map((table) => ({
    name: table.name,
    kind,
    columns: table.columns.map((col) => ({
      name: col.name,
      type: col.type,
      isPK: col.isPk,
      isFK: col.isFk,
    })),
  }));
}

function tableMatchesFromContext(
  database: DatabaseSchema,
  table: TableSchema,
  fromTable: { table: TableSchema; qualifiedTable: string },
): boolean {
  const qualified = `${database.name}.${table.name}`;
  if (fromTable.qualifiedTable.includes(".")) {
    return qualified.toLowerCase() === fromTable.qualifiedTable.toLowerCase();
  }
  return table.name.toLowerCase() === fromTable.table.name.toLowerCase();
}

export function getCompletionItems(
  text: string,
  offset: number,
  schemas: DatabaseSchema[],
  dbType?: string | null,
): CompletionItem[] {
  const prefix = currentPrefix(text, offset);
  const isNotTail = resolveIsNotCompletionTail(text, offset);
  if (isNotTail) {
    return filterItems(buildIsNotTailCompletions(isNotTail), prefix);
  }

  const context = resolveSqlCompletionContext(text, offset);
  const fromTable =
    context === "select_list" ? resolveFromTableInStatement(text, offset, schemas) : null;
  const databases: CompletionItem[] = [];
  const tables: CompletionItem[] = [];
  const columns: CompletionItem[] = [];

  for (const database of schemas) {
    if (includeDatabases(context)) {
      databases.push({
        label: database.name,
        kind: DATABASE_KIND,
        detail: `数据库 · ${database.tables.length} 表`,
        insertText: database.name,
      });
    }

    for (const table of database.tables) {
      if (includeTables(context)) {
        const tableBoost = context === "statement_start" ? 60 : undefined;
        tables.push({
          label: table.name,
          kind: TABLE_KIND,
          detail: `${table.kind === "view" ? "视图" : "表"} · ${database.name}`,
          insertText: table.name,
          boost: tableBoost,
        });
        tables.push({
          label: `${database.name}.${table.name}`,
          kind: TABLE_KIND,
          detail: `${table.kind === "view" ? "视图" : "表"} · ${database.name}`,
          insertText: `${database.name}.${table.name}`,
          boost: tableBoost,
        });
      }

      if (includeColumns(context)) {
        if (fromTable && !tableMatchesFromContext(database, table, fromTable)) {
          continue;
        }

        for (const column of table.columns) {
          columns.push({
            label: column.name,
            kind: COLUMN_KIND,
            detail: `${column.type} · ${table.name}`,
            insertText: column.name,
          });
          columns.push({
            label: `${table.name}.${column.name}`,
            kind: COLUMN_KIND,
            detail: `${column.type} · ${table.name}`,
            insertText: `${table.name}.${column.name}`,
          });
          columns.push({
            label: `${database.name}.${table.name}.${column.name}`,
            kind: COLUMN_KIND,
            detail: `${column.type} · ${database.name}.${table.name}`,
            insertText: `${database.name}.${table.name}.${column.name}`,
          });
        }
      }
    }
  }

  const keywords = filterKeywordsByContext(SQL_KEYWORDS, context);
  const functions = includeFunctions(context)
    ? buildFunctionCompletionItems(dbType, context as SqlFunctionCompletionContext)
    : [];
  const allColumnsItem =
    fromTable && !prefix
      ? buildAllColumnsCompletionItem(fromTable.table, fromTable.qualifiedTable)
      : null;
  const merged = [
    ...(allColumnsItem ? [allColumnsItem] : []),
    ...keywords,
    ...functions,
    ...databases,
    ...tables,
    ...columns,
  ];
  return filterItems(merged, prefix);
}
