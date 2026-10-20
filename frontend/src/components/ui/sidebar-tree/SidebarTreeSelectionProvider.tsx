import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { TreeRowMouseEvent } from "./useTreeClickDelay";
import { useSidebarTreeMultiSelect } from "./useSidebarTreeMultiSelect";
import {
  resolveSidebarTreeKeyAction,
  type SidebarTreeKeyNode,
} from "./sidebarTreeKeyboard";

export type SidebarTreeNodeSnapshot = {
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  onToggle?: () => void;
  onActivate?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onRefresh?: () => void;
};

type SidebarTreeSelectionContextValue = {
  registerKey: (key: string) => void;
  registerNode: (key: string, getSnapshot: () => SidebarTreeNodeSnapshot) => () => void;
  bindKeyboardRoot: (element: HTMLElement | null) => () => void;
  handleSelect: (key: string, event: TreeRowMouseEvent) => void;
  isSelected: (key: string) => boolean;
  selectedIds: ReadonlySet<string>;
  focusId: string | null;
  setSelectedIds: (ids: Iterable<string>) => void;
  clearSelection: () => void;
};

const SidebarTreeSelectionContext = createContext<SidebarTreeSelectionContextValue | null>(null);

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element?.closest) return false;
  return Boolean(
    element.closest("input, textarea, select, button, a, [contenteditable=''], [contenteditable='true']"),
  );
}

export function SidebarTreeSelectionProvider({
  children,
  orderedKeys,
  onSelectedIdsChange,
  onDeleteSelected,
}: {
  children: ReactNode;
  /** 虚拟树等场景：显式传入扁平顺序，供 Shift 范围多选使用 */
  orderedKeys?: readonly string[];
  /** 供 Provider 外的右键菜单等读取当前多选 */
  onSelectedIdsChange?: (ids: ReadonlySet<string>) => void;
  /**
   * Delete 删除当前选区。返回 true 时清空选区。
   * 不传时，改为调用焦点节点自己的 onDelete。
   */
  onDeleteSelected?: (selected: ReadonlySet<string>) => boolean | Promise<boolean>;
}) {
  const {
    handleSelect: applySelect,
    isSelected,
    selectedIds,
    setSelectedIds,
    replaceSelection,
    clearSelection,
    anchorId,
  } = useSidebarTreeMultiSelect();
  const [focusId, setFocusId] = useState<string | null>(null);
  const [keyboardRoot, setKeyboardRoot] = useState<HTMLElement | null>(null);
  const flatKeysRef = useRef<string[]>([]);
  flatKeysRef.current = [];
  const orderedKeysRef = useRef(orderedKeys);
  orderedKeysRef.current = orderedKeys;
  const nodesRef = useRef(new Map<string, () => SidebarTreeNodeSnapshot>());
  const onDeleteSelectedRef = useRef(onDeleteSelected);
  const clearSelectionAndFocus = useCallback(() => {
    clearSelection();
    setFocusId(null);
  }, [clearSelection]);
  onDeleteSelectedRef.current = onDeleteSelected;
  const selectionRef = useRef({ selectedIds, anchorId, focusId });
  selectionRef.current = { selectedIds, anchorId, focusId };

  useEffect(() => {
    onSelectedIdsChange?.(selectedIds);
  }, [onSelectedIdsChange, selectedIds]);

  const registerKey = useCallback((key: string) => {
    flatKeysRef.current.push(key);
  }, []);

  const registerNode = useCallback((key: string, getSnapshot: () => SidebarTreeNodeSnapshot) => {
    nodesRef.current.set(key, getSnapshot);
    return () => {
      if (nodesRef.current.get(key) === getSnapshot) nodesRef.current.delete(key);
    };
  }, []);

  const bindKeyboardRoot = useCallback((element: HTMLElement | null) => {
    if (!element) return () => undefined;
    element.setAttribute("data-sidebar-tree-keyboard", "");
    setKeyboardRoot(element);
    return () => {
      element.removeAttribute("data-sidebar-tree-keyboard");
      setKeyboardRoot((current) => (current === element ? null : current));
    };
  }, []);

  const handleSelect = useCallback(
    (key: string, event: TreeRowMouseEvent) => {
      applySelect(key, event, orderedKeys ?? flatKeysRef.current);
      setFocusId(key);
    },
    [applySelect, orderedKeys],
  );

  useEffect(() => {
    if (!keyboardRoot) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!keyboardRoot.contains(event.target as Node)) return;
      if (isEditableTarget(event.target)) return;

      const order = orderedKeysRef.current?.length
        ? orderedKeysRef.current
        : flatKeysRef.current;
      const nodes: SidebarTreeKeyNode[] = [];
      for (const key of order) {
        const read = nodesRef.current.get(key);
        if (!read) continue;
        const snapshot = read();
        nodes.push({
          key,
          depth: snapshot.depth,
          hasChildren: snapshot.hasChildren,
          expanded: snapshot.expanded,
          canRename: Boolean(snapshot.onRename),
          canDelete: Boolean(snapshot.onDelete) || Boolean(onDeleteSelectedRef.current),
          canActivate: Boolean(snapshot.onActivate),
          canToggle: Boolean(snapshot.onToggle),
          canRefresh: Boolean(snapshot.onRefresh),
        });
      }
      const current = selectionRef.current;
      const action = resolveSidebarTreeKeyAction(
        event,
        current,
        nodes,
        { selectAllIds: orderedKeysRef.current },
      );
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();

      if (action.type === "selection") {
        replaceSelection(action.selectedIds, action.anchorId);
        setFocusId(action.focusId);
        return;
      }
      if (action.type === "delete") {
        const deleteSelected = onDeleteSelectedRef.current;
        if (deleteSelected) {
          void Promise.resolve(deleteSelected(new Set(action.keys))).then((deleted) => {
            if (deleted) clearSelectionAndFocus();
          });
          return;
        }
        const focusKey = current.focusId && action.keys.includes(current.focusId)
          ? current.focusId
          : action.keys[0];
        if (focusKey) nodesRef.current.get(focusKey)?.().onDelete?.();
        return;
      }
      const snapshot = nodesRef.current.get(action.key)?.();
      if (action.type === "rename") snapshot?.onRename?.();
      if (action.type === "activate") snapshot?.onActivate?.();
      if (action.type === "toggle") snapshot?.onToggle?.();
      if (action.type === "refresh") snapshot?.onRefresh?.();
    };
    keyboardRoot.addEventListener("keydown", onKeyDown, true);
    return () => keyboardRoot.removeEventListener("keydown", onKeyDown, true);
  }, [clearSelectionAndFocus, keyboardRoot, replaceSelection]);

  const contextValue = useMemo(
    () => ({
      registerKey,
      registerNode,
      bindKeyboardRoot,
      handleSelect,
      isSelected,
      selectedIds,
      focusId,
      setSelectedIds,
      clearSelection: clearSelectionAndFocus,
    }),
    [
      registerKey,
      registerNode,
      bindKeyboardRoot,
      handleSelect,
      isSelected,
      selectedIds,
      focusId,
      setSelectedIds,
      clearSelectionAndFocus,
    ],
  );

  return (
    <SidebarTreeSelectionContext.Provider value={contextValue}>
      {children}
    </SidebarTreeSelectionContext.Provider>
  );
}

export function useSidebarTreeSelection(): SidebarTreeSelectionContextValue | null {
  return useContext(SidebarTreeSelectionContext);
}

/** 树根不在 SidebarTreeRoot 里时，把已有滚动容器登记成键盘根。 */
export function SidebarTreeKeyboardRoot({
  targetRef,
}: {
  targetRef: { readonly current: HTMLElement | null };
}) {
  const selection = useSidebarTreeSelection();
  const bindKeyboardRoot = selection?.bindKeyboardRoot;
  useEffect(() => {
    const element = targetRef.current;
    if (!element || !bindKeyboardRoot) return;
    return bindKeyboardRoot(element);
  }, [bindKeyboardRoot, targetRef]);
  return null;
}

/** 在渲染阶段登记节点 key，供 Shift 范围多选使用。 */
export function useSidebarTreeNodeSelection(treeKey: string | undefined) {
  const ctx = useSidebarTreeSelection();
  if (treeKey && ctx) {
    ctx.registerKey(treeKey);
  }
  return ctx;
}
