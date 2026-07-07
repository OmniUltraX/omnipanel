/** SQL 查询文件树 HTML5 拖拽调试（开发环境默认开启） */
export const SQL_QUERY_FILE_DND_DEBUG =
  import.meta.env.DEV ||
  (typeof localStorage !== "undefined" &&
    localStorage.getItem("omnipanel-sql-query-file-dnd-debug") === "1");

const TAG = "[sql-query-file-dnd]";

const throttleAt = new Map<string, number>();
const THROTTLE_MS = 200;

export function sqlFileDndLog(
  event: string,
  data?: Record<string, unknown>,
  throttleKey?: string,
): void {
  if (!SQL_QUERY_FILE_DND_DEBUG) return;
  if (throttleKey) {
    const now = Date.now();
    const last = throttleAt.get(throttleKey) ?? 0;
    if (now - last < THROTTLE_MS) return;
    throttleAt.set(throttleKey, now);
  }
  console.log(TAG, event, data ?? "");
}

export function describeSqlFileDragTarget(target: EventTarget | null): Record<string, unknown> {
  if (!(target instanceof Element)) {
    return { kind: "non-element", value: String(target) };
  }
  const treeNode = target.closest(".sql-file-tree-node") as HTMLElement | null;
  return {
    tag: target.tagName.toLowerCase(),
    className: typeof target.className === "string" ? target.className : "",
    nodeId: treeNode?.dataset.sqlFileNodeId,
    nodeType: treeNode?.dataset.sqlFileNodeType,
    inTree: Boolean(target.closest(".sql-query-file-tree")),
    inSearch: Boolean(target.closest(".sql-query-file-search")),
  };
}

export function describeSqlFileDataTransfer(dt: DataTransfer | null): Record<string, unknown> | null {
  if (!dt) return null;
  let mimePreview = "";
  let plainPreview = "";
  try {
    mimePreview = dt.getData("application/x-omnipanel-sql-file-id");
  } catch {
    mimePreview = "<getData blocked>";
  }
  try {
    plainPreview = dt.getData("text/plain");
  } catch {
    plainPreview = "<getData blocked>";
  }
  return {
    types: [...dt.types],
    effectAllowed: dt.effectAllowed,
    dropEffect: dt.dropEffect,
    mimePreview: mimePreview || undefined,
    plainPreview: plainPreview || undefined,
  };
}
