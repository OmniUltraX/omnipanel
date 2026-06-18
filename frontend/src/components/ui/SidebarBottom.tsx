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
  halfHeightPx,
  resolveEmbeddedHeight,
  WS_HEIGHT_HIDDEN_MAX,
} from "../../lib/workspaceMode";

/** 程序化 resize 后短暂忽略面板回传，避免 snap 与拖拽打架 */
const SNAP_IGNORE_MS = 120;

/** 底部工作区可拖拽的最大高度占窗口高度比例 */
const BOTTOM_PANEL_MAX_HEIGHT_RATIO = 0.95;
/** 拖拽高度超过窗口此比例时进入工程全屏 */
const WORKSPACE_FULLSCREEN_THRESHOLD_RATIO = 0.65;

function useBottomPanelDragMetrics(): { maxPx: number; fullscreenThresholdPx: number } {
  const [metrics, setMetrics] = useState(() => ({
    maxPx: Math.floor(window.innerHeight * BOTTOM_PANEL_MAX_HEIGHT_RATIO),
    fullscreenThresholdPx: Math.floor(
      window.innerHeight * WORKSPACE_FULLSCREEN_THRESHOLD_RATIO,
    ),
  }));

  useEffect(() => {
    const update = () => {
      setMetrics({
        maxPx: Math.floor(window.innerHeight * BOTTOM_PANEL_MAX_HEIGHT_RATIO),
        fullscreenThresholdPx: Math.floor(
          window.innerHeight * WORKSPACE_FULLSCREEN_THRESHOLD_RATIO,
        ),
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
  const userResizeActiveRef = useRef(false);
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

  const shouldIgnorePanelResize = useCallback(() => {
    return (
      isSnappingRef.current ||
      performance.now() < ignoreResizeUntilRef.current ||
      useBottomPanelStore.getState().isFullscreen
    );
  }, []);

  const readBottomPanelPx = useCallback((): number | null => {
    const handle = bottomPanelRef.current;
    if (!handle) return null;
    return handle.getSize().inPixels;
  }, []);

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
    userResizeActiveRef.current = false;
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
        : state.workspaceMode === "half"
          ? halfHeightPx()
          : defaultHeightForMode(
              state.lastNonFullscreenMode === "hidden"
                ? "half"
                : state.lastNonFullscreenMode,
            );
    const { height: target } = resolveEmbeddedHeight(raw);
    snapPanelHeight(target);
    setWorkspaceHeight(target, { commit: true });
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

  const enterFullscreenFromDrag = useCallback(
    (heightPx: number) => {
      const store = useBottomPanelStore.getState();
      if (store.isFullscreen) return;
      userResizeActiveRef.current = false;
      const capped = Math.min(heightPx, fullscreenThresholdPx - 1);
      const { mode, height } = resolveEmbeddedHeight(capped);
      useBottomPanelStore.setState({
        workspaceHeightPx: height,
        lastNonFullscreenMode: mode,
      });
      store.enterWorkspaceFullscreen();
    },
    [fullscreenThresholdPx],
  );

  const processLiveResize = useCallback(
    (heightPx: number) => {
      if (heightPx >= fullscreenThresholdPx) {
        enterFullscreenFromDrag(heightPx);
        return;
      }
      setWorkspaceHeight(heightPx, { commit: false });
    },
    [enterFullscreenFromDrag, fullscreenThresholdPx, setWorkspaceHeight],
  );

  /** 用户拖拽分隔条时由 react-resizable-panels 的 onLayoutChange 驱动（跟手切模式） */
  const handleBottomLayoutChange = useCallback(() => {
    if (shouldIgnorePanelResize()) return;
    userResizeActiveRef.current = true;
    const px = readBottomPanelPx();
    if (px == null) return;
    processLiveResize(px);
  }, [processLiveResize, readBottomPanelPx, shouldIgnorePanelResize]);

  /** 松手提交：onLayoutChanged 在指针释放后触发 */
  const handleBottomLayoutChanged = useCallback(() => {
    if (shouldIgnorePanelResize()) return;
    if (!userResizeActiveRef.current) return;
    userResizeActiveRef.current = false;

    const store = useBottomPanelStore.getState();
    const px = readBottomPanelPx();
    if (px == null) return;

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
    enterFullscreenFromDrag,
    fullscreenThresholdPx,
    readBottomPanelPx,
    setWorkspaceHeight,
    shouldIgnorePanelResize,
    snapPanelHeight,
  ]);

  return (
    <DockWorkspace
      main={children}
      bottom={sidebar}
      bottomSizePx={targetBottomPx}
      bottomMinPx={sidebarMinPx}
      bottomMaxPx={sidebarMaxPx}
      bottomPanelRef={bottomPanelRef}
      onBottomLayoutChange={handleBottomLayoutChange}
      onBottomResizeEnd={handleBottomLayoutChanged}
      className={className}
    />
  );
}
