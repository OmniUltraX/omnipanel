import type { DatabaseSchema, TableSchema } from "../../types";

const TABLE_REF_STOP_WORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "ON",
  "AND",
  "OR",
  "AS",
  "IN",
  "NOT",
  "NULL",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "CROSS",
  "FULL",
  "NATURAL",
  "USING",
  "SET",
  "VALUES",
  "INTO",
  "UPDATE",
  "DELETE",
  "INSERT",
  "BY",
  "GROUP",
  "ORDER",
  "HAVING",
  "LIMIT",
  "UNION",
  "DISTINCT",
  "LATERAL",
]);

/** 下划线分词后取各段首字母，如 tiku_chapter_content → tcc */
export function tableNameToAbbreviatedAlias(tableName: string): string {
  const parts = tableName
    .split("_")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return "";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 1).toLowerCase();
  }
  return parts.map((part) => part[0]?.toLowerCase() ?? "").join("");
}

export interface TableBeforeTrailingSpace {
  schemaName?: string;
  tableName: string;
  table: TableSchema;
}

function findTableInSchemas(
  schemas: DatabaseSchema[],
  tableName: string,
  schemaName?: string,
): TableSchema | undefined {
  const key = tableName.toLowerCase();
  if (schemaName) {
    const db = schemas.find((item) => item.name.toLowerCase() === schemaName.toLowerCase());
    return db?.tables.find((table) => table.name.toLowerCase() === key);
  }
  for (const database of schemas) {
    const table = database.tables.find((item) => item.name.toLowerCase() === key);
    if (table) {
      return table;
    }
  }
  return undefined;
}

function parseTableNameBeforeTrailingSpace(
  linePrefix: string,
): { schemaName?: string; tableName: string } | null {
  if (!/\s$/.test(linePrefix)) {
    return null;
  }
  const trimmed = linePrefix.trimEnd();

  const asDbTable = trimmed.match(/(\w+)\.(\w+)\s+AS$/i);
  if (asDbTable) {
    return { schemaName: asDbTable[1], tableName: asDbTable[2] };
  }
  const asTable = trimmed.match(/(\w+)\s+AS$/i);
  if (asTable && !TABLE_REF_STOP_WORDS.has(asTable[1].toUpperCase())) {
    return { tableName: asTable[1] };
  }

  const dbTable = trimmed.match(/(\w+)\.(\w+)$/);
  if (dbTable) {
    return { schemaName: dbTable[1], tableName: dbTable[2] };
  }

  const single = trimmed.match(/(\w+)$/);
  if (!single) {
    return null;
  }
  if (TABLE_REF_STOP_WORDS.has(single[1].toUpperCase())) {
    return null;
  }
  return { tableName: single[1] };
}

/** 光标位于「表名 + 空格」之后时，解析刚输入的表名。 */
export function resolveTableBeforeTrailingSpace(
  linePrefix: string,
  schemas: DatabaseSchema[],
): TableBeforeTrailingSpace | null {
  const parsed = parseTableNameBeforeTrailingSpace(linePrefix);
  if (!parsed) {
    return null;
  }
  const table = findTableInSchemas(schemas, parsed.tableName, parsed.schemaName);
  if (!table) {
    return null;
  }
  return {
    schemaName: parsed.schemaName,
    tableName: parsed.tableName,
    table,
  };
}

export function buildSuggestedTableAlias(table: TableSchema): string {
  return tableNameToAbbreviatedAlias(table.name);
}
