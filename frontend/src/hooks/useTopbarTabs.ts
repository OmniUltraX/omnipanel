import { useEffect, useRef } from "react";
import {
  useTopbarStore,
  type TopbarHandlers,
  type TopbarTabDef,
  type TopbarTabOptions,
} from "../stores/topbarStore";

export function useTopbarTabs(
  tabs: TopbarTabDef[],
  handlers: TopbarHandlers,
  options: TopbarTabOptions = {}
) {
  const handlerRef = useRef(handlers);
  handlerRef.current = handlers;
  const setTabs = useTopbarStore((s) => s.setTabs);
  const clearTabs = useTopbarStore((s) => s.clearTabs);

  const { mode, showAddTab, addTabTitle, enabled = true } = options;

  useEffect(() => {
    if (!enabled) {
      clearTabs();
      return;
    }
    setTabs(
      tabs,
      {
        onSelect: (id) => handlerRef.current.onSelect?.(id),
        onClose: (id) => handlerRef.current.onClose?.(id),
        onAdd: () => handlerRef.current.onAdd?.(),
      },
      { mode, showAddTab, addTabTitle }
    );
    return () => clearTabs();
  }, [tabs, mode, showAddTab, addTabTitle, enabled, setTabs, clearTabs]);
}
