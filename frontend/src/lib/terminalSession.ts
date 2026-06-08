import { useTerminalStore } from "../stores/terminalStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { resolveResourceById } from "../stores/connectionStore";

export { createTerminalTabId } from "../stores/terminalStore";

export function navigateToPath(path: string) {
  useWorkspaceStore.getState().setActivePath(path);
  window.dispatchEvent(new CustomEvent("omnipanel-navigate", { detail: { path } }));
}

export function openSshTerminalSession(hostId: string): string | null {
  const host = resolveResourceById(hostId);
  if (!host || host.type !== "ssh") return null;

  const tabId = useTerminalStore.getState().openOrFocusSshTab(hostId, host.name);
  useWorkspaceStore.getState().selectResource(hostId);
  navigateToPath("/terminal");
  return tabId;
}

export function openLocalTerminalSession(): string {
  const tabId = useTerminalStore.getState().openOrFocusLocalTab();
  useWorkspaceStore.getState().selectResource("local-terminal");
  navigateToPath("/terminal");
  return tabId;
}

export function getResourceIdForTab(tabId: string): string {
  const tab = useTerminalStore.getState().tabs.find((item) => item.id === tabId);
  if (!tab) return "local-terminal";

  const activePane = tab.panes.find((pane) => pane.id === tab.activePaneId) ?? tab.panes[0];
  return activePane?.resourceId ?? "local-terminal";
}
