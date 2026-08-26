import { create } from "zustand";

export type UserCenterPage = "account" | "subscription" | "devices";

interface UserCenterUiState {
  open: boolean;
  page: UserCenterPage;
  /** 设备页仅展示客户端设备（从侧栏手机菜单进入）。 */
  devicesClientOnly: boolean;
  openUserCenter: (page?: UserCenterPage, opts?: { devicesClientOnly?: boolean }) => void;
  closeUserCenter: () => void;
  setPage: (page: UserCenterPage) => void;
}

export const useUserCenterUiStore = create<UserCenterUiState>((set) => ({
  open: false,
  page: "account",
  devicesClientOnly: false,
  openUserCenter: (page = "account", opts) =>
    set({
      open: true,
      page,
      devicesClientOnly: opts?.devicesClientOnly ?? false,
    }),
  closeUserCenter: () => set({ open: false, devicesClientOnly: false }),
  setPage: (page) => set({ page, devicesClientOnly: false }),
}));
