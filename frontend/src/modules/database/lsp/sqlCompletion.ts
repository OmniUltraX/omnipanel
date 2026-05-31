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
