export function makeTableNodeId(connId: string, dbName: string, tableName: string) {
  return `tbl:${connId}:${dbName}:${tableName}`;
}

export function parseTableNodeId(id: string): { connId: string; dbName: string; tableName: string } | null {
  if (!id.startsWith("tbl:")) {
    return null;
  }
  const parts = id.slice(4).split(":");
  if (parts.length < 3) {
    return null;
  }
  const connId = parts[0];
  const tableName = parts[parts.length - 1];
  const dbName = parts.slice(1, -1).join(":");
  return { connId, dbName, tableName };
}

export function parseViewNodeId(id: string): { connId: string; dbName: string; tableName: string } | null {
  if (!id.startsWith("view:")) {
    return null;
  }
  const parts = id.slice(5).split(":");
  if (parts.length < 3) {
    return null;
  }
  const connId = parts[0];
  const tableName = parts[parts.length - 1];
  const dbName = parts.slice(1, -1).join(":");
  return { connId, dbName, tableName };
}

export function makeDatabaseNodeId(connId: string, dbName: string) {
  return `db:${connId}:${dbName}`;
}

export function parseDatabaseNodeId(id: string): { connId: string; dbName: string } | null {
  if (!id.startsWith("db:")) {
    return null;
  }
  const parts = id.slice(3).split(":");
  if (parts.length < 2) {
    return null;
  }
  const connId = parts[0];
  const dbName = parts.slice(1).join(":");
  return { connId, dbName };
}

export function connectionDatabasesFolderId(connId: string) {
  return `databases:${connId}`;
}

/** Schema 侧栏顶级连接列表分页键（非 UI 节点） */
export const SCHEMA_ROOT_CONNECTIONS_ID = "schema:root-connections";

export function connectionUsersFolderId(connId: string) {
  return `users:${connId}`;
}

export function userNodeId(connId: string, name: string, host?: string | null) {
  return `user:${connId}:${host ?? ""}:${name}`;
}

export function databaseTablesFolderId(connId: string, dbName: string) {
  return `tbls:${connId}:${dbName}`;
}

export function databaseViewsFolderId(connId: string, dbName: string) {
  return `views:${connId}:${dbName}`;
}

export function databaseOtherFolderId(connId: string, dbName: string) {
  return `other:${connId}:${dbName}`;
}

export function makeViewNodeId(connId: string, dbName: string, viewName: string) {
  return `view:${connId}:${dbName}:${viewName}`;
}

export function routineNodeId(connId: string, dbName: string, name: string) {
  return `routine:${connId}:${dbName}:${name}`;
}

export function formatUserLabel(name: string, host?: string | null): string {
  if (host) return `${name}@${host}`;
  return name;
}
