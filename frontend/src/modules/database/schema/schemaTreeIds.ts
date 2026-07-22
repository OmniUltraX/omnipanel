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

export function parseUserNodeId(
  id: string,
): { connId: string; host: string; name: string } | null {
  if (!id.startsWith("user:")) {
    return null;
  }
  const parts = id.slice(5).split(":");
  if (parts.length < 3) {
    return null;
  }
  const connId = parts[0]!;
  const name = parts[parts.length - 1]!;
  const host = parts.slice(1, -1).join(":");
  return { connId, host, name };
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

/** 从刷新节点 id 解析受影响的库（db / tbls / views / other / tbl / view 等）。 */
export function parseSchemaRefreshDbTarget(
  nodeId: string,
): { connId: string; dbName: string } | null {
  const db = parseDatabaseNodeId(nodeId);
  if (db) {
    return db;
  }
  for (const prefix of ["tbls:", "views:", "other:"] as const) {
    if (!nodeId.startsWith(prefix)) {
      continue;
    }
    const rest = nodeId.slice(prefix.length);
    const colon = rest.indexOf(":");
    if (colon <= 0) {
      return null;
    }
    const connId = rest.slice(0, colon);
    const dbName = rest.slice(colon + 1);
    if (!connId || !dbName) {
      return null;
    }
    return { connId, dbName };
  }
  const table = parseTableNodeId(nodeId);
  if (table) {
    return { connId: table.connId, dbName: table.dbName };
  }
  const view = parseViewNodeId(nodeId);
  if (view) {
    return { connId: view.connId, dbName: view.dbName };
  }
  return null;
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
