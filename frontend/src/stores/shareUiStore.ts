import { create } from "zustand";
import type { ShareDialogPayload } from "../modules/share/resourceShare";

export type { ShareDialogPayload as SharePayload };

type ShareUiState = {
  open: boolean;
  payload: ShareDialogPayload | null;
  openShareDialog: (payload?: ShareDialogPayload | null) => void;
  closeShareDialog: () => void;
};

/** 团队分享弹窗（快照由入口构建完成，弹窗只负责选成员与发送）。 */
export const useShareUiStore = create<ShareUiState>((set) => ({
  open: false,
  payload: null,
  openShareDialog: (payload = null) => set({ open: true, payload }),
  closeShareDialog: () => set({ open: false, payload: null }),
}));
