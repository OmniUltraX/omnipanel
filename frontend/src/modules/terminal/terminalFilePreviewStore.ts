import { create } from "zustand";
import type { FileEntry } from "../../ipc/bindings";
import { resolveFilePreviewKind } from "../files/filePreviewKind";
import {
  FORCE_PREVIEW_MAX_BYTES,
  LOCAL_CONNECTION_ID,
  formatFileSize,
  isStreamableMediaFile,
} from "../files/utils";
import { showToast } from "../../stores/toastStore";
import { t } from "../../i18n";

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
  /** 已知大小（字节）；ls 长格式等场景可传入，避免先打开再失败 */
  sizeBytes?: number | null;
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

export type TerminalPreviewGateReason = "unsupported" | "tooLarge";

/** 打开前校验：不支持类型 / 过大文件直接拒绝并提示（流式媒体不受 10MB 限制） */
export function evaluateTerminalFilePreviewGate(
  name: string,
  sizeBytes?: number | null,
): TerminalPreviewGateReason | null {
  if (resolveFilePreviewKind(name) === "unsupported") return "unsupported";
  // 音视频/图片走远程缓存或本地 asset，不占用整文件进 JS 的 10MB 阈值
  if (isStreamableMediaFile(name)) return null;
  if (sizeBytes != null && sizeBytes > FORCE_PREVIEW_MAX_BYTES) return "tooLarge";
  return null;
}

function toastPreviewBlocked(reason: TerminalPreviewGateReason): void {
  if (reason === "unsupported") {
    showToast(t("files.preview.unsupported"));
    return;
  }
  showToast(
    t("files.preview.tooLarge", {
      limit: formatFileSize(FORCE_PREVIEW_MAX_BYTES),
    }),
  );
}

/**
 * 终端点击文件预览入口：大文件 / 不支持类型只提示，不打开预览窗。
 * @returns 是否已打开预览
 */
export function tryOpenTerminalFilePreview(
  target: TerminalFilePreviewTarget,
): boolean {
  const blocked = evaluateTerminalFilePreviewGate(
    target.name,
    target.sizeBytes ?? null,
  );
  if (blocked) {
    toastPreviewBlocked(blocked);
    return false;
  }
  useTerminalFilePreviewStore.getState().open(target);
  return true;
}

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
    size: target.sizeBytes ?? null,
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

/** 解析 ls 长格式 size 列（如 "12,345" / "1024"） */
export function parseLsLongSizeBytes(longSize: string | undefined | null): number | null {
  if (!longSize) return null;
  const trimmed = longSize.trim();
  if (!trimmed || trimmed === "<DIR>" || /[a-zA-Z]/.test(trimmed)) return null;
  const n = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}
