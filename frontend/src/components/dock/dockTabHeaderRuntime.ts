import { createContext, useContext, type MouseEvent } from "react";
import type { DockableTab } from "./dockableTab";

export interface DockTabHeaderRuntime {
  tabsRef: { current: DockableTab[] };
  activeTabIdRef?: { current: string };
  tabStyleRef: { current: "default" | "topbar" | "segment" };
  onTabContextMenuRef: {
    current:
      | ((event: MouseEvent, tabId: string, index: number) => void)
      | undefined;
  };
  onTabDoubleClickRef: {
    current: ((tabId: string) => void) | undefined;
  };
  /** 点击已激活 tab 时触发（dockview 不会再次派发 active 变更） */
  onTabClickRef?: {
    current: ((tabId: string, wasActive: boolean) => void) | undefined;
  };
}

export const DockTabHeaderRuntimeContext = createContext<DockTabHeaderRuntime | null>(
  null,
);

export function useDockTabHeaderRuntime(): DockTabHeaderRuntime | null {
  return useContext(DockTabHeaderRuntimeContext);
}
