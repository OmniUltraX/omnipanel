import { create } from "zustand";
import { persist } from "zustand/middleware";

/** 功能页内底部工作区的嵌入模式（全屏 Home 不修改此记忆） */
export type WorkspaceEmbeddedMode = "off" | "half";

/**
 * SidebarBottom 展开/收起信号存储。
 *
 * 跨组件（StatusBar / WorkspacePopover 等）控制底部工作区面板的统一入口。
 * `expandSignal` / `collapseSignal` 是单调递增计数器，SidebarBottom 订阅后
 * 调用面板 ref 的 expand() / collapse()。
 *
 * - **全屏（Home）**：`isFullscreen=true`，不占功能页布局
 * - **半屏（half）**：`embeddedMode=half`，功能页上方 + 底部工作区
 * - **关闭（off）**：`embeddedMode=off`，仅功能页；离开全屏时按此记忆恢复
 */
interface BottomPanelState {
  expandSignal: number;
  collapseSignal: number;
  /** 底部工作区面板是否展开（供状态栏按钮显示；由 SidebarBottom 同步） */
  isOpen: boolean;
  /** 底部工程工作区是否全屏（高度铺满 workspace 主区域） */
  isFullscreen: boolean;
  /** 是否处于首页特殊工作区（独立于可自定义 Tab 的工程工作区） */
  isHomeActive: boolean;
  /** 功能页内记住的嵌入模式；全屏 Home 不覆盖 */
  embeddedMode: WorkspaceEmbeddedMode;
  requestExpand: () => void;
  requestCollapse: () => void;
  setIsOpen: (open: boolean) => void;
  enterFullscreen: () => void;
  /** 进入 Home 全屏工作区（别名） */
  enterHomeWorkspace: () => void;
  /** 进入当前工程工作区全屏（不是首页） */
  enterWorkspaceFullscreen: () => void;
  exitFullscreen: () => void;
  leaveFullscreenForFeature: () => void;
  /** 离开 Home 全屏并恢复嵌入模式（别名） */
  leaveHomeToFeature: () => void;
  /** 离开首页并进入工程工作区全屏（从下拉切换工作区时） */
  exitHomeToWorkspace: () => void;
  applyEmbeddedMode: () => void;
  toggleFullscreen: () => void;
  /** 功能页内切换 off/half（别名） */
  toggleEmbeddedWorkspace: () => void;
  toggleOpen: () => void;
}

export const useBottomPanelStore = create<BottomPanelState>()(
  persist(
    (set, get) => ({
      expandSignal: 0,
      collapseSignal: 0,
      isOpen: false,
      isFullscreen: false,
      isHomeActive: false,
      embeddedMode: "off",

      requestExpand: () =>
        set((state) => ({
          expandSignal: state.expandSignal + 1,
          isOpen: true,
          isHomeActive: false,
          embeddedMode: "half",
        })),

      requestCollapse: () =>
        set((state) => ({
          collapseSignal: state.collapseSignal + 1,
          isOpen: false,
          isFullscreen: false,
          isHomeActive: false,
          embeddedMode: "off",
        })),

      setIsOpen: (isOpen) =>
        set({
          isOpen,
          isHomeActive: false,
          embeddedMode: isOpen ? "half" : "off",
        }),

      enterFullscreen: () =>
        set((state) => ({
          isFullscreen: true,
          isHomeActive: true,
          isOpen: true,
          expandSignal: state.expandSignal + 1,
        })),

      enterHomeWorkspace: () => {
        get().enterFullscreen();
      },

      enterWorkspaceFullscreen: () =>
        set((state) => ({
          isHomeActive: false,
          isFullscreen: true,
          isOpen: true,
          expandSignal: state.expandSignal + 1,
        })),

      exitHomeToWorkspace: () => {
        get().enterWorkspaceFullscreen();
      },

      applyEmbeddedMode: () => {
        const { embeddedMode } = get();
        if (embeddedMode === "half") {
          set((state) => ({
            expandSignal: state.expandSignal + 1,
            isOpen: true,
          }));
        } else {
          set((state) => ({
            collapseSignal: state.collapseSignal + 1,
            isOpen: false,
          }));
        }
      },

      exitFullscreen: () => {
        set({ isFullscreen: false, isHomeActive: false });
        get().applyEmbeddedMode();
      },

      leaveFullscreenForFeature: () => {
        if (!get().isFullscreen && !get().isHomeActive) return;
        set({ isFullscreen: false, isHomeActive: false });
        get().applyEmbeddedMode();
      },

      leaveHomeToFeature: () => {
        get().leaveFullscreenForFeature();
      },

      toggleFullscreen: () => {
        const { isFullscreen, isHomeActive } = get();
        if (isFullscreen || isHomeActive) {
          get().exitFullscreen();
        } else {
          get().enterHomeWorkspace();
        }
      },

      toggleEmbeddedWorkspace: () => {
        const { isOpen } = get();
        if (isOpen) {
          get().requestCollapse();
        } else {
          get().requestExpand();
        }
      },

      toggleOpen: () => {
        const { isOpen, isFullscreen, isHomeActive } = get();
        if (isFullscreen || isHomeActive) {
          get().exitFullscreen();
          return;
        }
        if (isOpen) {
          get().requestCollapse();
        } else {
          get().requestExpand();
        }
      },
    }),
    {
      name: "omnipanel-bottom-panel",
      partialize: (state) => ({
        embeddedMode: state.embeddedMode,
      }),
    },
  ),
);
