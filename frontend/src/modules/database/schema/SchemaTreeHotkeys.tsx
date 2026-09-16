import { useEffect, useRef, type MutableRefObject } from "react";
import { useSidebarTreeSelection } from "@/components/ui/sidebar-tree";

/** Ctrl+A 全选 / Delete 删除（仅侧栏指针激活时响应，避免误触右侧面板）。 */
export function SchemaTreeHotkeys({
  allKeys,
  armedRef,
  onDeleteSelected,
}: {
  allKeys: readonly string[];
  armedRef: MutableRefObject<boolean>;
  onDeleteSelected: (selected: ReadonlySet<string>) => boolean | Promise<boolean>;
}) {
  const selection = useSidebarTreeSelection();
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!armedRef.current) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable=''], [contenteditable='true']",
        )
      ) {
        return;
      }

      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "a") {
        if (allKeys.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        selectionRef.current?.setSelectedIds(allKeys);
        return;
      }

      if (event.key === "Delete") {
        const selected = selectionRef.current?.selectedIds;
        if (!selected || selected.size === 0) return;
        event.preventDefault();
        event.stopPropagation();
        void Promise.resolve(onDeleteSelected(selected)).then((deleted) => {
          if (deleted) selectionRef.current?.clearSelection();
        });
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [allKeys, armedRef, onDeleteSelected]);

  return null;
}
