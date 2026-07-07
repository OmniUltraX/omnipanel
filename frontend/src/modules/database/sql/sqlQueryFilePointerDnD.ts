export const SQL_QUERY_FILE_POINTER_DRAG_THRESHOLD_PX = 5;

export type SqlQueryFilePointerDropTarget =
  | { kind: "root" }
  | { kind: "folder"; folderId: string };

export function isSqlQueryFilePointerDragExcluded(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return true;
  }
  return Boolean(target.closest(".tree-arrow, button, .schema-toolbar, .scoped-search-input"));
}

export function resolveSqlQueryFileDropFromPointer(
  clientX: number,
  clientY: number,
  treeRoot: HTMLElement | null,
): SqlQueryFilePointerDropTarget | null {
  if (!treeRoot) {
    return null;
  }

  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit?.closest(".sql-query-file-tree")) {
    return null;
  }

  if (hit.closest(".sql-file-tree-node--file")) {
    return null;
  }

  const folderNode = hit.closest(
    '.sql-file-tree-node--folder[data-sql-file-node-id]',
  ) as HTMLElement | null;
  if (folderNode?.dataset.sqlFileNodeId) {
    return { kind: "folder", folderId: folderNode.dataset.sqlFileNodeId };
  }

  if (hit.closest(".sql-query-file-tree")) {
    return { kind: "root" };
  }

  return null;
}
