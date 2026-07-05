import { useDbWorkspaceActiveTabId } from "../../contexts/DbWorkspaceContext";

/** Dock 面板激活态：以 Context 为准，避免 renderPanel 闭包中的 active 过期。 */
export function useDbDockTabActive(tabId: string): boolean {
  const activeTabId = useDbWorkspaceActiveTabId();
  return tabId === activeTabId;
}
