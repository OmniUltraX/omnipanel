import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { DockWorkspace } from "../dock";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import {
  defaultHeightForMode,
  isEmbeddedWorkspaceMode,
  modeFromHeight,
  normalizeWorkspaceHeight,
  WS_HEIGHT_HIDDEN_MAX,
} from "../../lib/workspaceMode";

/** 程序化 resize 后短暂忽略面板回传，避免 snap 与拖拽打架 */
const SNAP_IGNORE_MS = 120;

/** 底部工作区可拖拽的最大高度占窗口高度比例，超过全屏阈值后会切到工程全屏 */
const BOTTOM_PANEL_MAX_HEIGHT_RATIO = 0.95;
const WORKSPACE_FULLSCREEN_THRESHOLD_RATIO = 0.6;

function useBottomPanelDragMetrics(): { maxPx: number; fullscreenThresholdPx: number } {
  const [metrics, setMetrics] = useState(() => ({
    maxPx: Math.floor(window.innerHeight * BOTTOM_PANEL_MAX_HEIGHT_RATIO),
    fullscreenThresholdPx: Math.floor(window.innerHeight * WORKSPACE_FULLSCREEN_THRESHOLD_RATIO),
  }));

  useEffect(() => {
    const update = () => {
      setMetrics({
        maxPx: Math.floor(window.innerHeight * BOTTOM_PANEL_MAX_HEIGHT_RATIO),
        fullscreenThresholdPx: Math.floor(window.innerHeight * WORKSPACE_FULLSCREEN_THRESHOLD_RATIO),
      });
    };
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return metrics;
}

export interface SidebarBottomProps {
  children: ReactNode;
  sidebar: ReactNode;
  sidebarSizePx?: number;
  sidebarMinPx?: number;
  sidebarMaxPx?: number;
  className?: string;
}

/**
 * 底部可调整/可折叠边栏布局。
 * 展开/折叠由 store 信号驱动；拖拽高度写入 store 以切换 taskbar/thumbnail/half。
 */
export function SidebarBottom({
  children,
  sidebar,
  sidebarMinPx = 21,
  sidebarMaxPx: sidebarMaxPxProp,
  className,
}: SidebarBottomProps) {
  const { maxPx: computedMaxPx, fullscreenThresholdPx } = useBottomPanelDragMetrics();
  const sidebarMaxPx = sidebarMaxPxProp ?? computedMaxPx;
  const bottomPanelRef = useRef<PanelImperativeHandle | null>(null);
  const isSnappingRef = useRef(false);
  const isDraggingRef = useRef(false);
  const cleanupDragListenersRef = useRef<(() => void) | null>(null);
  const ignoreResizeUntilRef = useRef(0);
  const expandSignal = useBottomPanelStore((state) => state.expandSignal);
  const collapseSignal = useBottomPanelStore((state) => state.collapseSignal);
  const isFullscreen = useBottomPanelStore((state) => state.isFullscreen);
  const workspaceMode = useBottomPanelStore((state) => state.workspaceMode);
  const workspaceHeightPx = useBottomPanelStore((state) => state.workspaceHeightPx);
  const lastNonFullscreenMode = useBottomPanelStore(
    (state) => state.lastNonFullscreenMode,
  );
  const setWorkspaceHeight = useBottomPanelStore((state) => state.setWorkspaceHeight);

  const targetBottomPx =
    workspaceHeightPx > WS_HEIGHT_HIDDEN_MAX
      ? workspaceHeightPx
      : defaultHeightForMode(
          lastNonFullscreenMode === "hidden" ? "half" : lastNonFullscreenMode,
        );

  const syncOpenState = useCallback(() => {
    if (useBottomPanelStore.getState().isFullscreen) return;
    const handle = bottomPanelRef.current;
    if (!handle) return;
    const { workspaceMode: mode } = useBottomPanelStore.getState();
    const shouldExpand =
      mode === "half" || mode === "taskbar" || mode === "thumbnail";
    if (shouldExpand) {
      if (handle.isCollapsed()) handle.expand();
    } else if (!handle.isCollapsed()) {
      handle.collapse();
    }
  }, []);

  const snapPanelHeight = useCallback((heightPx: number) => {
    const handle = bottomPanelRef.current;
    if (!handle || useBottomPanelStore.getState().isFullscreen) return;
    isSnappingRef.current = true;
    ignoreResizeUntilRef.current = performance.now() + SNAP_IGNORE_MS;
    requestAnimationFrame(() => {
      handle.resize(`${heightPx}px`);
      requestAnimationFrame(() => {
        isSnappingRef.current = false;
      });
    });
  }, []);

  const applyTargetHeight = useCallback(() => {
    const handle = bottomPanelRef.current;
    if (!handle || useBottomPanelStore.getState().isFullscreen) return;
    const state = useBottomPanelStore.getState();
    if (
      state.workspaceMode !== "half" &&
      state.workspaceMode !== "taskbar" &&
      state.workspaceMode !== "thumbnail"
    ) {
      return;
    }
    const raw =
      state.workspaceHeightPx > WS_HEIGHT_HIDDEN_MAX
        ? state.workspaceHeightPx
        : defaultHeightForMode(
            state.lastNonFullscreenMode === "hidden"
              ? "half"
              : state.lastNonFullscreenMode,
          );
    const mode = modeFromHeight(
      raw,
      isEmbeddedWorkspaceMode(state.workspaceMode) ? state.workspaceMode : undefined,
    );
    const target = normalizeWorkspaceHeight(raw, mode);
    snapPanelHeight(target);
    setWorkspaceHeight(target, { fromUserDrag: false });
  }, [setWorkspaceHeight, snapPanelHeight]);

  useLayoutEffect(() => {
    syncOpenState();
  }, [workspaceMode, isFullscreen, syncOpenState]);

  useEffect(() => {
    if (expandSignal === 0) return;
    syncOpenState();
    applyTargetHeight();
  }, [expandSignal, syncOpenState, applyTargetHeight]);

  useEffect(() => {
    if (collapseSignal === 0) return;
    const handle = bottomPanelRef.current;
    if (handle && !handle.isCollapsed()) {
      handle.collapse();
    }
  }, [collapseSignal]);

  const cleanupDragListeners = useCallback(() => {
    cleanupDragListenersRef.current?.();
    cleanupDragListenersRef.current = null;
  }, []);

  const enterFullscreenFromDrag = useCallback(
    (heightPx: number) => {
      const store = useBottomPanelStore.getState();
      if (store.isFullscreen) return;
      cleanupDragListeners();
      isDraggingRef.current = false;
      setWorkspaceHeight(
        Math.max(defaultHeightForMode("half"), Math.min(heightPx, fullscreenThresholdPx - 1)),
        { fromUserDrag: true, commit: true },
      );
      store.enterWorkspaceFullscreen();
    },
    [cleanupDragListeners, fullscreenThresholdPx, setWorkspaceHeight],
  );

  // 松手提交：按真实像素吸附到规范高度，或在过低时折叠。
  const handleResizeEnd = useCallback(() => {
    const handle = bottomPanelRef.current;
    const store = useBottomPanelStore.getState();
    if (!handle || store.isFullscreen || !isDraggingRef.current) return;
    cleanupDragListeners();
    isDraggingRef.current = false;

    const px = handle.getSize().inPixels;
    if (px >= fullscreenThresholdPx) {
      enterFullscreenFromDrag(px);
      return;
    }
    if (px <= WS_HEIGHT_HIDDEN_MAX) {
      store.requestCollapse();
      return;
    }
    setWorkspaceHeight(px, { fromUserDrag: true, commit: true });
    const target = useBottomPanelStore.getState().workspaceHeightPx;
    if (Math.abs(px - target) > 1) {
      snapPanelHeight(target);
    }
  }, [
    cleanupDragListeners,
    enterFullscreenFromDrag,
    fullscreenThresholdPx,
    setWorkspaceHeight,
    snapPanelHeight,
  ]);

  // 指针按下分隔条即进入拖拽态；全局 pointerup 结束并提交，保证拖拽全程跟手。
  const handleResizeStart = useCallback(() => {
    if (useBottomPanelStore.getState().isFullscreen) return;
    if (isDraggingRef.current) return;
    isDraggingRef.current = true;
    const finish = () => {
      handleResizeEnd();
    };
    cleanupDragListenersRef.current = () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
    };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  }, [handleResizeEnd]);

  const handleBottomHeightChange = useCallback(
    (heightPx: number) => {
      if (useBottomPanelStore.getState().isFullscreen) return;
      // 程序化吸附与窗口尺寸变化不参与模式判定，避免回弹/抖动。
      if (isSnappingRef.current || performance.now() < ignoreResizeUntilRef.current) {
        return;
      }
      if (!isDraggingRef.current) return;

      if (heightPx >= fullscreenThresholdPx) {
        enterFullscreenFromDrag(heightPx);
        return;
      }

      // 拖拽中只切换渲染形态，不吸附面板高度，全程跟手丝滑。
      setWorkspaceHeight(heightPx, { commit: false });
    },
    [enterFullscreenFromDrag, fullscreenThresholdPx, setWorkspaceHeight],
  );

  return (
    <DockWorkspace
      main={children}
      bottom={sidebar}
      bottomSizePx={targetBottomPx}
      bottomMinPx={sidebarMinPx}
      bottomMaxPx={sidebarMaxPx}
      bottomPanelRef={bottomPanelRef}
      onBottomPanelHeightChange={handleBottomHeightChange}
      onBottomResizeStart={handleResizeStart}
      onBottomResizeEnd={handleResizeEnd}
      className={className}
    />
  );
}
