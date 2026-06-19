import { create } from "zustand";

interface WorkspacePreviewCollapseState {
  /** 底部预览栏是否展开 */
  isOpen: boolean;
  expand: () => void;
  collapse: () => void;
  toggle: () => void;
  setIsOpen: (open: boolean) => void;
}

export const useWorkspacePreviewCollapseStore = create<WorkspacePreviewCollapseState>((set, get) => ({
  isOpen: true,
  expand: () => set({ isOpen: true }),
  collapse: () => set({ isOpen: false }),
  toggle: () => set({ isOpen: !get().isOpen }),
  setIsOpen: (open) => set({ isOpen: open }),
}));
