import type { SchemaTreeItem } from "./schemaTreeItem";
import type { SchemaCacheSnapshot } from "./schemaCache";
import type { SchemaLayoutDragPayload } from "./schemaLayoutPointerDnD";
import {
  databaseOtherFolderId,
  databaseTablesFolderId,
  databaseViewsFolderId,
} from "./schemaTreeIds";

/** 库下对象文件夹（表/视图/其它）若只有一个，返回其节点 id，供双击库名时再展开一层。 */
export function resolveSoleDatabaseObjectFolderId(
  connId: string,
  dbName: string,
  db:
    | {
        tables?: { length: number } | null;
        views?: { length: number } | null;
        routines?: { length: number } | null;
      }
    | null
    | undefined,
): string | null {
  if (!db) {
    return null;
  }
  const folders: string[] = [];
  if ((db.tables?.length ?? 0) > 0) {
    folders.push(databaseTablesFolderId(connId, dbName));
  }
  if ((db.views?.length ?? 0) > 0) {
    folders.push(databaseViewsFolderId(connId, dbName));
  }
  if ((db.routines?.length ?? 0) > 0) {
    folders.push(databaseOtherFolderId(connId, dbName));
  }
  return folders.length === 1 ? folders[0]! : null;
}

export function resolveLayoutFolderIdFromItem(item: SchemaTreeItem): string | null {
  if (item.type !== "connection-folder") {
    return null;
  }
  return item.id;
}

export function buildLayoutDragPayload(item: SchemaTreeItem): SchemaLayoutDragPayload | null {
  if (item.type === "connection" && item.connId) {
    return { kind: "connection", connId: item.connId };
  }
  if (item.type === "connection-folder") {
    return {
      kind: "connection-folder",
      folderId: resolveLayoutFolderIdFromItem(item) ?? item.id,
    };
  }
  return null;
}

export function tableColumnsFolderId(tableId: string) {
  return `${tableId}:cols`;
}

export function tableIndexesFolderId(tableId: string) {
  return `${tableId}:idxs`;
}

export function syncFiltersFromSnapshot(
  snapshot: SchemaCacheSnapshot,
  syncDatabaseFilter: (connId: string, names: string[]) => void,
  syncTableFilter: (connId: string, dbName: string, names: string[]) => void,
) {
  for (const [connId, entry] of Object.entries(snapshot.connections)) {
    if (entry.databases.length > 0) {
      syncDatabaseFilter(connId, entry.databases.map((db) => db.name));
    }
    for (const db of entry.databases) {
      if (db.tables.length > 0) {
        syncTableFilter(connId, db.name, db.tables.map((table) => table.name));
      }
    }
  }
}
