import { create } from "zustand";
import { pathToRemoteDir, shellCdCommand } from "../modules/server/ssh/utils/parseCommandPaths";
import type { DetailTab } from "../modules/server/ssh/types";
import type { SftpEntry } from "../components/sftp/sftpUtils";

type PendingSftp = {
  resourceId: string;
  path: string;
  nonce: number;
};

type PendingTerminal = {
  resourceId: string;
  command: string;
  nonce: number;
};

/** 请求展开并聚焦终端侧栏某个面板（如 SFTP） */
type PendingSideFocus = {
  resourceId: string;
  panel: "sftp" | "files";
  path: string;
  nonce: number;
};

export type SftpCache = {
  path: string;
  entries: SftpEntry[];
};

type SshDetailNavigationState = {
  pendingSftp: PendingSftp | null;
  pendingTerminal: PendingTerminal | null;
  pendingSideFocus: PendingSideFocus | null;
  pendingLocalNavigate: { path: string; nonce: number } | null;
  sftpCaches: Record<string, SftpCache>;
  requestSftp: (resourceId: string, path: string) => void;
  /** 打开侧栏 SFTP 并跳到指定路径 */
  revealInSftp: (resourceId: string, path: string) => void;
  /** 打开侧栏本地文件并跳到指定路径 */
  revealInFiles: (path: string) => void;
  requestTerminal: (resourceId: string, path: string) => void;
  consumeSftpPath: (resourceId: string) => PendingSftp | null;
  consumeTerminalCommand: (resourceId: string) => PendingTerminal | null;
  consumeSideFocus: (resourceId: string | null) => PendingSideFocus | null;
  consumeLocalNavigate: () => { path: string; nonce: number } | null;
  setSftpCache: (resourceId: string, cache: SftpCache) => void;
};

export const useSshDetailNavigationStore = create<SshDetailNavigationState>((set, get) => ({
  pendingSftp: null,
  pendingTerminal: null,
  pendingSideFocus: null,
  pendingLocalNavigate: null,
  sftpCaches: {},
  requestSftp: (resourceId, path) => {
    set({
      pendingSftp: {
        resourceId,
        path: pathToRemoteDir(path),
        nonce: Date.now(),
      },
    });
  },
  revealInSftp: (resourceId, path) => {
    const dir = pathToRemoteDir(path);
    const nonce = Date.now();
    set({
      pendingSftp: { resourceId, path: dir, nonce },
      pendingSideFocus: { resourceId, panel: "sftp", path: dir, nonce },
    });
  },
  revealInFiles: (path) => {
    const nonce = Date.now();
    set({
      pendingLocalNavigate: { path, nonce },
      pendingSideFocus: {
        resourceId: "__local__",
        panel: "files",
        path,
        nonce,
      },
    });
  },
  requestTerminal: (resourceId, path) => {
    set({
      pendingTerminal: {
        resourceId,
        command: shellCdCommand(pathToRemoteDir(path)),
        nonce: Date.now(),
      },
    });
  },
  consumeSftpPath: (resourceId) => {
    const pending = get().pendingSftp;
    if (!pending || pending.resourceId !== resourceId) return null;
    set({ pendingSftp: null });
    return pending;
  },
  consumeTerminalCommand: (resourceId) => {
    const pending = get().pendingTerminal;
    if (!pending || pending.resourceId !== resourceId) return null;
    set({ pendingTerminal: null });
    return pending;
  },
  consumeSideFocus: (resourceId) => {
    const pending = get().pendingSideFocus;
    if (!pending) return null;
    if (pending.panel === "sftp") {
      if (!resourceId || pending.resourceId !== resourceId) return null;
    }
    set({ pendingSideFocus: null });
    return pending;
  },
  consumeLocalNavigate: () => {
    const pending = get().pendingLocalNavigate;
    if (!pending) return null;
    set({ pendingLocalNavigate: null });
    return pending;
  },
  setSftpCache: (resourceId, cache) => {
    set((state) => ({
      sftpCaches: { ...state.sftpCaches, [resourceId]: cache },
    }));
  },
}));

/** 跳转到终端 Tab 并发送 cd 命令（已废弃：terminal Tab 已移除，请直接使用 terminalStore + navigate） */
export function navigateToSftpPath(
  _resourceId: string,
  _path: string,
  _setDetailTab: (tab: DetailTab) => void,
) {
  // 保留签名以避免破坏已有调用方，实际跳转由调用方改为 navigateToTerminalOrSftp
}

export function navigateToTerminalPath(
  _resourceId: string,
  _path: string,
  _setDetailTab: (tab: DetailTab) => void,
) {
  // 保留签名以避免破坏已有调用方，实际跳转由调用方改为 navigateToTerminalOrSftp
}
