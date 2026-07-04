import { invoke } from "@tauri-apps/api/core";
import {
  connectionMatchesGroup,
  isConnectionEnabled,
  type DbConnectionConfig,
  type DbTableSchema,
  type DbUserMeta,
} from "../api";
import type { DbConnectionGroup } from "../../../stores/dbGroupStore";
import { useDbSchemaCacheStore } from "../../../stores/dbSchemaCacheStore";
import type { SchemaCacheConnectionEntry, SchemaCacheDatabaseEntry } from "./schemaCache";
import { buildConnectionTreeItem, type SchemaTreeItem } from "./schemaTreeItem";
import {
  parseDatabaseNodeId,
  parseTableNodeId,
  parseUserNodeId,
  parseViewNodeId,
} from "./schemaTreeIds";

export type SchemaNodeRefreshResult =
  | {
      scope: "connection";
      databases: SchemaCacheDatabaseEntry[];
      users?: DbUserMeta[];
    }
  | {
      scope: "database";
      name: string;
      tables: DbTableSchema[];
      views?: DbTableSchema[];
      routines?: SchemaCacheDatabaseEntry["routines"];
      loadError?: string;
    }
  | {
      scope: "table";
      databaseName: string;
      objectKind: string;
      table: DbTableSchema;
    }
  | {
      scope: "users";
      users: DbUserMeta[];
    };

export interface SchemaTreeRefreshHooks {
  syncDatabaseFilter?: (connId: string, names: string[]) => void;
  syncTableFilter?: (connId: string, dbName: string, names: string[]) => void;
  onConnectionPatched?: (connId: string, entry: SchemaCacheConnectionEntry) => void;
}

export async function refreshSchemaNode(
  connection: DbConnectionConfig,
  nodeKind: string,
  nodeId: string,
): Promise<SchemaNodeRefreshResult> {
  return invoke<SchemaNodeRefreshResult>("db_refresh_schema_node", {
    args: { connection, nodeKind, nodeId },
  });
}

function patchTableInDatabase(
  db: SchemaCacheDatabaseEntry,
  databaseName: string,
  objectKind: string,
  table: DbTableSchema,
): SchemaCacheDatabaseEntry {
  if (db.name !== databaseName) {
    return db;
  }
  if (objectKind === "view") {
    const views = [...(db.views ?? [])];
    const idx = views.findIndex((item) => item.name === table.name);
    if (idx >= 0) {
      views[idx] = table;
    } else {
      views.push(table);
    }
    return { ...db, views, loadError: undefined };
  }
  const tables = db.tables.map((item) => (item.name === table.name ? table : item));
  if (!tables.some((item) => item.name === table.name)) {
    tables.push(table);
  }
  return { ...db, tables, loadError: undefined };
}

export async function applySchemaNodeRefreshResult(
  connId: string,
  result: SchemaNodeRefreshResult,
  hooks?: SchemaTreeRefreshHooks,
): Promise<SchemaCacheConnectionEntry> {
  const store = useDbSchemaCacheStore.getState();
  const current = store.snapshot.connections[connId] ?? { databases: [] };
  const refreshedAt = Date.now();
  let next: SchemaCacheConnectionEntry;

  if (result.scope === "connection") {
    next = {
      databases: result.databases,
      users: result.users ?? [],
      refreshedAt,
    };
  } else if (result.scope === "users") {
    next = {
      ...current,
      users: result.users,
      refreshedAt,
    };
  } else if (result.scope === "database") {
    const nextDb: SchemaCacheDatabaseEntry = {
      name: result.name,
      tables: result.tables,
      views: result.views ?? [],
      routines: result.routines ?? [],
      loadError: result.loadError,
    };
    const databases = current.databases.some((db) => db.name === result.name)
      ? current.databases.map((db) => (db.name === result.name ? nextDb : db))
      : [...current.databases, nextDb];
    next = { ...current, databases, refreshedAt };
  } else {
    const databases = current.databases.some((db) => db.name === result.databaseName)
      ? current.databases.map((db) =>
          db.name === result.databaseName
            ? patchTableInDatabase(db, result.databaseName, result.objectKind, result.table)
            : db,
        )
      : [
          ...current.databases,
          patchTableInDatabase(
            { name: result.databaseName, tables: [], views: [], routines: [] },
            result.databaseName,
            result.objectKind,
            result.table,
          ),
        ];
    next = { ...current, databases, refreshedAt };
  }

  await store.patchConnection(connId, next);
  hooks?.onConnectionPatched?.(connId, next);

  if (result.scope === "connection") {
    hooks?.syncDatabaseFilter?.(connId, next.databases.map((db) => db.name));
    for (const db of next.databases) {
      if (db.tables.length > 0) {
        hooks?.syncTableFilter?.(connId, db.name, db.tables.map((table) => table.name));
      }
    }
  } else if (result.scope === "database") {
    hooks?.syncDatabaseFilter?.(connId, next.databases.map((db) => db.name));
    const db = next.databases.find((item) => item.name === result.name);
    if (db?.tables.length) {
      hooks?.syncTableFilter?.(connId, db.name, db.tables.map((table) => table.name));
    }
  } else if (result.scope === "table") {
    const db = next.databases.find((item) => item.name === result.databaseName);
    if (db) {
      const names =
        result.objectKind === "view"
          ? (db.views ?? []).map((item) => item.name)
          : db.tables.map((item) => item.name);
      if (names.length > 0) {
        hooks?.syncTableFilter?.(connId, db.name, names);
      }
    }
  }

  return next;
}

/** 删除 Schema 节点后仅更新本地缓存，避免整连接重新 introspect。 */
export async function applySchemaNodeDeleteToCache(
  connId: string,
  item: SchemaTreeItem,
  hooks?: SchemaTreeRefreshHooks,
): Promise<SchemaCacheConnectionEntry> {
  const store = useDbSchemaCacheStore.getState();
  const current = store.snapshot.connections[connId] ?? { databases: [] };
  const refreshedAt = Date.now();
  let next: SchemaCacheConnectionEntry;

  if (item.type === "database") {
    const parsed = parseDatabaseNodeId(item.id);
    const dbName = parsed?.dbName ?? item.dbName?.trim();
    if (!dbName) {
      return current;
    }
    next = {
      ...current,
      databases: current.databases.filter((db) => db.name !== dbName),
      refreshedAt,
    };
    hooks?.syncDatabaseFilter?.(connId, next.databases.map((db) => db.name));
  } else if (item.type === "table") {
    const parsed = parseTableNodeId(item.id);
    const dbName = parsed?.dbName ?? item.dbName?.trim();
    const tableName = parsed?.tableName ?? item.tableName?.trim();
    if (!dbName || !tableName) {
      return current;
    }
    next = {
      ...current,
      databases: current.databases.map((db) =>
        db.name !== dbName
          ? db
          : { ...db, tables: db.tables.filter((table) => table.name !== tableName) },
      ),
      refreshedAt,
    };
    const db = next.databases.find((entry) => entry.name === dbName);
    if (db) {
      hooks?.syncTableFilter?.(connId, dbName, db.tables.map((table) => table.name));
    }
  } else if (item.type === "view") {
    const parsed = parseViewNodeId(item.id);
    const dbName = parsed?.dbName ?? item.dbName?.trim();
    const viewName = parsed?.tableName ?? item.tableName?.trim() ?? item.label.trim();
    if (!dbName || !viewName) {
      return current;
    }
    next = {
      ...current,
      databases: current.databases.map((db) =>
        db.name !== dbName
          ? db
          : { ...db, views: (db.views ?? []).filter((view) => view.name !== viewName) },
      ),
      refreshedAt,
    };
    const db = next.databases.find((entry) => entry.name === dbName);
    if (db) {
      hooks?.syncTableFilter?.(connId, dbName, (db.views ?? []).map((view) => view.name));
    }
  } else if (item.type === "user") {
    const parsed = parseUserNodeId(item.id);
    if (!parsed) {
      return current;
    }
    next = {
      ...current,
      users: (current.users ?? []).filter(
        (user) => !(user.name === parsed.name && (user.host ?? "") === parsed.host),
      ),
      refreshedAt,
    };
  } else {
    return current;
  }

  await store.patchConnection(connId, next);
  hooks?.onConnectionPatched?.(connId, next);
  return next;
}

export async function refreshAndApplySchemaTreeNode(
  connection: DbConnectionConfig,
  item: SchemaTreeItem,
  hooks?: SchemaTreeRefreshHooks,
): Promise<void> {
  if (!isConnectionEnabled(connection)) {
    return;
  }
  const store = useDbSchemaCacheStore.getState();
  store.setNodeRefreshing(item.id, true);
  try {
    const result = await refreshSchemaNode(connection, item.type, item.id);
    await applySchemaNodeRefreshResult(connection.id, result, hooks);
  } finally {
    store.setNodeRefreshing(item.id, false);
  }
}

export async function refreshSchemaGroupNode(
  group: DbConnectionGroup,
  connections: DbConnectionConfig[],
  hooks?: SchemaTreeRefreshHooks,
): Promise<void> {
  const groupNodeId = `grp:${group.id}`;
  const store = useDbSchemaCacheStore.getState();
  store.setNodeRefreshing(groupNodeId, true);
  try {
    const targets = connections.filter(
      (conn) => isConnectionEnabled(conn) && connectionMatchesGroup(conn, group.name),
    );
    for (const connection of targets) {
      await refreshAndApplySchemaTreeNode(
        connection,
        buildConnectionTreeItem(connection.id, connection.name, connection.db_type),
        hooks,
      );
    }
  } finally {
    store.setNodeRefreshing(groupNodeId, false);
  }
}
