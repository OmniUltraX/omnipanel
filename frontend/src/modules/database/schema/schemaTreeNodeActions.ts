import type { SchemaTreeItemType } from "./schemaTreeItem";

export function isSchemaNodeRefreshable(type: SchemaTreeItemType): boolean {
  return type === "connection" || type === "database" || type === "folder";
}

export function isSchemaNodeDeletable(type: SchemaTreeItemType): boolean {
  return (
    type === "column" ||
    type === "index" ||
    type === "database" ||
    type === "table" ||
    type === "view" ||
    type === "user"
  );
}

export function schemaNodeDeleteLabelKey(type: SchemaTreeItemType): string {
  switch (type) {
    case "column":
      return "database.schemaTree.deleteColumn";
    case "index":
      return "database.schemaTree.deleteIndex";
    case "database":
      return "database.schemaTree.deleteDatabase";
    case "table":
      return "database.schemaTree.deleteTable";
    case "view":
      return "database.schemaTree.deleteView";
    case "user":
      return "database.schemaTree.deleteUser";
    default:
      return "database.queryFiles.delete";
  }
}

export function schemaNodeDeleteConfirmKey(type: SchemaTreeItemType): string {
  switch (type) {
    case "column":
      return "database.schemaTree.confirmDeleteColumn";
    case "index":
      return "database.schemaTree.confirmDeleteIndex";
    case "database":
      return "database.schemaTree.confirmDeleteDatabase";
    case "table":
      return "database.schemaTree.confirmDeleteTable";
    case "view":
      return "database.schemaTree.confirmDeleteView";
    case "user":
      return "database.schemaTree.confirmDeleteUser";
    default:
      return "database.schemaTree.confirmDeleteTitle";
  }
}

export function schemaNodeDeleteActionKey(type: SchemaTreeItemType): string {
  switch (type) {
    case "column":
      return "database.schemaTree.deleteColumn";
    case "index":
      return "database.schemaTree.deleteIndex";
    case "database":
      return "database.schemaTree.deleteDatabase";
    case "table":
      return "database.schemaTree.deleteTable";
    case "view":
      return "database.schemaTree.deleteView";
    case "user":
      return "database.schemaTree.deleteUser";
    default:
      return "database.queryFiles.delete";
  }
}
