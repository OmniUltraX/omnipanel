import { getSqlFileChildren, type DbSqlFileNode } from "../../../stores/dbSqlFileStore";
import type { DbTreeChartFileNode } from "../../../stores/dbTreeChartFileStore";

export type QueryTreeItem =
  | { kind: "sql-folder" | "sql-file"; node: DbSqlFileNode }
  | { kind: "tree-chart-file"; node: DbTreeChartFileNode };

export function isTreeChartFileId(id: string): boolean {
  return id.startsWith("ctr-file:");
}

export function getQueryTreeChildren(
  sqlNodes: DbSqlFileNode[],
  treeChartNodes: DbTreeChartFileNode[],
  parentId: string | null,
): QueryTreeItem[] {
  const sqlChildren = getSqlFileChildren(sqlNodes, parentId);
  const folders: QueryTreeItem[] = [];
  const files: QueryTreeItem[] = [];

  for (const node of sqlChildren) {
    if (node.type === "folder") {
      folders.push({ kind: "sql-folder", node });
      continue;
    }
    files.push({ kind: "sql-file", node });
  }

  for (const node of treeChartNodes) {
    if ((node.parentId ?? null) !== parentId) {
      continue;
    }
    files.push({ kind: "tree-chart-file", node });
  }

  files.sort((a, b) => {
    const nameA = a.kind === "tree-chart-file" ? a.node.name : a.node.name;
    const nameB = b.kind === "tree-chart-file" ? b.node.name : b.node.name;
    return nameA.localeCompare(nameB, undefined, { sensitivity: "base" });
  });

  return [...folders, ...files];
}

export function countQueryTreeRootItems(
  sqlNodes: DbSqlFileNode[],
  treeChartNodes: DbTreeChartFileNode[],
): number {
  return getQueryTreeChildren(sqlNodes, treeChartNodes, null).length;
}
