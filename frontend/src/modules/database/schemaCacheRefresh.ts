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

export async function fetchConnectionSchemaCache(
  connection: DbConnectionConfig,
): Promise<SchemaCacheConnectionEntry> {
  const refreshedAt = Date.now();
  try {
    const presetDb = connection.database.trim();
    const dbNames = presetDb ? [presetDb] : await listDatabases(connection);
    const databases: SchemaCacheDatabaseEntry[] = [];

    for (const dbName of dbNames) {
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
): Promise<SchemaCacheSnapshot> {
  const snapshot = emptySchemaCacheSnapshot();
  for (const connection of connections) {
    if (!isConnectionEnabled(connection)) {
      continue;
    }
    snapshot.connections[connection.id] = await fetchConnectionSchemaCache(connection);
  }
  return snapshot;
}

export async function refreshAllSchemaCache(): Promise<SchemaCacheSnapshot> {
  const connections = await listConnections();
  return buildFullSchemaCacheSnapshot(connections);
}

export async function refreshConnectionSchemaCache(
  connection: DbConnectionConfig,
): Promise<SchemaCacheConnectionEntry> {
  if (!isConnectionEnabled(connection)) {
    return { databases: [] };
  }
  return fetchConnectionSchemaCache(connection);
}
