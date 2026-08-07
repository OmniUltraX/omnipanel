import type { DbSqlFileNode } from "../../../stores/dbSqlFileStore";

/** 列出绑定到指定连接与库的 SQL 查询文件（仅 file 节点）。 */
export function listBoundSqlFiles(
  nodes: readonly DbSqlFileNode[],
  connId: string,
  database: string,
): DbSqlFileNode[] {
  const db = database.trim();
  if (!connId || !db) {
    return [];
  }
  return nodes.filter(
    (node) =>
      node.type === "file" && node.connId === connId && (node.database?.trim() ?? "") === db,
  );
}
