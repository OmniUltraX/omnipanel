import { create } from "zustand";

interface UserCenterUiState {
  open: boolean;
  openUserCenter: () => void;
  closeUserCenter: () => void;
  toggleUserCenter: () => void;
}

export const useUserCenterUiStore = create<UserCenterUiState>((set) => ({
  open: false,
  openUserCenter: () => set({ open: true }),
  closeUserCenter: () => set({ open: false }),
  toggleUserCenter: () => set((s) => ({ open: !s.open })),
}));
