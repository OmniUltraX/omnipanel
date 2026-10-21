import { resolveSidebarTreeDeleteTargets } from "./resolveSidebarTreeDeleteTargets";

export type SidebarTreeKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
};

export type SidebarTreeKeyNode = {
  key: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  canRename: boolean;
  canDelete: boolean;
  canActivate: boolean;
  canToggle: boolean;
  canRefresh: boolean;
};

export type SidebarTreeKeyState = {
  selectedIds: ReadonlySet<string>;
  anchorId: string | null;
  focusId: string | null;
};

export type SidebarTreeKeyAction =
  | {
      type: "selection";
      selectedIds: string[];
      anchorId: string | null;
      focusId: string | null;
    }
  | { type: "rename"; key: string }
  | { type: "delete"; keys: string[] }
  | { type: "activate"; key: string }
  | { type: "toggle"; key: string }
  | { type: "refresh"; key: string };

function focusIndex(state: SidebarTreeKeyState, nodes: readonly SidebarTreeKeyNode[]): number {
  const preferred = [state.focusId, state.anchorId, ...state.selectedIds];
  for (const id of preferred) {
    if (!id) continue;
    const index = nodes.findIndex((node) => node.key === id);
    if (index >= 0) return index;
  }
  return -1;
}

function selectionAt(
  nodes: readonly SidebarTreeKeyNode[],
  index: number,
  state: SidebarTreeKeyState,
  event: SidebarTreeKeyEvent,
): SidebarTreeKeyAction | null {
  if (nodes.length === 0) return null;
  const nextIndex = Math.min(nodes.length - 1, Math.max(0, index));
  const next = nodes[nextIndex];
  if (!next) return null;
  const mod = event.ctrlKey || event.metaKey;

  if (event.shiftKey) {
    const anchorKey =
      state.anchorId && nodes.some((node) => node.key === state.anchorId)
        ? state.anchorId
        : (nodes[focusIndex(state, nodes)]?.key ?? next.key);
    const anchorIndex = nodes.findIndex((node) => node.key === anchorKey);
    const from = Math.min(anchorIndex < 0 ? nextIndex : anchorIndex, nextIndex);
    const to = Math.max(anchorIndex < 0 ? nextIndex : anchorIndex, nextIndex);
    const range = nodes.slice(from, to + 1).map((node) => node.key);
    const selectedIds = mod ? [...new Set([...state.selectedIds, ...range])] : range;
    return {
      type: "selection",
      selectedIds,
      anchorId: anchorKey,
      focusId: next.key,
    };
  }

  if (mod) {
    return {
      type: "selection",
      selectedIds: [...state.selectedIds],
      anchorId: state.anchorId,
      focusId: next.key,
    };
  }

  return {
    type: "selection",
    selectedIds: [next.key],
    anchorId: next.key,
    focusId: next.key,
  };
}

function parentIndex(nodes: readonly SidebarTreeKeyNode[], index: number): number {
  const depth = nodes[index]?.depth ?? 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if ((nodes[i]?.depth ?? 0) < depth) return i;
  }
  return -1;
}

/** 资源树键盘动作。返回 null 表示这颗键留给别的层（搜索、标签重命名等）。 */
export function resolveSidebarTreeKeyAction(
  event: SidebarTreeKeyEvent,
  state: SidebarTreeKeyState,
  nodes: readonly SidebarTreeKeyNode[],
  options?: { selectAllIds?: readonly string[] },
): SidebarTreeKeyAction | null {
  if (event.altKey || nodes.length === 0) return null;
  const mod = event.ctrlKey || event.metaKey;
  const index = focusIndex(state, nodes);
  const current = index >= 0 ? nodes[index] : null;

  if (mod && event.key.toLowerCase() === "a" && !event.shiftKey) {
    const ids = options?.selectAllIds?.length
      ? [...options.selectAllIds]
      : nodes.map((node) => node.key);
    if (ids.length === 0) return null;
    const focusId = current?.key ?? ids[0] ?? null;
    return {
      type: "selection",
      selectedIds: ids,
      anchorId: state.anchorId ?? focusId,
      focusId,
    };
  }

  if (event.key === "Escape" && !mod && !event.shiftKey) {
    if (state.selectedIds.size <= 1 || !current) return null;
    return {
      type: "selection",
      selectedIds: [current.key],
      anchorId: current.key,
      focusId: current.key,
    };
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const from = index < 0 ? (delta > 0 ? -1 : nodes.length) : index;
    return selectionAt(nodes, from + delta, state, event);
  }

  if (event.key === "Home" || event.key === "End") {
    if (mod) return null;
    return selectionAt(nodes, event.key === "Home" ? 0 : nodes.length - 1, state, event);
  }

  if (event.key === "ArrowRight" && !mod && !event.shiftKey) {
    if (!current) return selectionAt(nodes, 0, state, event);
    if (current.hasChildren && !current.expanded && current.canToggle) {
      return { type: "toggle", key: current.key };
    }
    const child = nodes[index + 1];
    if (current.expanded && child && child.depth > current.depth) {
      return selectionAt(nodes, index + 1, state, event);
    }
    return null;
  }

  if ((event.key === "ArrowLeft" && !mod && !event.shiftKey) || (event.key === "Backspace" && !mod && !event.shiftKey)) {
    if (!current) return null;
    if (current.expanded && current.hasChildren && current.canToggle) {
      return { type: "toggle", key: current.key };
    }
    const parent = parentIndex(nodes, index);
    if (parent >= 0) return selectionAt(nodes, parent, state, event);
    return null;
  }

  if ((event.key === "Delete" || (event.key === "Backspace" && mod)) && !event.shiftKey && !event.repeat) {
    const clickedId = current?.key;
    if (!clickedId && state.selectedIds.size === 0) return null;
    const keys = clickedId
      ? resolveSidebarTreeDeleteTargets(clickedId, state.selectedIds)
      : [...state.selectedIds];
    if (keys.length === 0) return null;
    return { type: "delete", keys };
  }

  if (event.key === "F2" && !mod && !event.shiftKey && !event.repeat) {
    if (!current?.canRename) return null;
    if (state.selectedIds.size > 1) return null;
    return { type: "rename", key: current.key };
  }

  if (event.key === "Enter" && !mod && !event.shiftKey && !event.repeat) {
    if (!current) return selectionAt(nodes, 0, state, event);
    if (current.canActivate) return { type: "activate", key: current.key };
    if (current.canToggle && current.hasChildren) return { type: "toggle", key: current.key };
    return null;
  }

  if (event.key === "F5" && !mod && !event.shiftKey && !event.repeat) {
    if (!current?.canRefresh) return null;
    return { type: "refresh", key: current.key };
  }

  if (event.key === " " && mod && !event.shiftKey && !event.repeat && current) {
    const next = new Set(state.selectedIds);
    if (next.has(current.key)) next.delete(current.key);
    else next.add(current.key);
    return {
      type: "selection",
      selectedIds: [...next],
      anchorId: current.key,
      focusId: current.key,
    };
  }

  return null;
}
