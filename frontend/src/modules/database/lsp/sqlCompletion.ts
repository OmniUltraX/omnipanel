import type { DatabaseSchema } from "../types";

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

const SQL_KEYWORDS: CompletionItem[] = [
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT JOIN",
  "ORDER BY",
  "GROUP BY",
  "LIMIT",
  "INSERT INTO",
  "UPDATE",
  "DELETE",
  "CREATE INDEX",
].map((label) => ({ label, kind: KEYWORD_KIND, insertText: `${label} `, detail: "SQL 关键字" }));

const SQL_FUNCTIONS: CompletionItem[] = [
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COALESCE",
  "NOW",
].map((label) => ({ label, kind: FUNCTION_KIND, insertText: `${label}($1)`, snippet: true, detail: "SQL 函数" }));

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

export function getCompletionItems(
  text: string,
  offset: number,
  schemas: DatabaseSchema[],
): CompletionItem[] {
  const prefix = currentPrefix(text, offset);
  const tables: CompletionItem[] = [];
  const columns: CompletionItem[] = [];

  for (const database of schemas) {
    for (const table of database.tables) {
      tables.push({
        label: table.name,
        kind: TABLE_KIND,
        detail: `表 · ${table.columns.length} 列`,
      });
      for (const column of table.columns) {
        columns.push({
          label: column.name,
          kind: COLUMN_KIND,
          detail: `${column.type} · ${table.name}`,
        });
      }
    }
  }

  return filterItems([...SQL_KEYWORDS, ...SQL_FUNCTIONS, ...tables, ...columns], prefix);
}
