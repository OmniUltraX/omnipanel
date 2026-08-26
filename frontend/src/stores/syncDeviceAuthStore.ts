import { create } from "zustand";

interface SyncDeviceAuthState {
  open: boolean;
  /** 强制模式：不可「稍后」关闭，必须完成密钥导入/创建 */
  forced: boolean;
  /** 强制模式下等待密钥的目标团队 */
  forcedTeamId: number | null;
  /** 本会话已点「稍后」的 token，避免反复打断 */
  dismissedToken: string | null;
  openDialog: () => void;
  openForcedDialog: (teamId: number) => void;
  closeDialog: () => void;
  dismissForToken: (token: string) => void;
  clearDismissed: () => void;
  /** 重置设备后调用：清 dismiss 并打开认证对话框 */
  markResetPendingAuth: () => void;
  reset: () => void;
}

/** 无团队同步密钥时弹出的引导对话框状态。 */
export const useSyncDeviceAuthStore = create<SyncDeviceAuthState>((set) => ({
  open: false,
  forced: false,
  forcedTeamId: null,
  dismissedToken: null,
  openDialog: () =>
    set({
      open: true,
      forced: false,
      forcedTeamId: null,
    }),
  openForcedDialog: (teamId) =>
    set({
      open: true,
      forced: true,
      forcedTeamId: teamId,
      dismissedToken: null,
    }),
  closeDialog: () =>
    set({
      open: false,
      forced: false,
      forcedTeamId: null,
    }),
  dismissForToken: (token) =>
    set({
      open: false,
      forced: false,
      forcedTeamId: null,
      dismissedToken: token.trim() || null,
    }),
  clearDismissed: () => set({ dismissedToken: null }),
  markResetPendingAuth: () =>
    set({
      open: true,
      forced: false,
      forcedTeamId: null,
      dismissedToken: null,
    }),
  reset: () =>
    set({
      open: false,
      forced: false,
      forcedTeamId: null,
      dismissedToken: null,
    }),
}));
