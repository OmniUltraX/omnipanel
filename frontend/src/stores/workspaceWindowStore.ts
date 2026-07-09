import { create } from "zustand";

/**
 * 主窗口运行态：记录哪些工作区当前已弹出为独立 OS 窗口。
 * 不持久化 —— 真相来源是实际存在的 Tauri 窗口，启动时核对、运行期靠事件同步。
 */
interface WorkspaceWindowState {
  poppedOutIds: string[];
  isPoppedOut: (workspaceId: string) => boolean;
  markPoppedOut: (workspaceId: string) => void;
  clearPoppedOut: (workspaceId: string) => void;
  setPoppedOut: (ids: string[]) => void;
}

export const useWorkspaceWindowStore = create<WorkspaceWindowState>((set, get) => ({
  poppedOutIds: [],
  isPoppedOut: (workspaceId) => get().poppedOutIds.includes(workspaceId),
  markPoppedOut: (workspaceId) =>
    set((state) =>
      state.poppedOutIds.includes(workspaceId)
        ? state
        : { poppedOutIds: [...state.poppedOutIds, workspaceId] },
    ),
  clearPoppedOut: (workspaceId) =>
    set((state) => {
      if (!state.poppedOutIds.includes(workspaceId)) return state;
      return { poppedOutIds: state.poppedOutIds.filter((id) => id !== workspaceId) };
    }),
  setPoppedOut: (ids) => set({ poppedOutIds: [...new Set(ids)] }),
}));

/** 非组件上下文（navigation 等）读取当前弹出状态。 */
export function isWorkspacePoppedOut(workspaceId: string): boolean {
  return useWorkspaceWindowStore.getState().isPoppedOut(workspaceId);
}
