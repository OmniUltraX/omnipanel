import { commands } from "../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../ipc/result";
import { useTerminalStore } from "../stores/terminalStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { resolveResourceById } from "../stores/connectionStore";
import { MODULE_PATHS } from "./paths";

export { createTerminalSessionId } from "../stores/terminalStore";

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
  // addTab 在已有 activeTabId 时不会切到新 Tab；统一强制激活并同步 dock
  useTerminalStore.getState().setActiveTab(tabId);
  useWorkspaceStore.getState().selectResource(hostId);
  navigateToPath(MODULE_PATHS.terminal);
  window.dispatchEvent(
    new CustomEvent("omnipanel-terminal-focus-tab", { detail: { tabId } }),
  );
  return tabId;
}

/**
 * 从远端会话治理视图「进入」指定 tmux 会话：建连并开新 Tab。
 *
 * 调用方（TmuxSessionsDetailTab.handleEnter）已先检查当前窗口是否已有该会话的 Tab，
 * 有则聚焦、无则调用本函数开新 Tab。本函数只负责「建连 + 开 Tab」，不做去重。
 *
 * 「重新连接」语义：Tab 关闭时后端只 detach（不 kill 会话），远端进程继续运行；
 * 再次「进入」同一会话即恢复之前的操作上下文（tmux attach 会重放屏幕 + 接管 PTY）。
 */
export async function attachTmuxSession(
  hostId: string,
  sessionName: string,
  cols = 80,
  rows = 24,
): Promise<string> {
  const store = useTerminalStore.getState();
  const host = resolveResourceById(hostId);
  const title = host?.name ? `${host.name} · ${sessionName}` : sessionName;

  const backendSid = await unwrapCommand(
    commands.sshTmuxAttachSession(hostId, sessionName, cols, rows, null),
  ).catch((err) => {
    throw new Error(formatIpcError(err));
  });

  const tabId = store.addSshTerminalTab(hostId, title, undefined, sessionName);
  // addTab 总是把 backendSessionId 置空（runtime 未注入），这里显式回填，
  // 让 useTerminal 的 ensureBackendSession 走 reusableSid 分支而非重新建连。
  store.setBackendSessionId(tabId, backendSid);
  store.setActiveTab(tabId);
  useWorkspaceStore.getState().selectResource(hostId);
  navigateToPath(MODULE_PATHS.terminal);
  window.dispatchEvent(
    new CustomEvent("omnipanel-terminal-focus-tab", { detail: { tabId } }),
  );
  return tabId;
}

export function openLocalTerminalSession(): string {
  const tabId = useTerminalStore.getState().openOrFocusLocalTab();
  useTerminalStore.getState().setActiveTab(tabId);
  useWorkspaceStore.getState().selectResource("local-terminal");
  navigateToPath(MODULE_PATHS.terminal);
  window.dispatchEvent(
    new CustomEvent("omnipanel-terminal-focus-tab", { detail: { tabId } }),
  );
  return tabId;
}

export function getResourceIdForTab(tabId: string): string {
  const tab = useTerminalStore.getState().tabs.find((item) => item.id === tabId);
  if (!tab) return "local-terminal";
  return tab.session.resourceId;
}
