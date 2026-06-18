import type { DbTableSchema, DbRoutineMeta, DbUserMeta } from "./api";

export interface SchemaCacheDatabaseEntry {
  name: string;
  tables: DbTableSchema[];
  views?: DbTableSchema[];
  routines?: DbRoutineMeta[];
  loadError?: string;
}

export interface SchemaCacheConnectionEntry {
  databases: SchemaCacheDatabaseEntry[];
  users?: DbUserMeta[];
  refreshedAt?: number;
  error?: string;
}

export interface SchemaCacheSnapshot {
  connections: Record<string, SchemaCacheConnectionEntry>;
}

export function emptySchemaCacheSnapshot(): SchemaCacheSnapshot {
  return { connections: {} };
}
