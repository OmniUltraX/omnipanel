import type { SchemaCacheSnapshot, SchemaCacheConnectionEntry } from "../../schemaCache";
import type { DbTableSchema } from "../../api";
import { Catalog } from "./catalog";
import type { Table } from "./schema";

function tablesFromCacheEntry(
  entry: DbTableSchema[],
  kind: Table["kind"],
): Table[] {
  return entry.map((table) => ({
    name: table.name,
    kind,
    comment: table.comment?.trim() || undefined,
    columns: table.columns.map((col) => ({
      name: col.name,
      type: col.type,
      isPK: col.isPk,
      isFK: col.isFk,
      nullable: col.nullable,
      comment: col.comment?.trim() || undefined,
    })),
  }));
}

/** 从 Schema 缓存条目构建单库 Catalog。 */
export function catalogFromSchemaCacheEntry(
  entry: SchemaCacheConnectionEntry,
  databaseName: string,
): Catalog {
  const dbEntry = entry.databases.find((db) => db.name === databaseName);
  if (!dbEntry) {
    return new Catalog([]);
  }
  const tables = [
    ...tablesFromCacheEntry(dbEntry.tables, "table"),
    ...tablesFromCacheEntry(dbEntry.views ?? [], "view"),
  ];
  return new Catalog([{ name: databaseName, tables }]);
}

/** 从全局 Schema 缓存快照读取指定连接 + 库的 Catalog。 */
export function catalogFromSchemaCache(
  snapshot: SchemaCacheSnapshot,
  connectionId: string,
  databaseName: string,
): Catalog {
  const entry = snapshot.connections[connectionId];
  if (!entry) return new Catalog([]);
  return catalogFromSchemaCacheEntry(entry, databaseName);
}
