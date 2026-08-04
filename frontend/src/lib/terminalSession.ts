import { commands } from "../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../ipc/result";
import { useTerminalStore } from "../stores/terminalStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { resolveResourceById } from "../stores/connectionStore";
import { useTerminalHistoryStore } from "../stores/terminalHistoryStore";
import {
  upsertTmuxPaneSessionBinding,
  useTmuxPaneSessionIndex,
} from "../modules/terminal/tmuxPaneSessionIndex";
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
 * 从远端会话治理视图进入指定 tmux 会话 / window。
 *
 * - `paneId` 有值：attach 回该 pane；若 pane↔sessionId 索引命中则复用前端会话
 *   （Blocks / shell history / AI linkedTerminalSessionId 一并续上）。
 * - `paneId` 为空：优先复用该 session 下最近绑定的 pane；否则 new-window。
 */
export async function attachTmuxSession(
  hostId: string,
  sessionName: string,
  cols = 80,
  rows = 24,
  paneId: number | null = null,
): Promise<string> {
  const store = useTerminalStore.getState();
  const host = resolveResourceById(hostId);
  const title = host?.name ? `${host.name} · ${sessionName}` : sessionName;
  const index = useTmuxPaneSessionIndex.getState();

  let resolvedPaneId = paneId;
  if (resolvedPaneId == null) {
    resolvedPaneId = index.latestForSession(hostId, sessionName)?.paneId ?? null;
  }

  let reuseSessionId: string | null = null;
  if (resolvedPaneId != null) {
    const binding = index.find(hostId, sessionName, resolvedPaneId);
    if (binding) {
      const entity = store.getSession(binding.sessionId);
      if (entity && entity.lifecycle !== "ended") {
        reuseSessionId = binding.sessionId;
      }
    }
  }

  const backendSid = await unwrapCommand(
    commands.sshTmuxAttachSession(hostId, sessionName, cols, rows, resolvedPaneId),
  ).catch((err) => {
    throw new Error(formatIpcError(err));
  });

  let tabId: string;
  if (reuseSessionId) {
    tabId = store.openSessionTab(reuseSessionId);
    store.setSessionTmuxSession(reuseSessionId, sessionName);
    if (resolvedPaneId != null) {
      store.setSessionTmuxPaneId(reuseSessionId, resolvedPaneId);
    }
    store.renameSession(reuseSessionId, title);
  } else {
    tabId = store.addSshTerminalTab(
      hostId,
      title,
      undefined,
      sessionName,
      resolvedPaneId,
    );
  }

  // addTab / openSessionTab 的 backendSessionId 可能来自旧 detachedRuntime，统一覆盖为本次 attach
  store.setBackendSessionId(tabId, backendSid);
  store.setActiveTab(tabId);

  if (resolvedPaneId != null) {
    upsertTmuxPaneSessionBinding(hostId, sessionName, resolvedPaneId, tabId);
  }

  void useTerminalHistoryStore.getState().restoreSession(tabId);

  useWorkspaceStore.getState().selectResource(hostId);
  navigateToPath(MODULE_PATHS.terminal);
  window.dispatchEvent(
    new CustomEvent("omnipanel-terminal-focus-tab", { detail: { tabId } }),
  );
  return tabId;
}

/** 在指定 session 下强制新建一个 window（不复用 pane 绑定） */
export async function attachTmuxSessionNewWindow(
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

  const tabId = store.addSshTerminalTab(hostId, title, undefined, sessionName, null);
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
