import type { MouseEvent as ReactMouseEvent } from "react";

export type SidebarTreeSelectionState = {
  selectedIds: Set<string>;
  anchorId: string | null;
};

export function createSidebarTreeSelectionState(
  initialIds: Iterable<string> = [],
): SidebarTreeSelectionState {
  return {
    selectedIds: new Set(initialIds),
    anchorId: null,
  };
}

/** 根据单击 / Shift / Ctrl|Meta 更新树节点多选集合。 */
export function applySidebarTreeSelection(
  state: SidebarTreeSelectionState,
  nodeId: string,
  event: ReactMouseEvent,
  flatOrderedIds: readonly string[],
): SidebarTreeSelectionState {
  const toggleId = (ids: Set<string>, id: string) => {
    const next = new Set(ids);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const rangeIds = (anchorId: string, targetId: string) => {
    const anchorIndex = flatOrderedIds.indexOf(anchorId);
    const targetIndex = flatOrderedIds.indexOf(targetId);
    if (anchorIndex < 0 || targetIndex < 0) return [targetId];
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    return flatOrderedIds.slice(start, end + 1);
  };

  const multi = event.ctrlKey || event.metaKey;
  const range = event.shiftKey;

  if (range && state.anchorId) {
    const ids = rangeIds(state.anchorId, nodeId);
    if (multi) {
      const next = new Set(state.selectedIds);
      for (const id of ids) next.add(id);
      return { selectedIds: next, anchorId: state.anchorId };
    }
    return { selectedIds: new Set(ids), anchorId: state.anchorId };
  }

  if (multi) {
    return {
      selectedIds: toggleId(state.selectedIds, nodeId),
      anchorId: nodeId,
    };
  }

  return {
    selectedIds: new Set([nodeId]),
    anchorId: nodeId,
  };
}
