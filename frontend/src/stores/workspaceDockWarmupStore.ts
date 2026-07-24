import { create } from "zustand";

/**
 * 首页工程工作区 dock 预热：只挂 dockview shell，panel 内容由
 * WorkspacePreview contentSuspended 抑制，避免 Schema/表格虚拟列表空跑。
 */
interface WorkspaceDockWarmupState {
  warm: boolean;
  /** 预挂载的目标工作区；点击/hover 时更新，减少选中后 remount */
  targetWorkspaceId: string | null;
  requestWarm: (workspaceId?: string) => void;
  setTarget: (workspaceId: string | null) => void;
  clear: () => void;
}

export const useWorkspaceDockWarmupStore = create<WorkspaceDockWarmupState>((set) => ({
  warm: false,
  targetWorkspaceId: null,
  requestWarm: (workspaceId) =>
    set((state) => ({
      warm: true,
      targetWorkspaceId: workspaceId ?? state.targetWorkspaceId,
    })),
  setTarget: (workspaceId) => set({ targetWorkspaceId: workspaceId, warm: true }),
  clear: () => set({ warm: false, targetWorkspaceId: null }),
}));

export function requestWorkspaceDockWarmup(workspaceId?: string): void {
  useWorkspaceDockWarmupStore.getState().requestWarm(workspaceId);
}
