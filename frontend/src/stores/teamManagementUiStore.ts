import { create } from "zustand";

interface TeamManagementUiState {
  open: boolean;
  /** 打开时优先进入该团队详情；`null` 显示团队列表 */
  initialTeamId: number | null;
  openTeamManagement: (teamId?: number | null) => void;
  closeTeamManagement: () => void;
}

export const useTeamManagementUiStore = create<TeamManagementUiState>((set) => ({
  open: false,
  initialTeamId: null,
  openTeamManagement: (teamId = null) =>
    set({
      open: true,
      initialTeamId: teamId != null && teamId > 0 ? teamId : null,
    }),
  closeTeamManagement: () => set({ open: false, initialTeamId: null }),
}));
