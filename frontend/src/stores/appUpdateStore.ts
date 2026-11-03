import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { commands, type UpdateInfo } from "../ipc/bindings";
import { isTauriRuntime } from "../lib/isTauriRuntime";

interface AppUpdateState {
  updateInfo: UpdateInfo | null;
  checking: boolean;
  updating: boolean;
  downloadPercent: number | null;
  error: string | null;
  dialogOpen: boolean;
  /** 本次会话暂时跳过的版本号 */
  skippedVersion: string | null;
  checkedOnce: boolean;

  checkOnce: () => Promise<void>;
  openDialog: () => void;
  closeDialog: () => void;
  skipForNow: () => void;
  installNow: () => Promise<void>;
}

/** 是否显示红色更新角标（有新版本且未在本会话跳过）。 */
export function selectUpdateBadgeVisible(s: AppUpdateState): boolean {
  const info = s.updateInfo;
  if (!info?.available || !info.version) return false;
  return info.version !== s.skippedVersion;
}

export const useAppUpdateStore = create<AppUpdateState>((set, get) => ({
  updateInfo: null,
  checking: false,
  updating: false,
  downloadPercent: null,
  error: null,
  dialogOpen: false,
  skippedVersion: null,
  checkedOnce: false,

  checkOnce: async () => {
    // tauri.conf.json 在本地长期停在占位版本（发版才由 CI 写回），
    // dev 构建去对线上 latest 会永远误报「有更新」并刷角标/弹窗。
    if (!isTauriRuntime() || import.meta.env.DEV) {
      set({ checkedOnce: true, updateInfo: null });
      return;
    }
    if (get().checking) return;
    set({ checking: true, error: null });
    try {
      const result = await commands.checkUpdate();
      if (result.status === "ok") {
        set({ updateInfo: result.data, checkedOnce: true });
      } else {
        set({
          error: typeof result.error === "string" ? result.error : "check failed",
          checkedOnce: true,
        });
      }
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "check failed",
        checkedOnce: true,
      });
    } finally {
      set({ checking: false });
    }
  },

  openDialog: () => set({ dialogOpen: true }),

  closeDialog: () => {
    if (get().updating) return;
    set({ dialogOpen: false });
  },

  skipForNow: () => {
    const version = get().updateInfo?.version ?? null;
    set({ skippedVersion: version, dialogOpen: false });
  },

  installNow: async () => {
    const info = get().updateInfo;
    if (!info?.available || get().updating) return;

    set({ updating: true, downloadPercent: 0, error: null });
    let downloaded = 0;
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<{ chunk_length: number; content_length: number | null }>(
        "update-download-progress",
        (event) => {
          downloaded += event.payload.chunk_length;
          const total = event.payload.content_length;
          if (total && total > 0) {
            set({ downloadPercent: Math.round((downloaded / total) * 100) });
          }
        },
      );
      const result = await commands.installUpdate();
      if (result.status === "error") {
        set({
          error: typeof result.error === "string" ? result.error : "install failed",
        });
      }
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "install failed",
      });
    } finally {
      unlisten?.();
      set({ updating: false, downloadPercent: null });
    }
  },
}));
