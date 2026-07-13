import {
  createContext,
  useCallback,
  useContext,
  useRef,
  type ReactNode,
} from "react";
import type { TreeRowMouseEvent } from "./useTreeClickDelay";
import { useSidebarTreeMultiSelect } from "./useSidebarTreeMultiSelect";

type SidebarTreeSelectionContextValue = {
  registerKey: (key: string) => void;
  handleSelect: (key: string, event: TreeRowMouseEvent) => void;
  isSelected: (key: string) => boolean;
  selectedIds: ReadonlySet<string>;
};

const SidebarTreeSelectionContext = createContext<SidebarTreeSelectionContextValue | null>(null);

export function SidebarTreeSelectionProvider({
  children,
  orderedKeys,
}: {
  children: ReactNode;
  /** 虚拟树等场景：显式传入扁平顺序，供 Shift 范围多选使用 */
  orderedKeys?: readonly string[];
}) {
  const { handleSelect: applySelect, isSelected, selectedIds } = useSidebarTreeMultiSelect();
  const flatKeysRef = useRef<string[]>([]);
  flatKeysRef.current = [];

  const registerKey = useCallback((key: string) => {
    flatKeysRef.current.push(key);
  }, []);

  const handleSelect = useCallback(
    (key: string, event: TreeRowMouseEvent) => {
      applySelect(key, event, orderedKeys ?? flatKeysRef.current);
    },
    [applySelect, orderedKeys],
  );

  return (
    <SidebarTreeSelectionContext.Provider value={{ registerKey, handleSelect, isSelected, selectedIds }}>
      {children}
    </SidebarTreeSelectionContext.Provider>
  );
}

export function useSidebarTreeSelection(): SidebarTreeSelectionContextValue | null {
  return useContext(SidebarTreeSelectionContext);
}

/** 在渲染阶段登记节点 key，供 Shift 范围多选使用。 */
export function useSidebarTreeNodeSelection(treeKey: string | undefined) {
  const ctx = useSidebarTreeSelection();
  if (treeKey && ctx) {
    ctx.registerKey(treeKey);
  }
  return ctx;
}
