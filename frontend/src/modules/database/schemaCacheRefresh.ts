import {
  type DbConnectionConfig,
  introspectSchema,
  isConnectionEnabled,
  listConnectionUsers,
  listConnections,
  listDatabases,
} from "./api";
import type {
  SchemaCacheConnectionEntry,
  SchemaCacheDatabaseEntry,
  SchemaCacheSnapshot,
} from "./schemaCache";
import { emptySchemaCacheSnapshot } from "./schemaCache";
import { useDbSchemaCacheStore } from "../../stores/dbSchemaCacheStore";

export interface SchemaCacheRefreshReporter {
  onStart?: (params: { connectionCount: number }) => void;
  onConnectionStart?: (params: { name: string; index: number; total: number }) => void;
  onDatabaseStart?: (params: {
    connectionName: string;
    databaseName: string;
    index: number;
    total: number;
  }) => void;
  onConnectionComplete?: (params: {
    name: string;
    index: number;
    total: number;
    databaseCount: number;
  }) => void;
  onComplete?: () => void;
  onError?: (message: string) => void;
}

export async function refreshAndPatchConnectionSchemaCache(
  connection: DbConnectionConfig,
  reporter?: SchemaCacheRefreshReporter,
): Promise<void> {
  if (!isConnectionEnabled(connection)) {
    return;
  }
  const store = useDbSchemaCacheStore.getState();
  store.setConnectionRefreshing(connection.id, true);
  try {
    reporter?.onStart?.({ connectionCount: 1 });
    reporter?.onConnectionStart?.({ name: connection.name, index: 1, total: 1 });
    const entry = await fetchConnectionSchemaCache(connection, reporter);
    await store.patchConnection(connection.id, entry);
    reporter?.onConnectionComplete?.({
      name: connection.name,
      index: 1,
      total: 1,
      databaseCount: entry.databases.length,
    });
    reporter?.onComplete?.();
  } catch (err) {
    reporter?.onError?.(String(err));
    throw err;
  } finally {
    store.setConnectionRefreshing(connection.id, false);
  }
}

export async function fetchConnectionSchemaCache(
  connection: DbConnectionConfig,
  reporter?: SchemaCacheRefreshReporter,
): Promise<SchemaCacheConnectionEntry> {
  const refreshedAt = Date.now();
  try {
    const presetDb = connection.database.trim();
    const dbNames = presetDb ? [presetDb] : await listDatabases(connection);
    const databases: SchemaCacheDatabaseEntry[] = [];

    for (let index = 0; index < dbNames.length; index++) {
      const dbName = dbNames[index];
      reporter?.onDatabaseStart?.({
        connectionName: connection.name,
        databaseName: dbName,
        index: index + 1,
        total: dbNames.length,
      });
      try {
        const result = await introspectSchema(connection, dbName);
        databases.push({
          name: dbName,
          tables: result.tables,
          views: result.views ?? [],
          routines: result.routines ?? [],
        });
      } catch (err) {
        databases.push({ name: dbName, tables: [], views: [], routines: [], loadError: String(err) });
      }
    }

    let users: Awaited<ReturnType<typeof listConnectionUsers>> = [];
    try {
      users = await listConnectionUsers(connection);
    } catch {
      users = [];
    }

    return { databases, users, refreshedAt };
  } catch (err) {
    return { databases: [], refreshedAt, error: String(err) };
  }
}

export async function buildFullSchemaCacheSnapshot(
  connections: DbConnectionConfig[],
  reporter?: SchemaCacheRefreshReporter,
): Promise<SchemaCacheSnapshot> {
  const enabled = connections.filter(isConnectionEnabled);
  reporter?.onStart?.({ connectionCount: enabled.length });
  const snapshot = emptySchemaCacheSnapshot();
  let index = 0;
  for (const connection of enabled) {
    index += 1;
    reporter?.onConnectionStart?.({ name: connection.name, index, total: enabled.length });
    snapshot.connections[connection.id] = await fetchConnectionSchemaCache(connection, reporter);
    reporter?.onConnectionComplete?.({
      name: connection.name,
      index,
      total: enabled.length,
      databaseCount: snapshot.connections[connection.id].databases.length,
    });
  }
  reporter?.onComplete?.();
  return snapshot;
}

export async function refreshAllSchemaCache(
  reporter?: SchemaCacheRefreshReporter,
): Promise<SchemaCacheSnapshot> {
  const connections = await listConnections();
  return buildFullSchemaCacheSnapshot(connections, reporter);
}

export async function refreshConnectionSchemaCache(
  connection: DbConnectionConfig,
  reporter?: SchemaCacheRefreshReporter,
): Promise<SchemaCacheConnectionEntry> {
  if (!isConnectionEnabled(connection)) {
    return { databases: [] };
  }
  reporter?.onStart?.({ connectionCount: 1 });
  reporter?.onConnectionStart?.({ name: connection.name, index: 1, total: 1 });
  const entry = await fetchConnectionSchemaCache(connection, reporter);
  reporter?.onConnectionComplete?.({
    name: connection.name,
    index: 1,
    total: 1,
    databaseCount: entry.databases.length,
  });
  reporter?.onComplete?.();
  return entry;
}
