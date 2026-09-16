import { useEffect, useRef } from "react";
import { useSidebarTreeSelection } from "@/components/ui/sidebar-tree";

export function SchemaTreeSelectionSync({ targetId }: { targetId: string | null }) {
  const selection = useSidebarTreeSelection();
  const setSelectedIds = selection?.setSelectedIds;
  const clearSelection = selection?.clearSelection;
  const selectedIdsRef = useRef<ReadonlySet<string> | null>(null);
  if (selection) {
    selectedIdsRef.current = selection.selectedIds;
  }
  useEffect(() => {
    if (!setSelectedIds || !clearSelection) return;
    const current = selectedIdsRef.current;
    if (targetId) {
      if (current?.size === 1 && current.has(targetId)) return;
      setSelectedIds([targetId]);
    } else {
      if (!current || current.size === 0) return;
      clearSelection();
    }
  }, [targetId, setSelectedIds, clearSelection]);
  return null;
}
