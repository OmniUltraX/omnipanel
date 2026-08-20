import { create } from "zustand";

interface SyncDeviceAuthState {
  open: boolean;
  /** 本会话已点「稍后」的 token，避免反复打断 */
  dismissedToken: string | null;
  openDialog: () => void;
  closeDialog: () => void;
  dismissForToken: (token: string) => void;
  reset: () => void;
}

/** 无 SyncMasterKey 时弹出的小程序扫码认证对话框状态。 */
export const useSyncDeviceAuthStore = create<SyncDeviceAuthState>((set) => ({
  open: false,
  dismissedToken: null,
  openDialog: () => set({ open: true }),
  closeDialog: () => set({ open: false }),
  dismissForToken: (token) =>
    set({ open: false, dismissedToken: token.trim() || null }),
  reset: () => set({ open: false, dismissedToken: null }),
}));
