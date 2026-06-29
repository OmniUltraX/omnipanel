import type { ProtocolTreeNodeKey } from "../../stores/protocolHttpLayoutStore";
import { resolveDropPosition, resolveTreeEntryByKey, type ProtocolTreeEntry } from "./protocolLayoutTree";

export { resolveTreeEntryByKey };

export const PROTO_TREE_POINTER_DRAG_THRESHOLD_PX = 5;

export type ProtocolTreePointerDropTarget =
  | { kind: "root" }
  | { kind: "node"; targetKey: ProtocolTreeNodeKey; position: "before" | "after" | "inside" };

export function isProtocolTreePointerDragExcluded(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return Boolean(
    target.closest(".tree-arrow, button, .proto-sidebar-new, .vsplit-sidebar-section__header"),
  );
}

export function resolveProtocolTreeDropFromPointer(
  clientX: number,
  clientY: number,
  treeRoot: HTMLElement | null,
): ProtocolTreePointerDropTarget | null {
  if (!treeRoot) return null;

  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit?.closest(".proto-tree-root, .proto-sidebar--tree")) {
    return null;
  }

  const node = hit.closest(".proto-tree-root .tree-node[data-tree-key]") as HTMLElement | null;
  if (node?.dataset.treeKey && node.dataset.treeKind) {
    const targetKey = node.dataset.treeKey as ProtocolTreeNodeKey;
    const kind = node.dataset.treeKind as ProtocolTreeEntry["kind"];
    const position = resolveDropPosition({ clientY }, node, kind);
    return { kind: "node", targetKey, position };
  }

  if (hit.closest(".proto-tree-root")) {
    return { kind: "root" };
  }

  return null;
}
