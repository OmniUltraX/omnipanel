import { useCallback, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  applySidebarTreeSelection,
  createSidebarTreeSelectionState,
  type SidebarTreeSelectionState,
} from "./sidebarTreeSelection";

export function useSidebarTreeMultiSelect(initialIds: Iterable<string> = []) {
  const [state, setState] = useState<SidebarTreeSelectionState>(() =>
    createSidebarTreeSelectionState(initialIds),
  );

  const handleSelect = useCallback(
    (nodeId: string, event: ReactMouseEvent, flatOrderedIds: readonly string[]) => {
      setState((prev) => applySidebarTreeSelection(prev, nodeId, event, flatOrderedIds));
    },
    [],
  );

  const isSelected = useCallback((nodeId: string) => state.selectedIds.has(nodeId), [state.selectedIds]);

  const clearSelection = useCallback(() => {
    setState(createSidebarTreeSelectionState());
  }, []);

  const setSelectedIds = useCallback((ids: Iterable<string>) => {
    setState(createSidebarTreeSelectionState(ids));
  }, []);

  return {
    selectedIds: state.selectedIds,
    anchorId: state.anchorId,
    handleSelect,
    isSelected,
    clearSelection,
    setSelectedIds,
  };
}
