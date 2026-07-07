import { useTerminalStore } from "../stores/terminalStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { resolveResourceById } from "../stores/connectionStore";
import { MODULE_PATHS } from "./paths";

export { createTerminalTabId } from "../stores/terminalStore";

export function navigateToPath(path: string) {
  useWorkspaceStore.getState().setActivePath(path);
  window.dispatchEvent(new CustomEvent("omnipanel-navigate", { detail: { path } }));
}

/** 聚焦指定终端标签（切换 store 状态并通知 TerminalPanel 同步 dock） */
export function focusTerminalTab(tabId: string): boolean {
  const tab = useTerminalStore.getState().tabs.find(
    (item) => item.id === tabId || item.sessionId === tabId,
  );
  if (!tab) return false;

  useTerminalStore.getState().setActiveTab(tab.id);
  useWorkspaceStore.getState().selectResource(tab.session.resourceId);
  navigateToPath(MODULE_PATHS.terminal);
  window.dispatchEvent(
    new CustomEvent("omnipanel-terminal-focus-tab", { detail: { tabId: tab.id } }),
  );
  return true;
}

export function openSshTerminalSession(hostId: string): string | null {
  const host = resolveResourceById(hostId);
  if (!host || host.type !== "ssh") return null;

  const tabId = useTerminalStore.getState().openOrFocusSshTab(hostId, host.name);
  useWorkspaceStore.getState().selectResource(hostId);
  navigateToPath(MODULE_PATHS.terminal);
  return tabId;
}

export function openLocalTerminalSession(): string {
  const tabId = useTerminalStore.getState().openOrFocusLocalTab();
  useWorkspaceStore.getState().selectResource("local-terminal");
  navigateToPath(MODULE_PATHS.terminal);
  return tabId;
}

export function getResourceIdForTab(tabId: string): string {
  const tab = useTerminalStore.getState().tabs.find((item) => item.id === tabId);
  if (!tab) return "local-terminal";
  return tab.session.resourceId;
}
