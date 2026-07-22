import { invoke } from "@tauri-apps/api/core";
import {
  isConnectionEnabled,
  type DbConnectionConfig,
  type DbTableSchema,
  type DbUserMeta,
} from "../api";
import { useDbSchemaCacheStore } from "../../../stores/dbSchemaCacheStore";
import { mergeConnectionSchemaCacheEntry, mergeDatabaseSchemaCacheEntry } from "./schemaCache";
import type { SchemaCacheConnectionEntry, SchemaCacheDatabaseEntry } from "./schemaCache";
import type { SchemaTreeItem } from "./schemaTreeItem";
import {
  parseDatabaseNodeId,
  parseTableNodeId,
  parseUserNodeId,
  parseViewNodeId,
} from "./schemaTreeIds";
import { schemaRefreshDebug } from "./schemaRefreshDebug";

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
      objectsLoaded?: boolean;
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
  syncTableFilter?: (
    connId: string,
    dbName: string,
    names: string[],
    options?: { showAll?: boolean },
  ) => void;
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
    return { ...db, views, loadError: undefined, objectsLoaded: true };
  }
  const tables = db.tables.map((item) => (item.name === table.name ? table : item));
  if (!tables.some((item) => item.name === table.name)) {
    tables.push(table);
  }
  return { ...db, tables, loadError: undefined, objectsLoaded: true };
}

/** 把 IPC 结果整理成便于阅读的摘要（表/库名列表等）。 */
function summarizeRefreshResult(result: SchemaNodeRefreshResult): Record<string, unknown> {
  if (result.scope === "connection") {
    return {
      scope: result.scope,
      databases: result.databases.map((db) => ({
        name: db.name,
        tableCount: db.tables.length,
        viewCount: db.views?.length ?? 0,
        tables: db.tables.map((table) => table.name),
        views: (db.views ?? []).map((view) => view.name),
      })),
      users: (result.users ?? []).map((user) =>
        user.host ? `${user.name}@${user.host}` : user.name,
      ),
    };
  }
  if (result.scope === "database") {
    return {
      scope: result.scope,
      name: result.name,
      tableCount: result.tables.length,
      viewCount: result.views?.length ?? 0,
      routineCount: result.routines?.length ?? 0,
      tables: result.tables.map((table) => table.name),
      views: (result.views ?? []).map((view) => view.name),
      routines: (result.routines ?? []).map((routine) => routine.name),
      loadError: result.loadError,
      objectsLoaded: result.objectsLoaded,
    };
  }
  if (result.scope === "table") {
    return {
      scope: result.scope,
      databaseName: result.databaseName,
      objectKind: result.objectKind,
      table: result.table.name,
      columns: result.table.columns?.map((col) => col.name) ?? [],
    };
  }
  return {
    scope: result.scope,
    users: result.users.map((user) => (user.host ? `${user.name}@${user.host}` : user.name)),
  };
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
    const incoming: SchemaCacheConnectionEntry = {
      databases: result.databases.map((db) => ({
        ...db,
        objectsLoaded: db.objectsLoaded ?? false,
        keyCount: db.keyCount ?? undefined,
      })),
      users: result.users ?? [],
      refreshedAt,
    };
    next = mergeConnectionSchemaCacheEntry(current, incoming);
  } else if (result.scope === "users") {
    next = {
      ...current,
      users: result.users,
      refreshedAt,
    };
  } else if (result.scope === "database") {
    const nextDb: SchemaCacheDatabaseEntry = mergeDatabaseSchemaCacheEntry(
      current.databases.find((db) => db.name === result.name),
      {
        name: result.name,
        tables: result.tables,
        views: result.views ?? [],
        routines: result.routines ?? [],
        loadError: result.loadError,
        objectsLoaded: result.objectsLoaded ?? true,
      },
    );
    const databases = current.databases.some((db) => db.name === result.name)
      ? current.databases.map((db) => (db.name === result.name ? nextDb : db))
      : [...current.databases, nextDb];
    next = { ...current, databases, refreshedAt };
  } else if (result.scope === "table") {
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
  } else {
    return current;
  }

  await store.patchConnection(connId, next);
  hooks?.onConnectionPatched?.(connId, next);

  if (result.scope === "connection") {
    hooks?.syncDatabaseFilter?.(connId, next.databases.map((db) => db.name));
    for (const db of next.databases) {
      if (db.tables.length > 0) {
        hooks?.syncTableFilter?.(connId, db.name, db.tables.map((table) => table.name), {
          showAll: true,
        });
      }
    }
  } else if (result.scope === "database") {
    hooks?.syncDatabaseFilter?.(connId, next.databases.map((db) => db.name));
    const db = next.databases.find((item) => item.name === result.name);
    if (db?.tables.length) {
      hooks?.syncTableFilter?.(connId, db.name, db.tables.map((table) => table.name), {
        showAll: true,
      });
    }
  } else if (result.scope === "table") {
    const db = next.databases.find((item) => item.name === result.databaseName);
    if (db) {
      const names =
        result.objectKind === "view"
          ? (db.views ?? []).map((item) => item.name)
          : db.tables.map((item) => item.name);
      if (names.length > 0) {
        hooks?.syncTableFilter?.(connId, db.name, names, { showAll: true });
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
  schemaRefreshDebug("点击节点", {
    id: item.id,
    type: item.type,
    label: item.label,
    connId: item.connId ?? connection.id,
    dbName: item.dbName,
    tableName: item.tableName,
  });
  try {
    const result = await refreshSchemaNode(connection, item.type, item.id);
    schemaRefreshDebug("请求数据", summarizeRefreshResult(result));
    await applySchemaNodeRefreshResult(connection.id, result, hooks);
  } finally {
    store.setNodeRefreshing(item.id, false);
  }
}
