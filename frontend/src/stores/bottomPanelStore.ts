import { create } from "zustand";

/**
 * SidebarBottom 展开/收起信号存储。
 *
 * 跨组件（StatusBar / WorkspacePopover 等）控制底部工作区面板的统一入口。
 * `expandSignal` / `collapseSignal` 是单调递增计数器，SidebarBottom 订阅后
 * 调用面板 ref 的 expand() / collapse()。
 */
interface BottomPanelState {
  expandSignal: number;
  collapseSignal: number;
  /** 底部工作区面板是否展开（供状态栏按钮显示；由 SidebarBottom 同步） */
  isOpen: boolean;
  /** 底部工程工作区是否全屏（高度铺满 workspace 主区域） */
  isFullscreen: boolean;
  requestExpand: () => void;
  requestCollapse: () => void;
  setIsOpen: (open: boolean) => void;
  enterFullscreen: () => void;
  exitFullscreen: () => void;
  toggleFullscreen: () => void;
}

export const useBottomPanelStore = create<BottomPanelState>((set, get) => ({
  expandSignal: 0,
  collapseSignal: 0,
  isOpen: true,
  isFullscreen: false,
  requestExpand: () =>
    set((state) => ({
      expandSignal: state.expandSignal + 1,
      isOpen: true,
    })),
  requestCollapse: () =>
    set((state) => ({
      collapseSignal: state.collapseSignal + 1,
      isOpen: false,
      isFullscreen: false,
    })),
  setIsOpen: (isOpen) => set({ isOpen }),
  enterFullscreen: () =>
    set((state) => ({
      isFullscreen: true,
      isOpen: true,
      expandSignal: state.expandSignal + 1,
    })),
  exitFullscreen: () => set({ isFullscreen: false }),
  toggleFullscreen: () => {
    const { isFullscreen } = get();
    if (isFullscreen) {
      set({ isFullscreen: false });
    } else {
      set((state) => ({
        isFullscreen: true,
        isOpen: true,
        expandSignal: state.expandSignal + 1,
      }));
    }
  },
}));
