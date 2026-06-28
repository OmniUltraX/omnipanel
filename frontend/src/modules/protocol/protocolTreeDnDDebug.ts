/** 协议 HTTP 接口树 HTML5 拖拽调试（开发环境默认开启） */
export const PROTO_TREE_DND_DEBUG =
  import.meta.env.DEV ||
  (typeof localStorage !== "undefined" &&
    localStorage.getItem("omnipanel-protocol-tree-dnd-debug") === "1");

const TAG = "[protocol-tree-dnd]";

const throttleAt = new Map<string, number>();
const THROTTLE_MS = 250;

export function dndLog(event: string, data?: Record<string, unknown>, throttleKey?: string): void {
  if (!PROTO_TREE_DND_DEBUG) return;
  if (throttleKey) {
    const now = Date.now();
    const last = throttleAt.get(throttleKey) ?? 0;
    if (now - last < THROTTLE_MS) return;
    throttleAt.set(throttleKey, now);
  }
  console.log(TAG, event, data ?? "");
}

export function describeDragTarget(target: EventTarget | null): Record<string, unknown> {
  if (!(target instanceof Element)) {
    return { kind: "non-element", value: String(target) };
  }
  const treeNode = target.closest(".tree-node") as HTMLElement | null;
  const sectionBody = target.closest(".vsplit-sidebar-section__body");
  const sectionHeader = target.closest(".vsplit-sidebar-section__header");
  return {
    tag: target.tagName.toLowerCase(),
    className: typeof target.className === "string" ? target.className : "",
    id: target.id || undefined,
    treeKey: treeNode?.dataset.treeKey,
    treeKind: treeNode?.dataset.treeKind,
    inTreeRoot: Boolean(target.closest(".proto-tree-root")),
    inSidebar: Boolean(target.closest(".proto-sidebar--tree")),
    inSectionBody: Boolean(sectionBody),
    inSectionHeader: Boolean(sectionHeader),
    inHistory: Boolean(target.closest(".proto-sidebar-history")),
    inDock: Boolean(target.closest(".dock-workspace, .dockview-container")),
  };
}

export function describeDataTransfer(dt: DataTransfer | null): Record<string, unknown> | null {
  if (!dt) return null;
  let plainPreview = "";
  try {
    plainPreview = dt.getData("text/plain");
  } catch {
    plainPreview = "<getData blocked during dragover>";
  }
  return {
    types: [...dt.types],
    effectAllowed: dt.effectAllowed,
    dropEffect: dt.dropEffect,
    plainPreview: plainPreview || undefined,
  };
}

export function summarizeDropEffectAfterPreventDefault(
  dt: DataTransfer,
  label: string,
): void {
  if (!PROTO_TREE_DND_DEBUG) return;
  if (dt.dropEffect === "none") {
    dndLog("dropEffect:none-after-preventDefault", {
      label,
      effectAllowed: dt.effectAllowed,
      types: [...dt.types],
    });
  }
}
