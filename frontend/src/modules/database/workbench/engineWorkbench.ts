/** Database Host L2 工作台插槽。引擎插件声明形状，Host 按此选树/编辑器/预览，而不是 `db_type === "redis"`。 */

export type EngineTreeKind = "schema" | "kv" | "collections" | "documents" | "none";
export type EngineEditorKind = "sql" | "redis" | "none";
export type EnginePreviewKind = "grid" | "key" | "points" | "document" | "none";
export type EngineConnectionInfoKind = "sql" | "redis" | "none";

export type EngineWorkbench = {
  tree: EngineTreeKind;
  editor: EngineEditorKind;
  preview: EnginePreviewKind;
  connectionInfo: EngineConnectionInfoKind;
};

export const SQL_WORKBENCH: EngineWorkbench = {
  tree: "schema",
  editor: "sql",
  preview: "grid",
  connectionInfo: "sql",
};

export const KV_WORKBENCH: EngineWorkbench = {
  tree: "kv",
  editor: "redis",
  preview: "key",
  connectionInfo: "redis",
};

export const DOCUMENT_WORKBENCH: EngineWorkbench = {
  tree: "documents",
  editor: "none",
  preview: "document",
  connectionInfo: "sql",
};

export const COLLECTIONS_WORKBENCH: EngineWorkbench = {
  tree: "collections",
  editor: "none",
  preview: "points",
  connectionInfo: "sql",
};

export const UNAVAILABLE_WORKBENCH: EngineWorkbench = {
  tree: "none",
  editor: "none",
  preview: "none",
  connectionInfo: "none",
};

const TREES = new Set<EngineTreeKind>(["schema", "kv", "collections", "documents", "none"]);
const EDITORS = new Set<EngineEditorKind>(["sql", "redis", "none"]);
const PREVIEWS = new Set<EnginePreviewKind>(["grid", "key", "points", "document", "none"]);
const INFOS = new Set<EngineConnectionInfoKind>(["sql", "redis", "none"]);

function asMember<T extends string>(raw: unknown, allowed: Set<T>): T | undefined {
  return typeof raw === "string" && allowed.has(raw as T) ? (raw as T) : undefined;
}

export function parseEngineWorkbench(raw: unknown): EngineWorkbench | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const tree = asMember(value.tree, TREES);
  const editor = asMember(value.editor, EDITORS);
  const preview = asMember(value.preview, PREVIEWS);
  const connectionInfo = asMember(value.connectionInfo, INFOS);
  if (!tree && !editor && !preview && !connectionInfo) return null;
  return {
    tree: tree ?? "schema",
    editor: editor ?? "sql",
    preview: preview ?? "grid",
    connectionInfo: connectionInfo ?? "sql",
  };
}
