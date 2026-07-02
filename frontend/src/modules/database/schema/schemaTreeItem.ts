/** Schema 树节点类型，与 TreeNode 渲染类型一致。 */
export type SchemaTreeItemType =
  | "group"
  | "connection"
  | "connection-folder"
  | "database"
  | "table"
  | "view"
  | "routine"
  | "user"
  | "folder"
  | "column"
  | "index";

/** 左侧 Schema 树节点的统一数据模型。 */
export interface SchemaTreeItem {
  type: SchemaTreeItemType;
  id: string;
  label: string;
  groupId?: string;
  connId?: string;
  dbName?: string;
  tableName?: string;
  columnName?: string;
  indexName?: string;
  columnType?: string;
  dbType?: string;
}

export function buildGroupTreeItem(groupId: string, label: string): SchemaTreeItem {
  return { type: "group", id: `grp:${groupId}`, label, groupId };
}

export function buildConnectionFolderTreeItem(folderId: string, label: string): SchemaTreeItem {
  return { type: "connection-folder", id: folderId, label };
}

export function buildConnectionTreeItem(
  connId: string,
  label: string,
  dbType?: string,
): SchemaTreeItem {
  return { type: "connection", id: `conn:${connId}`, label, connId, dbType };
}

export function buildDatabaseTreeItem(connId: string, dbName: string): SchemaTreeItem {
  return { type: "database", id: `db:${connId}:${dbName}`, label: dbName, connId, dbName };
}

export function buildTableTreeItem(connId: string, dbName: string, tableName: string): SchemaTreeItem {
  return {
    type: "table",
    id: `tbl:${connId}:${dbName}:${tableName}`,
    label: tableName,
    connId,
    dbName,
    tableName,
  };
}

export function buildFolderTreeItem(id: string, label: string, connId?: string, dbName?: string, tableName?: string): SchemaTreeItem {
  return { type: "folder", id, label, connId, dbName, tableName };
}

export function buildColumnTreeItem(
  connId: string,
  dbName: string,
  tableName: string,
  columnName: string,
  columnType?: string,
  nodeId?: string,
): SchemaTreeItem {
  return {
    type: "column",
    id: nodeId ?? `tbl:${connId}:${dbName}:${tableName}:col:${columnName}`,
    label: columnName,
    connId,
    dbName,
    tableName,
    columnName,
    columnType,
  };
}

export function buildIndexTreeItem(
  connId: string,
  dbName: string,
  tableName: string,
  indexName: string,
  nodeId?: string,
): SchemaTreeItem {
  return {
    type: "index",
    id: nodeId ?? `tbl:${connId}:${dbName}:${tableName}:idx:${indexName}`,
    label: indexName,
    connId,
    dbName,
    tableName,
    indexName,
  };
}
