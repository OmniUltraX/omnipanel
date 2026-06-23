import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  defaultHeightForMode,
  embeddedModeToDisplayPreference,
  halfHeightPx,
  isEmbeddedWorkspaceMode,
  resolveEmbeddedHeight,
  splitWindowMinHeightPx,
  splitWindowHeightFromRatio,
  splitWindowHeightRatio,
  WS_HALF_HEIGHT_RATIO,
  WS_HEIGHT_HIDDEN_MAX,
  WS_HEIGHT_TASKBAR_MAX,
  type EmbeddedWorkspaceMode,
  type WorkspaceDisplayPreference,
  type WorkspaceMode,
} from "../lib/workspaceMode";

/** @deprecated 兼容旧逻辑，映射到 hidden/half */
export type WorkspaceEmbeddedMode = "off" | "half";

interface BottomPanelState {
  expandSignal: number;
  collapseSignal: number;
  /** 当前工作区模式 */
  workspaceMode: WorkspaceMode;
  /** 底部嵌入区实际高度（px） */
  workspaceHeightPx: number;
  /** 离开全屏前记住的嵌入模式 */
  lastNonFullscreenMode: EmbeddedWorkspaceMode;
  /** 折叠前记住的底部高度，展开时恢复 */
  lastExpandedHeightPx: number;
  /** split-window 高度占视口比例，窗口 resize 时等比缩放 */
  lastExpandedHeightRatio: number;
  /** 用户偏好：split-window（分屏 dock）或 task-bar（40px 标签栏） */
  workspaceDisplayPreference: WorkspaceDisplayPreference;

  /** 底部工作区是否展开（嵌入态且非 hidden） */
  isOpen: boolean;
  /** 是否全屏（工程工作区） */
  isFullscreen: boolean;
  /** @deprecated 首页已移除，始终为 false */
  isHomeActive: boolean;
  /** @deprecated 使用 lastNonFullscreenMode */
  embeddedMode: WorkspaceEmbeddedMode;

  requestExpand: () => void;
  requestCollapse: () => void;
  setIsOpen: (open: boolean) => void;
  setWorkspaceHeight: (
    heightPx: number,
    options?: { fromUserDrag?: boolean; commit?: boolean },
  ) => void;
  enterFullscreen: () => void;
  /** @deprecated 首页已移除，等同于 enterWorkspaceFullscreen */
  enterHomeWorkspace: () => void;
  enterWorkspaceFullscreen: () => void;
  exitFullscreen: () => void;
  leaveFullscreenForFeature: () => void;
  /** @deprecated 首页已移除，等同于 leaveFullscreenForFeature */
  leaveHomeToFeature: () => void;
  /** @deprecated 首页已移除，等同于 enterWorkspaceFullscreen */
  exitHomeToWorkspace: () => void;
  applyEmbeddedMode: () => void;
  toggleFullscreen: () => void;
  toggleEmbeddedWorkspace: () => void;
  toggleOpen: () => void;
  /** 全屏顶栏向下拖拽退出全屏，固定恢复半屏 */
  leaveFullscreenByDrag: () => void;
  /** 半屏及以下右上角：进入工程工作区全屏 */
  handleWorkspaceChromeIcon: () => void;
  shiftWorkspaceModeUp: () => void;
  shiftWorkspaceModeDown: () => void;
  /** 状态栏：在 split-window ↔ task-bar 间切换（持久化偏好） */
  toggleWorkspaceDisplayPreference: () => void;
  /** 按用户偏好设置嵌入高度与模式 */
  applyWorkspaceDisplayPreference: (
    preference?: WorkspaceDisplayPreference,
  ) => void;
}

function normalizeWorkspaceMode(mode: WorkspaceMode): WorkspaceMode {
  return mode === "home" ? "fullscreen" : mode;
}

function syncDerivedFlags(mode: WorkspaceMode): Pick<
  BottomPanelState,
  "isOpen" | "isFullscreen" | "isHomeActive" | "embeddedMode"
> {
  const normalized = normalizeWorkspaceMode(mode);
  const isFullscreen = normalized === "fullscreen";
  const isOpen = isEmbeddedWorkspaceMode(normalized) && normalized !== "hidden";
  const embeddedMode: WorkspaceEmbeddedMode =
    normalized === "half" || normalized === "thumbnail" || normalized === "taskbar"
      ? "half"
      : "off";
  return { isOpen, isFullscreen, isHomeActive: false, embeddedMode };
}

export const useBottomPanelStore = create<BottomPanelState>()(
  persist(
    (set, get) => ({
      expandSignal: 0,
      collapseSignal: 0,
      workspaceMode: "hidden",
      workspaceHeightPx: 0,
      lastNonFullscreenMode: "half",
      lastExpandedHeightPx: defaultHeightForMode("half"),
      lastExpandedHeightRatio: WS_HALF_HEIGHT_RATIO,
      workspaceDisplayPreference: "split-window",
      isOpen: false,
      isFullscreen: false,
      isHomeActive: false,
      embeddedMode: "off",

      requestExpand: () => {
        const { workspaceMode, workspaceDisplayPreference, lastExpandedHeightPx } =
          get();
        const normalized = normalizeWorkspaceMode(workspaceMode);
        if (
          isEmbeddedWorkspaceMode(normalized) &&
          normalized !== "hidden"
        ) {
          return;
        }
        get().applyWorkspaceDisplayPreference(workspaceDisplayPreference);
        set((state) => ({
          expandSignal: state.expandSignal + 1,
        }));
      },

      requestCollapse: () => {
        const { workspaceMode, lastNonFullscreenMode, workspaceHeightPx } = get();
        const normalized = normalizeWorkspaceMode(workspaceMode);
        if (normalized === "hidden") {
          return;
        }
        const remembered =
          isEmbeddedWorkspaceMode(normalized) && normalized !== "hidden"
            ? normalized
            : lastNonFullscreenMode;
        const lastExpandedHeightPx =
          workspaceHeightPx > WS_HEIGHT_HIDDEN_MAX
            ? workspaceHeightPx
            : defaultHeightForMode(
                remembered === "hidden" ? "half" : remembered,
              );
        set((state) => ({
          collapseSignal: state.collapseSignal + 1,
          workspaceMode: "hidden",
          workspaceHeightPx: 0,
          lastNonFullscreenMode: remembered,
          lastExpandedHeightPx,
          ...syncDerivedFlags("hidden"),
        }));
      },

      setIsOpen: (isOpen) => {
        if (isOpen) {
          get().requestExpand();
        } else {
          get().requestCollapse();
        }
      },

      setWorkspaceHeight: (heightPx, options) => {
        const { workspaceMode } = get();
        const normalized = normalizeWorkspaceMode(workspaceMode);
        if (normalized === "fullscreen") return;

        if (options?.commit === false) {
          // 拖拽跟手只更新高度，模式在松手时提交，避免 mid-drag 切换 UI 卸载 Separator
          set({ workspaceHeightPx: Math.max(0, Math.round(heightPx)) });
          return;
        }

        const { mode: nextMode, height: normalizedHeight } = resolveEmbeddedHeight(heightPx);
        const patch: Partial<BottomPanelState> = {
          workspaceHeightPx: normalizedHeight,
          workspaceMode: nextMode,
          ...syncDerivedFlags(nextMode),
        };
        if (nextMode !== "hidden") {
          patch.lastNonFullscreenMode = nextMode;
          patch.lastExpandedHeightPx = normalizedHeight;
          patch.workspaceDisplayPreference = embeddedModeToDisplayPreference(nextMode);
          if (nextMode === "half") {
            patch.lastExpandedHeightRatio = splitWindowHeightRatio(normalizedHeight);
          }
        }
        set(patch);
      },

      applyWorkspaceDisplayPreference: (preference) => {
        const pref = preference ?? get().workspaceDisplayPreference;
        if (pref === "task-bar") {
          const rememberedHeight =
            get().lastExpandedHeightPx > WS_HEIGHT_TASKBAR_MAX
              ? get().lastExpandedHeightPx
              : defaultHeightForMode("half");
          set({
            workspaceMode: "taskbar",
            workspaceHeightPx: WS_HEIGHT_TASKBAR_MAX,
            lastNonFullscreenMode: "taskbar",
            lastExpandedHeightPx: rememberedHeight,
            workspaceDisplayPreference: "task-bar",
            ...syncDerivedFlags("taskbar"),
          });
          return;
        }
        const ratio = get().lastExpandedHeightRatio;
        const height = splitWindowHeightFromRatio(ratio);
        set({
          workspaceMode: "half",
          workspaceHeightPx: height,
          lastNonFullscreenMode: "half",
          lastExpandedHeightPx: height,
          lastExpandedHeightRatio: ratio,
          workspaceDisplayPreference: "split-window",
          ...syncDerivedFlags("half"),
        });
      },

      toggleWorkspaceDisplayPreference: () => {
        const state = get();
        const normalized = normalizeWorkspaceMode(state.workspaceMode);

        if (normalized === "fullscreen") {
          return;
        }

        if (normalized === "hidden") {
          get().applyWorkspaceDisplayPreference(state.workspaceDisplayPreference);
          set((s) => ({ expandSignal: s.expandSignal + 1 }));
          return;
        }

        const next: WorkspaceDisplayPreference =
          state.workspaceDisplayPreference === "split-window"
            ? "task-bar"
            : "split-window";
        set({ workspaceDisplayPreference: next });
        get().applyWorkspaceDisplayPreference(next);
        set((s) => ({ expandSignal: s.expandSignal + 1 }));
      },

      enterFullscreen: () => {
        get().enterWorkspaceFullscreen();
      },

      enterHomeWorkspace: () => {
        get().enterWorkspaceFullscreen();
      },

      enterWorkspaceFullscreen: () => {
        set((state) => ({
          workspaceMode: "fullscreen",
          ...syncDerivedFlags("fullscreen"),
        }));
      },

      exitHomeToWorkspace: () => {
        get().enterWorkspaceFullscreen();
      },

      applyEmbeddedMode: () => {
        get().applyWorkspaceDisplayPreference(get().workspaceDisplayPreference);
        set((state) => ({ expandSignal: state.expandSignal + 1 }));
      },

      exitFullscreen: () => {
        get().applyEmbeddedMode();
      },

      leaveFullscreenForFeature: () => {
        const { workspaceMode } = get();
        if (normalizeWorkspaceMode(workspaceMode) !== "fullscreen") return;
        get().applyEmbeddedMode();
      },

      leaveHomeToFeature: () => {
        get().leaveFullscreenForFeature();
      },

      leaveFullscreenByDrag: () => {
        const halfHeight = halfHeightPx();
        set({
          workspaceMode: "half",
          workspaceHeightPx: halfHeight,
          lastNonFullscreenMode: "half",
          lastExpandedHeightPx: halfHeight,
          lastExpandedHeightRatio: splitWindowHeightRatio(halfHeight),
          workspaceDisplayPreference: "split-window",
          ...syncDerivedFlags("half"),
        });
        set((state) => ({ expandSignal: state.expandSignal + 1 }));
      },

      handleWorkspaceChromeIcon: () => {
        const { workspaceMode } = get();
        const normalized = normalizeWorkspaceMode(workspaceMode);
        if (normalized === "fullscreen") {
          get().exitFullscreen();
          return;
        }
        get().enterWorkspaceFullscreen();
      },

      shiftWorkspaceModeUp: () => {
        const { workspaceMode } = get();
        const normalized = normalizeWorkspaceMode(workspaceMode);
        if (normalized === "fullscreen") {
          return;
        }
        if (normalized === "hidden") {
          get().applyWorkspaceDisplayPreference("task-bar");
          set((state) => ({ expandSignal: state.expandSignal + 1 }));
          return;
        }
        if (normalized === "taskbar" || normalized === "thumbnail") {
          get().applyWorkspaceDisplayPreference("split-window");
          set((state) => ({ expandSignal: state.expandSignal + 1 }));
          return;
        }
        get().enterWorkspaceFullscreen();
      },

      shiftWorkspaceModeDown: () => {
        const { workspaceMode } = get();
        const normalized = normalizeWorkspaceMode(workspaceMode);
        if (normalized === "hidden") {
          return;
        }
        if (normalized === "fullscreen") {
          get().leaveFullscreenByDrag();
          return;
        }
        if (normalized === "half") {
          get().applyWorkspaceDisplayPreference("task-bar");
          set((state) => ({ expandSignal: state.expandSignal + 1 }));
          return;
        }
        get().requestCollapse();
      },

      toggleFullscreen: () => {
        const { workspaceMode } = get();
        if (normalizeWorkspaceMode(workspaceMode) === "fullscreen") {
          get().exitFullscreen();
        } else {
          get().enterWorkspaceFullscreen();
        }
      },

      toggleEmbeddedWorkspace: () => {
        const { workspaceMode } = get();
        const normalized = normalizeWorkspaceMode(workspaceMode);
        if (normalized === "hidden") {
          get().requestExpand();
        } else if (isEmbeddedWorkspaceMode(normalized)) {
          get().requestCollapse();
        }
      },

      toggleOpen: () => {
        const { workspaceMode } = get();
        const normalized = normalizeWorkspaceMode(workspaceMode);
        if (normalized === "fullscreen") {
          get().exitFullscreen();
          return;
        }
        if (normalized === "hidden") {
          get().requestExpand();
          return;
        }
        get().requestCollapse();
      },
    }),
    {
      name: "omnipanel-bottom-panel",
      version: 6,
      partialize: (state) => ({
        lastNonFullscreenMode: state.lastNonFullscreenMode,
        lastExpandedHeightPx: state.lastExpandedHeightPx,
        lastExpandedHeightRatio: state.lastExpandedHeightRatio,
        workspaceHeightPx: state.workspaceHeightPx,
        embeddedMode: state.embeddedMode,
        workspaceDisplayPreference: state.workspaceDisplayPreference,
      }),
      migrate: (persisted, version) => {
        const p = persisted as Record<string, unknown> | undefined;
        if (!p) return persisted as unknown as BottomPanelState;
        if (version < 6 && typeof p.lastExpandedHeightRatio !== "number") {
          const px =
            typeof p.lastExpandedHeightPx === "number" &&
            (p.lastExpandedHeightPx as number) > WS_HEIGHT_HIDDEN_MAX
              ? (p.lastExpandedHeightPx as number)
              : typeof p.workspaceHeightPx === "number" &&
                  (p.workspaceHeightPx as number) > WS_HEIGHT_HIDDEN_MAX
                ? (p.workspaceHeightPx as number)
                : halfHeightPx();
          p.lastExpandedHeightRatio = splitWindowHeightRatio(px);
        }
        if (version < 5 && typeof p.workspaceDisplayPreference !== "string") {
          const mode = p.lastNonFullscreenMode;
          p.workspaceDisplayPreference =
            mode === "taskbar" || mode === "thumbnail"
              ? "task-bar"
              : "split-window";
        }
        if (version < 4 && typeof p.lastExpandedHeightPx !== "number") {
          const mode =
            p.lastNonFullscreenMode === "taskbar" ||
            p.lastNonFullscreenMode === "thumbnail"
              ? p.lastNonFullscreenMode
              : "half";
          const rawHeight =
            typeof p.workspaceHeightPx === "number" &&
            (p.workspaceHeightPx as number) > WS_HEIGHT_HIDDEN_MAX
              ? (p.workspaceHeightPx as number)
              : defaultHeightForMode(mode as EmbeddedWorkspaceMode);
          p.lastExpandedHeightPx = resolveEmbeddedHeight(rawHeight).height;
        }
        if (version >= 3) return persisted as unknown as BottomPanelState;
        const legacyEmbedded = p.embeddedMode === "half" ? "half" : "off";
        const lastNonFullscreenMode: EmbeddedWorkspaceMode = "half";
        const workspaceHeightPx =
          typeof p.workspaceHeightPx === "number"
            ? p.workspaceHeightPx
            : defaultHeightForMode("half");
        const workspaceMode: WorkspaceMode =
          legacyEmbedded === "half" ? "half" : "hidden";
        return {
          ...p,
          lastNonFullscreenMode,
          workspaceHeightPx: legacyEmbedded === "half" ? workspaceHeightPx : 0,
          workspaceMode,
          embeddedMode: legacyEmbedded,
          isHomeActive: false,
        } as BottomPanelState;
      },
      merge: (persisted, current) => {
        const p = persisted as Partial<BottomPanelState> | undefined;
        if (!p) return current;
        const merged = { ...current, ...p };
        if (p.embeddedMode === "half") {
          const mode: EmbeddedWorkspaceMode =
            p.lastNonFullscreenMode && p.lastNonFullscreenMode !== "hidden"
              ? p.lastNonFullscreenMode
              : "half";
          merged.workspaceMode = mode;
          const rawHeight =
            typeof p.workspaceHeightPx === "number" && p.workspaceHeightPx > WS_HEIGHT_HIDDEN_MAX
              ? p.workspaceHeightPx
              : typeof p.lastExpandedHeightPx === "number" &&
                  p.lastExpandedHeightPx > WS_HEIGHT_HIDDEN_MAX
                ? p.lastExpandedHeightPx
                : defaultHeightForMode(mode);
          merged.workspaceHeightPx = resolveEmbeddedHeight(rawHeight).height;
          merged.lastExpandedHeightPx = merged.workspaceHeightPx;
          merged.lastExpandedHeightRatio =
            typeof p.lastExpandedHeightRatio === "number"
              ? p.lastExpandedHeightRatio
              : splitWindowHeightRatio(merged.workspaceHeightPx);
          merged.workspaceDisplayPreference =
            typeof p.workspaceDisplayPreference === "string"
              ? (p.workspaceDisplayPreference as WorkspaceDisplayPreference)
              : embeddedModeToDisplayPreference(mode);
          Object.assign(merged, syncDerivedFlags(mode));
        } else {
          merged.workspaceMode = "hidden";
          merged.workspaceHeightPx = 0;
          Object.assign(merged, syncDerivedFlags("hidden"));
        }
        if (merged.workspaceMode === "home") {
          merged.workspaceMode = "hidden";
          Object.assign(merged, syncDerivedFlags("hidden"));
        }
        merged.isHomeActive = false;
        return merged;
      },
    },
  ),
);

/** 当前嵌入态（非全屏时） */
export function useEmbeddedWorkspaceMode(): EmbeddedWorkspaceMode {
  const mode = useBottomPanelStore((s) => s.workspaceMode);
  const normalized = normalizeWorkspaceMode(mode);
  if (isEmbeddedWorkspaceMode(normalized)) return normalized;
  return "hidden";
}
