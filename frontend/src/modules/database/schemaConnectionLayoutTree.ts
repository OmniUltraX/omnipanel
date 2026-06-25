import type { CachedConnection } from "./schemaCacheMerge";
import type { SchemaConnectionFolder } from "../../stores/dbSchemaConnectionLayoutStore";

export type SchemaConnectionLayoutEntry =
  | { kind: "folder"; folder: SchemaConnectionFolder }
  | { kind: "connection"; connection: CachedConnection };

/** 按 parentId 列出文件夹与连接（文件夹在前，连接在后）。 */
export function listSchemaConnectionLayoutChildren(
  parentId: string | null,
  folders: SchemaConnectionFolder[],
  connections: CachedConnection[],
  connectionParents: Record<string, string | null>,
): SchemaConnectionLayoutEntry[] {
  const childFolders = folders
    .filter((f) => f.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const childConnections = connections
    .filter((conn) => {
      const parent = connectionParents[conn.config.id];
      return (parent ?? null) === parentId;
    })
    .sort((a, b) => a.config.name.localeCompare(b.config.name, undefined, { sensitivity: "base" }));

  return [
    ...childFolders.map((folder) => ({ kind: "folder" as const, folder })),
    ...childConnections.map((connection) => ({ kind: "connection" as const, connection })),
  ];
}
