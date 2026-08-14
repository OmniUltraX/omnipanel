import { create } from "zustand";

/** 右键「分享」带入的业务载荷；null 表示无具体分享对象。 */
export type SharePayload =
  | {
      kind: "custom-panel";
      panelId: string;
      label: string;
    }
  | null;

type ShareUiState = {
  open: boolean;
  payload: SharePayload;
  openShareDialog: (payload?: SharePayload) => void;
  closeShareDialog: () => void;
};

/** 团队分享弹窗（选择成员后发送；接口后续接入）。 */
export const useShareUiStore = create<ShareUiState>((set) => ({
  open: false,
  payload: null,
  openShareDialog: (payload = null) => set({ open: true, payload }),
  closeShareDialog: () => set({ open: false, payload: null }),
}));
