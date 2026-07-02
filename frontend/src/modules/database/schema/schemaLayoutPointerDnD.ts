export type SchemaLayoutDragPayload =
  | { kind: "connection"; connId: string }
  | { kind: "connection-folder"; folderId: string };

export const SCHEMA_LAYOUT_POINTER_DRAG_THRESHOLD = 5;

export function resolveLayoutDropFromPointer(
  clientX: number,
  clientY: number,
): { hoverNodeId: string | null; targetFolderId: string | null } {
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit?.closest(".schema-tree")) {
    return { hoverNodeId: null, targetFolderId: null };
  }
  const folderNode = hit.closest(
    '[data-schema-item-type="connection-folder"]',
  ) as HTMLElement | null;
  if (folderNode?.dataset.schemaNodeId) {
    return {
      hoverNodeId: folderNode.dataset.schemaNodeId,
      targetFolderId: folderNode.dataset.schemaNodeId,
    };
  }
  const layoutNode = hit.closest(
    '[data-schema-item-type="connection"], [data-schema-item-type="connection-folder"]',
  ) as HTMLElement | null;
  return {
    hoverNodeId: layoutNode?.dataset.schemaNodeId ?? null,
    targetFolderId: null,
  };
}

export function createLayoutDragGhost(sourceElement: HTMLElement, label: string): HTMLElement {
  const ghost = sourceElement.cloneNode(true) as HTMLElement;
  ghost.classList.add("tree-node--layout-drag-ghost");
  ghost.style.position = "fixed";
  ghost.style.left = "-1000px";
  ghost.style.top = "-1000px";
  ghost.style.width = `${sourceElement.offsetWidth}px`;
  ghost.style.pointerEvents = "none";
  ghost.style.zIndex = "10000";
  ghost.setAttribute("aria-hidden", "true");
  if (!ghost.textContent?.trim()) {
    ghost.textContent = label;
  }
  document.body.appendChild(ghost);
  return ghost;
}

export function isLayoutPointerDragExcludedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(target.closest(".tree-arrow, button, .tree-node-trailing, .tree-badge"));
}
