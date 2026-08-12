import { commands } from "../../../ipc/bindings";
import { MODULE_PATHS } from "../../../lib/paths";
import { followUiIntent } from "../../../lib/ai/uiFollow";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useTerminalStore } from "../../../stores/terminalStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { showToast } from "../../../stores/toastStore";
import { findPanelForSsh } from "../panel/serverConnection";

const DOCKER_ACTIVE_KEY = "omnipanel.docker.activeConnectionId";
const SFTP_DEEP_LINK_KEY = "omnipanel.openSftpForSsh";
/** 已在文件页时再次跳转 SFTP 的兜底事件（location.state 可能不变） */
export const OPEN_SFTP_FOR_SSH_EVENT = "omnipanel:open-sftp-for-ssh";

export type SshSftpDeepLink = {
  openSftpForSshId: string;
  openSftpHostName?: string;
  openSftpNonce: number;
  /** 可选：打开后定位到该远端目录 */
  openSftpPath?: string;
};

export type JumpNavigate = (
  to: string,
  opts?: { state?: unknown; replace?: boolean },
) => void;

/** 打开 / 聚焦该 SSH 主机的终端会话。 */
export function jumpSshTerminal(sshId: string, name: string): void {
  const tabId = useTerminalStore.getState().openOrFocusSshTab(sshId, name);
  useTerminalStore.getState().setActiveTab(tabId);
  useWorkspaceStore.getState().setActivePath(MODULE_PATHS.terminal);
  followUiIntent({ type: "focusModule", module: "terminal" });
}

function writeSftpDeepLink(link: SshSftpDeepLink): void {
  try {
    sessionStorage.setItem(SFTP_DEEP_LINK_KEY, JSON.stringify(link));
  } catch {
    // ignore quota / private mode
  }
}

/** 清除待处理的 SFTP 深链接（消费成功或取消时调用）。 */
export function clearSftpDeepLink(): void {
  try {
    sessionStorage.removeItem(SFTP_DEEP_LINK_KEY);
  } catch {
    // ignore
  }
}

/** 供 FilesPanel 读取并清除待处理的 SFTP 深链接。 */
export function takeSftpDeepLink(): SshSftpDeepLink | null {
  try {
    const raw = sessionStorage.getItem(SFTP_DEEP_LINK_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(SFTP_DEEP_LINK_KEY);
    const parsed = JSON.parse(raw) as SshSftpDeepLink;
    if (!parsed?.openSftpForSshId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 跳转到文件管理并打开该 SSH 关联的 SFTP。
 * 已有关联连接则打开；缺失由 FilesPanel 自动创建。
 */
export function jumpSshSftp(
  sshId: string,
  options?: { hostName?: string; path?: string; navigate?: JumpNavigate },
): void {
  const state: SshSftpDeepLink = {
    openSftpForSshId: sshId,
    openSftpHostName: options?.hostName,
    openSftpPath: options?.path,
    openSftpNonce: Date.now(),
  };
  writeSftpDeepLink(state);
  if (options?.navigate) {
    options.navigate(MODULE_PATHS.files, { state });
  } else {
    followUiIntent({ type: "focusModule", module: "files" });
  }
  window.dispatchEvent(new CustomEvent(OPEN_SFTP_FOR_SSH_EVENT, { detail: state }));
}

/** 跳转到绑定的 Docker 连接并定位。 */
export async function jumpSshDocker(
  sshId: string,
  missingMessage?: string,
): Promise<boolean> {
  const res = await commands.dockerListConnections();
  if (res.status !== "ok") {
    if (missingMessage) showToast(missingMessage);
    return false;
  }
  const conn = res.data.find((c) => c.boundSshConnectionId === sshId);
  if (!conn) {
    if (missingMessage) showToast(missingMessage);
    followUiIntent({ type: "focusModule", module: "docker" });
    return false;
  }
  try {
    localStorage.setItem(DOCKER_ACTIVE_KEY, conn.connectionId);
  } catch {
    // ignore
  }
  followUiIntent({
    type: "openConnection",
    module: "docker",
    resourceId: conn.connectionId,
  });
  return true;
}

/** 跳转到绑定的服务器面板并定位到对应面板连接。 */
export function jumpSshPanel(sshId: string, missingMessage?: string): boolean {
  const panel = findPanelForSsh(useConnectionStore.getState().connections, sshId);
  if (!panel) {
    if (missingMessage) showToast(missingMessage);
    return false;
  }
  followUiIntent({ type: "selectServer", serverId: panel.id });
  return true;
}

/** 查询 SSH 是否已绑定面板（供右键菜单禁用态）。 */
export function sshHasPanel(sshId: string): boolean {
  return Boolean(findPanelForSsh(useConnectionStore.getState().connections, sshId));
}
