import type { DbIntrospectResult } from "../../api";
import type { SchemaCacheDatabaseEntry } from "../../schema/schemaCache";
import { mergeDatabaseSchemaCacheEntry } from "../../schema/schemaCache";
import type { DatabaseSchema, TableSchema } from "../../types";
import { buildDatabaseSchema, introspectToTableSchemas } from "../language/completionItems";

type ColumnCarrier = { columns?: unknown[] | null };

/** 浅加载只有表名时，字段补全没有数据源。 */
export function sqlCompletionColumnsMissing(
  entry: { tables?: ColumnCarrier[] | null; views?: ColumnCarrier[] | null } | undefined,
): boolean {
  if (!entry) {
    return true;
  }
  const objects = [...(entry.tables ?? []), ...(entry.views ?? [])];
  if (objects.length === 0) {
    return true;
  }
  return objects.some((item) => (item.columns?.length ?? 0) === 0);
}

/** 表名 + 列名，用来判断补全 schema 是否要跟着缓存刷新。 */
export function completionSchemaFingerprint(tables: TableSchema[]): string {
  return tables
    .map((table) => {
      const columns = table.columns.map((col) => `${col.name}:${col.type}`).join(",");
      return `${table.kind ?? "table"}:${table.name}:${columns}`;
    })
    .join("\n");
}

export function sqlCompletionSchemaFromCacheEntry(
  database: string,
  entry: SchemaCacheDatabaseEntry,
  meta?: Pick<DatabaseSchema, "connectionName" | "dbType">,
): DatabaseSchema {
  const tables = [
    ...introspectToTableSchemas(entry.tables, "table"),
    ...introspectToTableSchemas(entry.views ?? [], "view"),
  ];
  return buildDatabaseSchema(database, tables, meta);
}

export function replaceSqlCompletionSchema(
  current: DatabaseSchema | undefined,
  next: DatabaseSchema,
): boolean {
  if (!current) {
    return true;
  }
  return completionSchemaFingerprint(current.tables) !== completionSchemaFingerprint(next.tables);
}

/** 把整库反射结果合并进连接缓存，保留已有列（incoming 为空列时不覆盖）。 */
export function cacheEntryWithIntrospectedColumns(
  current: SchemaCacheDatabaseEntry | undefined,
  database: string,
  result: Pick<DbIntrospectResult, "tables" | "views" | "routines">,
): SchemaCacheDatabaseEntry {
  return mergeDatabaseSchemaCacheEntry(current, {
    name: database,
    tables: result.tables,
    views: result.views ?? [],
    routines: result.routines ?? [],
    objectsLoaded: true,
  });
}
