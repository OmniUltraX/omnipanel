import type { SchemaTreeItemType } from "./schemaTreeItem";

export function isSchemaNodeRefreshable(type: SchemaTreeItemType): boolean {
  return type === "connection" || type === "database" || type === "folder";
}

export function isSchemaNodeDeletable(type: SchemaTreeItemType): boolean {
  return type === "column" || type === "index";
}
