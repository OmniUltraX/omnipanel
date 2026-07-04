import { create } from "zustand";
import type { FileEntry } from "../../ipc/bindings";
import { LOCAL_CONNECTION_ID } from "../files/utils";

export interface TerminalFilePreviewTarget {
  connectionId: string;
  /** 解析后的绝对路径 */
  absolutePath: string;
  /** 文件名（用于标题与预览类型判断） */
  name: string;
  /** 远端 SSH 资源 id（仅 remote 模式有值；用于走 sftp_download/upload 直通 SSH pool） */
  resourceId?: string | null;
  /** 会话类型，决定走本地还是 SSH 通道 */
  sessionType?: "local" | "remote";
}

interface TerminalFilePreviewState {
  target: TerminalFilePreviewTarget | null;
  open(target: TerminalFilePreviewTarget): void;
  close(): void;
}

export const useTerminalFilePreviewStore = create<TerminalFilePreviewState>(
  (set) => ({
    target: null,
    open: (target) => set({ target }),
    close: () => set({ target: null }),
  }),
);

/** 把 TerminalFilePreviewTarget 转成 FilePreviewSubWindow 需要的 FileEntry。
 *  FilePreviewContent 内部会调 fileStat 拿真实 size/modified/permissions，
 *  这里只填必填字段。
 */
export function targetToFileEntry(
  target: TerminalFilePreviewTarget,
): FileEntry {
  return {
    name: target.name,
    path: target.absolutePath,
    kind: "file",
    size: null,
    modified: null,
    permissions: null,
  };
}

export function resolvePreviewConnectionId(
  sessionType: "local" | "remote",
  resourceId: string | null,
): string {
  if (sessionType === "local" || !resourceId) return LOCAL_CONNECTION_ID;
  return resourceId;
}
