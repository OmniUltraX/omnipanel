import type { DatabaseSchema, TableSchema } from "../types";

interface CompletionItem {
  label: string;
  kind: number;
  insertText?: string;
  detail?: string;
  snippet?: boolean;
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
].map((label) => ({ label, kind: KEYWORD_KIND, insertText: `${label} `, detail: "SQL 关键字" }));

const SQL_FUNCTIONS: CompletionItem[] = [
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COALESCE",
  "NOW",
  "CAST",
  "CONCAT",
].map((label) => ({
  label,
  kind: FUNCTION_KIND,
  insertText: `${label}($1)`,
  snippet: true,
  detail: "SQL 函数",
}));

function currentPrefix(text: string, offset: number) {
  const before = text.slice(0, offset);
  const line = before.split("\n").pop() ?? "";
  return line.match(/(\w+)$/)?.[1] ?? "";
}

function filterItems(items: CompletionItem[], prefix: string): CompletionItem[] {
  if (!prefix) return items;
  const normalized = prefix.toUpperCase();
  return items.filter((item) => item.label.toUpperCase().includes(normalized));
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
): TableSchema[] {
  return tables.map((table) => ({
    name: table.name,
    columns: table.columns.map((col) => ({
      name: col.name,
      type: col.type,
      isPK: col.isPk,
      isFK: col.isFk,
    })),
  }));
}

export function getCompletionItems(
  text: string,
  offset: number,
  schemas: DatabaseSchema[],
): CompletionItem[] {
  const prefix = currentPrefix(text, offset);
  const databases: CompletionItem[] = [];
  const tables: CompletionItem[] = [];
  const columns: CompletionItem[] = [];

  for (const database of schemas) {
    databases.push({
      label: database.name,
      kind: DATABASE_KIND,
      detail: `数据库 · ${database.tables.length} 表`,
      insertText: database.name,
    });

    for (const table of database.tables) {
      tables.push({
        label: table.name,
        kind: TABLE_KIND,
        detail: `表 · ${database.name}`,
        insertText: table.name,
      });
      tables.push({
        label: `${database.name}.${table.name}`,
        kind: TABLE_KIND,
        detail: `表 · ${database.name}`,
        insertText: `${database.name}.${table.name}`,
      });

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

  return filterItems([...SQL_KEYWORDS, ...SQL_FUNCTIONS, ...databases, ...tables, ...columns], prefix);
}
