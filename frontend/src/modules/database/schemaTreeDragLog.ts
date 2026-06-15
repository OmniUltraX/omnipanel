const LOG_PREFIX = "[schema-tree-drag]";

/** 从 DOM 元素解析放置目标类型（Schema 树节点 / 工作区等）。 */
export function resolveSchemaDropTargetType(target: Element | null): string {
  if (!target) {
    return "unknown";
  }

  const treeNode = target.closest("[data-schema-item-type]");
  if (treeNode) {
    return treeNode.getAttribute("data-schema-item-type") ?? "unknown";
  }

  const typedDrop = target.closest("[data-schema-drop-type]");
  if (typedDrop) {
    return typedDrop.getAttribute("data-schema-drop-type") ?? "unknown";
  }

  if (target.closest("[data-schema-drop-zone]")) {
    return "workspace";
  }

  return "unknown";
}

/** 仅在 drop 时输出：拖动项类型 + 放置目标类型。 */
export function logSchemaTreeDrop(dragItemType: string, dropTargetType: string): void {
  console.log(LOG_PREFIX, { dragItemType, dropTargetType });
}
