import { create } from "zustand";

export type UserCenterPage = "account" | "subscription" | "devices";

interface UserCenterUiState {
  open: boolean;
  page: UserCenterPage;
  openUserCenter: (page?: UserCenterPage) => void;
  closeUserCenter: () => void;
  setPage: (page: UserCenterPage) => void;
}

export const useUserCenterUiStore = create<UserCenterUiState>((set) => ({
  open: false,
  page: "account",
  openUserCenter: (page = "account") => set({ open: true, page }),
  closeUserCenter: () => set({ open: false }),
  setPage: (page) => set({ page }),
}));
