import type { DatabaseSchema, TableSchema } from "../../types";
import { filterAndRankByFuzzy } from "../../../../lib/fuzzyMatch";
import { buildFunctionCompletionItems, type SqlFunctionCompletionContext } from "../../sqlIntel/sqlFunctionCatalog";
import { Catalog } from "../catalog";
import {
  analyzeStatement,
  qualifiersForTableRef,
  type StatementAnalysis,
} from "../parser/analyzer";
import { sliceStatementAtOffset } from "../parser/ast";
import {
  resolveSqlCompletionContext,
  resolveFromTableInStatement,
  type SqlCompletionContext,
} from "../parser/context";
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

/** 补全列表类型顺序：字段 → 表/库 → 函数 → 关键字 */
const COMPLETION_KIND_TIER: Record<number, number> = {
  [COLUMN_KIND]: 0,
  [TABLE_KIND]: 1,
  [DATABASE_KIND]: 1,
  [FUNCTION_KIND]: 2,
  [KEYWORD_KIND]: 3,
};

const KIND_TIER_BOOST_STEP = 10_000;

function completionKindTier(kind: number): number {
  return COMPLETION_KIND_TIER[kind] ?? 4;
}

function tierBoostForKind(kind: number): number {
  return (3 - completionKindTier(kind)) * KIND_TIER_BOOST_STEP;
}

export { tierBoostForKind, COLUMN_KIND };

function sortCompletionsByKind(items: CompletionItem[]): CompletionItem[] {
  return [...items].sort((a, b) => {
    const tierA = completionKindTier(a.kind);
    const tierB = completionKindTier(b.kind);
    if (tierA !== tierB) return tierA - tierB;
    const boostA = a.boost ?? 0;
    const boostB = b.boost ?? 0;
    if (boostB !== boostA) return boostB - boostA;
    return a.label.localeCompare(b.label);
  });
}

function applyKindTierBoost(items: CompletionItem[]): CompletionItem[] {
  return items.map((item) => ({
    ...item,
    boost: (item.boost ?? 0) + tierBoostForKind(item.kind),
  }));
}

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

export type { SqlCompletionContext };
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

function currentStatementBefore(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const start = before.lastIndexOf(";") + 1;
  return before.slice(start);
}

function allowedKeywordsForContext(context: SqlCompletionContext): Set<string> | null {  switch (context) {
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

/** FROM / INSERT INTO / UPDATE / DELETE FROM 等位置：无输入前缀时也应弹出表名。 */
export function shouldOfferTableCompletionsWithoutPrefix(context: SqlCompletionContext): boolean {
  return (
    context === "from_clause" ||
    context === "insert_into" ||
    context === "update_table" ||
    context === "delete_from"
  );
}

const FROM_TABLE_COLUMN_CONTEXTS = new Set<SqlCompletionContext>([
  "select_list",
  "where_clause",
  "group_by",
  "order_by",
]);

/** WHERE / GROUP BY / ORDER BY 且已解析出 FROM 表：无输入前缀时也应弹出字段。 */
export function shouldOfferColumnCompletionsWithoutPrefix(
  context: SqlCompletionContext,
  hasFromTable: boolean,
): boolean {
  return (
    hasFromTable &&
    (context === "where_clause" || context === "group_by" || context === "order_by")
  );
}

function includeDatabases(context: SqlCompletionContext): boolean {
  return context === "general";
}

function shouldFilterColumnsByFromTable(context: SqlCompletionContext): boolean {
  return context === "where_clause" || context === "group_by" || context === "order_by";
}

/** WHERE / GROUP BY / ORDER BY 且仅单表：只补裸字段名，不补 表.字段 / 库.表.字段。 */
function preferBareColumnsOnly(context: SqlCompletionContext, tableCount: number): boolean {
  return shouldFilterColumnsByFromTable(context) && tableCount === 1;
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
  const filtered = prefix ? filterAndRankByFuzzy(items, prefix) : items;
  return sortCompletionsByKind(applyKindTierBoost(filtered));
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

function tableInAnalysis(
  database: DatabaseSchema,
  table: TableSchema,
  analysis: StatementAnalysis,
): boolean {
  return analysis.tables.some((ref) => {
    if (ref.schemaName && ref.schemaName.toLowerCase() !== database.name.toLowerCase()) {
      return false;
    }
    return ref.tableName.toLowerCase() === table.name.toLowerCase();
  });
}

function buildColumnsFromAnalysis(
  analysis: StatementAnalysis,
  catalog: Catalog,
  context: SqlCompletionContext,
  includeBareColumns: boolean,
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const multiTable = analysis.tables.length > 1;
  const bareOnly = preferBareColumnsOnly(context, analysis.tables.length);

  for (const ref of analysis.tables) {
    const resolved = catalog.findTable(ref.tableName, ref.schemaName);
    if (!resolved) continue;
    const { table } = resolved;
    const qualifiers = qualifiersForTableRef(ref);

    for (const column of table.columns) {
      if (includeBareColumns && !multiTable) {
        items.push({
          label: column.name,
          kind: COLUMN_KIND,
          detail: `${column.type} · ${ref.alias ? `${ref.tableName} (${ref.alias})` : ref.tableName}`,
          insertText: column.name,
        });
      }

      if (!bareOnly) {
        for (const qualifier of qualifiers) {
          items.push({
            label: `${qualifier}.${column.name}`,
            kind: COLUMN_KIND,
            detail: `${column.type} · ${ref.tableName}${ref.alias && ref.alias !== ref.tableName ? ` (${ref.alias})` : ""}`,
            insertText: `${qualifier}.${column.name}`,
          });
        }

        if (context !== "select_list") {
          items.push({
            label: `${resolved.database.name}.${table.name}.${column.name}`,
            kind: COLUMN_KIND,
            detail: `${column.type} · ${resolved.database.name}.${table.name}`,
            insertText: `${resolved.database.name}.${table.name}.${column.name}`,
          });
        }
      }
    }
  }

  return items;
}

function buildAllColumnsFromAnalysis(
  analysis: StatementAnalysis,
  catalog: Catalog,
  context: SqlCompletionContext,
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const bareOnly = preferBareColumnsOnly(context, analysis.tables.length);
  for (const ref of analysis.tables) {
    const resolved = catalog.findTable(ref.tableName, ref.schemaName);
    if (!resolved || resolved.table.columns.length === 0) continue;
    const qualifier = ref.alias ?? ref.tableName;
    const insertText = resolved.table.columns
      .map((column) => (bareOnly ? column.name : `${qualifier}.${column.name}`))
      .join(", ");
    const label = insertText.length > 96 ? `${insertText.slice(0, 93)}...` : insertText;
    items.push({
      label,
      kind: COLUMN_KIND,
      insertText,
      detail: `全部字段 · ${qualifier}${ref.alias ? ` → ${ref.tableName}` : ""}`,
      boost: 100,
    });
  }
  return items;
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
  const statement = sliceStatementAtOffset(text, offset).trim();
  const analysis = statement ? analyzeStatement(statement, dbType) : null;
  const catalog = Catalog.fromSchemas(schemas);
  const fromTable = FROM_TABLE_COLUMN_CONTEXTS.has(context)
    ? resolveFromTableInStatement(text, offset, schemas, dbType)
    : null;
  const databases: CompletionItem[] = [];
  const tables: CompletionItem[] = [];
  let columns: CompletionItem[] = [];

  if (includeColumns(context) && analysis && analysis.tables.length > 0) {
    columns = buildColumnsFromAnalysis(
      analysis,
      catalog,
      context,
      context === "select_list" ||
        context === "general" ||
        shouldFilterColumnsByFromTable(context),
    );
  }

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
        const tableBoost =
          context === "statement_start" || shouldOfferTableCompletionsWithoutPrefix(context)
            ? 60
            : undefined;
        tables.push({
          label: table.name,
          kind: TABLE_KIND,
          detail: `${table.kind === "view" ? "视图" : "表"} · ${database.name}`,
          insertText: table.name,
          boost: tableBoost,
        });
      }

      if (includeColumns(context) && (!analysis || analysis.tables.length === 0)) {
        if (
          fromTable &&
          shouldFilterColumnsByFromTable(context) &&
          !tableMatchesFromContext(database, table, fromTable)
        ) {
          continue;
        }
        if (
          analysis &&
          shouldFilterColumnsByFromTable(context) &&
          !tableInAnalysis(database, table, analysis)
        ) {
          continue;
        }

        const fallbackTableCount =
          analysis && analysis.tables.length > 0
            ? analysis.tables.length
            : fromTable
              ? 1
              : 0;
        const bareOnly = preferBareColumnsOnly(context, fallbackTableCount);

        for (const column of table.columns) {
          columns.push({
            label: column.name,
            kind: COLUMN_KIND,
            detail: `${column.type} · ${table.name}`,
            insertText: column.name,
          });
          if (!bareOnly) {
            columns.push({
              label: `${table.name}.${column.name}`,
              kind: COLUMN_KIND,
              detail: `${column.type} · ${table.name}`,
              insertText: `${table.name}.${column.name}`,
            });
            if (context !== "select_list") {
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
    }
  }

  const keywords = filterKeywordsByContext(SQL_KEYWORDS, context);
  const functions = includeFunctions(context)
    ? buildFunctionCompletionItems(dbType, context as SqlFunctionCompletionContext)
    : [];
  const allColumnsItem =
    !prefix && context !== "select_list"
      ? analysis && analysis.tables.length > 0
        ? buildAllColumnsFromAnalysis(analysis, catalog, context)[0] ?? null
        : fromTable
          ? buildAllColumnsCompletionItem(fromTable.table, fromTable.qualifiedTable)
          : null
      : null;
  const merged = [
    ...(allColumnsItem ? [allColumnsItem] : []),
    ...columns,
    ...databases,
    ...tables,
    ...functions,
    ...keywords,
  ];
  return filterItems(merged, prefix);
}

export { resolveSqlCompletionContext, resolveFromTableInStatement } from "../parser/context";
