import type { DragEvent } from "react";

/** Schema 树节点类型，与 TreeNode 渲染类型一致。 */
export type SchemaTreeItemType =
  | "group"
  | "connection"
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

export const SCHEMA_TREE_DRAG_MIME = "application/x-omnipanel-schema-item";

let activeSchemaDragItem: SchemaTreeItem | null = null;

/** 记录当前 Schema 树拖动项（WebView 下 dragover 可能读不到自定义 MIME）。 */
export function setActiveSchemaDragItem(item: SchemaTreeItem | null): void {
  activeSchemaDragItem = item;
}

export function getActiveSchemaDragItem(): SchemaTreeItem | null {
  return activeSchemaDragItem;
}

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

/** 根据节点类型生成可插入 SQL 编辑器的纯文本。 */
export function getSchemaTreeDragText(item: SchemaTreeItem): string {
  switch (item.type) {
    case "connection":
      return item.label;
    case "database":
      return item.dbName ? quoteIdent(item.dbName) : item.label;
    case "table":
      if (item.dbName && item.tableName) {
        return `${quoteIdent(item.dbName)}.${quoteIdent(item.tableName)}`;
      }
      return item.tableName ? quoteIdent(item.tableName) : item.label;
    case "view":
      if (item.dbName && item.tableName) {
        return `${quoteIdent(item.dbName)}.${quoteIdent(item.tableName)}`;
      }
      return item.tableName ? quoteIdent(item.tableName) : item.label;
    case "column":
      if (item.tableName && item.columnName) {
        return `${quoteIdent(item.tableName)}.${quoteIdent(item.columnName)}`;
      }
      return item.columnName ? quoteIdent(item.columnName) : item.label;
    case "index":
      return item.indexName ?? item.label;
    case "group":
    case "folder":
    default:
      return item.label;
  }
}

/** 仅表级节点可拖动（插入 SQL / 树内排序）。 */
export function isSchemaTreeItemDraggable(type: SchemaTreeItemType): boolean {
  return type === "table" || type === "view";
}

/**
 * 通用 Schema 树拖动开始处理：按节点类型设置 dataTransfer 载荷。
 * - text/plain：供 SQL 编辑器等原生 drop 目标使用
 * - application/x-omnipanel-schema-item：完整 SchemaTreeItem JSON
 */
export function handleSchemaTreeDragStart(
  item: SchemaTreeItem,
  event: DragEvent<HTMLElement>,
): void {
  if (!isSchemaTreeItemDraggable(item.type)) {
    event.preventDefault();
    return;
  }

  const text = getSchemaTreeDragText(item);
  setActiveSchemaDragItem(item);

  try {
    event.dataTransfer.setData("text/plain", text);
    event.dataTransfer.setData(SCHEMA_TREE_DRAG_MIME, JSON.stringify(item));
    event.dataTransfer.effectAllowed = "copy";

    switch (item.type) {
      case "connection":
        event.dataTransfer.setData("text/x-omnipanel-schema-connection", item.connId ?? item.id);
        break;
      case "database":
        event.dataTransfer.setData(
          "text/x-omnipanel-schema-database",
          JSON.stringify({ connId: item.connId, dbName: item.dbName ?? item.label }),
        );
        break;
      case "table":
        event.dataTransfer.setData(
          "text/x-omnipanel-schema-table",
          JSON.stringify({
            connId: item.connId,
            dbName: item.dbName,
            tableName: item.tableName ?? item.label,
          }),
        );
        break;
      case "column":
        event.dataTransfer.setData(
          "text/x-omnipanel-schema-column",
          JSON.stringify({
            connId: item.connId,
            dbName: item.dbName,
            tableName: item.tableName,
            columnName: item.columnName ?? item.label,
            columnType: item.columnType,
          }),
        );
        break;
      case "index":
        event.dataTransfer.setData(
          "text/x-omnipanel-schema-index",
          JSON.stringify({
            connId: item.connId,
            dbName: item.dbName,
            tableName: item.tableName,
            indexName: item.indexName ?? item.label,
          }),
        );
        break;
      default:
        break;
    }
  } catch {
    setActiveSchemaDragItem(null);
    event.preventDefault();
  }
}

/** Schema 树拖动结束：清理 active 项。 */
export function handleSchemaTreeDragEnd(_item: SchemaTreeItem): void {
  setActiveSchemaDragItem(null);
}

export function buildGroupTreeItem(groupId: string, label: string): SchemaTreeItem {
  return { type: "group", id: `grp:${groupId}`, label, groupId };
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

const SCHEMA_DROP_MIME_TYPES = [
  SCHEMA_TREE_DRAG_MIME,
  "text/x-omnipanel-schema-table",
  "text/x-omnipanel-schema-database",
  "text/x-omnipanel-schema-column",
  "text/x-omnipanel-schema-index",
  "text/x-omnipanel-schema-connection",
] as const;

/** dragover 阶段根据 MIME 类型判断是否可接受 Schema 树拖放（不可读取 getData）。 */
export function canAcceptSchemaTreeDrop(dataTransfer: DataTransfer): boolean {
  if (getActiveSchemaDragItem()) {
    return true;
  }
  const types = dataTransfer.types;
  if (!types || types.length === 0) {
    return false;
  }
  return SCHEMA_DROP_MIME_TYPES.some((type) => types.includes(type));
}

/** 从 drop 事件的 dataTransfer 解析 SchemaTreeItem。 */
export function parseSchemaTreeItemFromDrop(dataTransfer: DataTransfer): SchemaTreeItem | null {
  const raw = dataTransfer.getData(SCHEMA_TREE_DRAG_MIME);
  if (raw) {
    try {
      const item = JSON.parse(raw) as SchemaTreeItem;
      if (item?.type && item?.id && item?.label) {
        return item;
      }
    } catch {
      // fall through
    }
  }

  const tableRaw = dataTransfer.getData("text/x-omnipanel-schema-table");
  if (tableRaw) {
    try {
      const payload = JSON.parse(tableRaw) as {
        connId?: string;
        dbName?: string;
        tableName?: string;
      };
      if (payload.connId && payload.dbName && payload.tableName) {
        return buildTableTreeItem(payload.connId, payload.dbName, payload.tableName);
      }
    } catch {
      // fall through
    }
  }

  const databaseRaw = dataTransfer.getData("text/x-omnipanel-schema-database");
  if (databaseRaw) {
    try {
      const payload = JSON.parse(databaseRaw) as { connId?: string; dbName?: string };
      if (payload.connId && payload.dbName) {
        return buildDatabaseTreeItem(payload.connId, payload.dbName);
      }
    } catch {
      // fall through
    }
  }

  return getActiveSchemaDragItem();
}
