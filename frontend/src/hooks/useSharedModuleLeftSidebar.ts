import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  clampModuleLeftSidebarSize,
  getModuleLeftSidebarCollapsed,
  getModuleLeftSidebarMaxPx,
  getModuleLeftSidebarSize,
  MODULE_LEFT_SIDEBAR_DEFAULT_PX,
  MODULE_LEFT_SIDEBAR_MIN_PX,
  usePanelLayoutStore,
} from "../stores/panelLayoutStore";

export const MODULE_LEFT_SIDEBAR_COLLAPSED_PX = 12;

const SIDEBAR_SYNC_MAX_ATTEMPTS = 12;

export function applySharedModuleLeftSidebarState(
  handle: PanelImperativeHandle | null,
  layoutKey: string,
): boolean {
  if (!handle) return false;

  const state = usePanelLayoutStore.getState();
  const collapsed = getModuleLeftSidebarCollapsed(
    state.moduleLeftSidebarCollapsedByKey,
    layoutKey,
  );
  const rawWidth = getModuleLeftSidebarSize(state.leftSizes, layoutKey) ?? MODULE_LEFT_SIDEBAR_DEFAULT_PX;
  const width = clampModuleLeftSidebarSize(rawWidth);

  if (collapsed) {
    if (!handle.isCollapsed()) {
      handle.collapse();
    }
    return true;
  }

  if (handle.isCollapsed()) {
    handle.expand();
  }
  handle.resize(`${width}px`);
  return true;
}

function rootIsMeasurable(rootRef: RefObject<HTMLElement | null> | undefined): boolean {
  if (!rootRef) return true;
  const root = rootRef.current;
  if (!root) return false;
  return root.offsetWidth > 0;
}

export interface UseSharedModuleLeftSidebarOptions {
  leftPanelRef: RefObject<PanelImperativeHandle | null>;
  /**
   * 模块工作区根节点。隐藏叠层的 offset 为 0 时不要 imperative resize。
   * 不传则视为始终可测量（设置窗口等独立表面）。
   */
  visibleRootRef?: RefObject<HTMLElement | null>;
  /** 模块路由激活时再同步（避免隐藏叠层模块抢写面板状态） */
  syncWhenActive?: boolean;
  moduleActive?: boolean;
  hasLeft?: boolean;
  /** 该模块自己的侧栏宽度 key（ssh、database、settings 等） */
  layoutKey: string;
  propSizePx?: number;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function useSharedModuleLeftSidebar({
  leftPanelRef,
  visibleRootRef,
  syncWhenActive = false,
  moduleActive = true,
  hasLeft = true,
  layoutKey,
  propSizePx,
  onCollapsedChange,
}: UseSharedModuleLeftSidebarOptions) {
  const savedSize = usePanelLayoutStore((s) => getModuleLeftSidebarSize(s.leftSizes, layoutKey));
  const moduleLeftSidebarCollapsed = usePanelLayoutStore((s) =>
    getModuleLeftSidebarCollapsed(s.moduleLeftSidebarCollapsedByKey, layoutKey),
  );
  const setModuleLeftSidebarSize = usePanelLayoutStore((s) => s.setModuleLeftSidebarSize);
  const setModuleLeftSidebarCollapsed = usePanelLayoutStore((s) => s.setModuleLeftSidebarCollapsed);
  const leftSizePx = clampModuleLeftSidebarSize(
    propSizePx ?? savedSize ?? MODULE_LEFT_SIDEBAR_DEFAULT_PX,
  );
  // defaultSize 只在 Panel 注册时生效，且变更会重新注册。
  // 各模块实例冻结首次宽度，避免共享 store 一变就把隐藏面板按 0 宽重算。
  const leftDefaultSizePxRef = useRef(leftSizePx);
  const pendingLeftSizeRef = useRef<number | null>(null);
  const prevModuleActiveRef = useRef(false);
  const moduleActiveRef = useRef(moduleActive);
  moduleActiveRef.current = moduleActive;
  const userResizeRef = useRef(false);
  const userResizeGenRef = useRef(0);

  const updateSidebarCollapsed = useCallback(
    (collapsed: boolean) => {
      setModuleLeftSidebarCollapsed(layoutKey, collapsed);
      onCollapsedChange?.(collapsed);
    },
    [layoutKey, setModuleLeftSidebarCollapsed, onCollapsedChange],
  );

  const canPersistLayout = useCallback(() => {
    if (!hasLeft || !userResizeRef.current) return false;
    if (syncWhenActive && !moduleActiveRef.current) return false;
    return true;
  }, [hasLeft, syncWhenActive]);

  const armUserResize = useCallback(() => {
    if (syncWhenActive && !moduleActiveRef.current) return;
    userResizeGenRef.current += 1;
    userResizeRef.current = true;
  }, [syncWhenActive]);

  const scheduleClearUserResize = useCallback(() => {
    const gen = userResizeGenRef.current;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (userResizeGenRef.current === gen) {
          userResizeRef.current = false;
        }
      });
    });
  }, []);

  const handleLeftHandlePointerDown = useCallback(() => {
    armUserResize();
  }, [armUserResize]);

  const handleLeftHandleKeyDown = useCallback(() => {
    armUserResize();
    scheduleClearUserResize();
  }, [armUserResize, scheduleClearUserResize]);

  useEffect(() => {
    if (!hasLeft) return;
    const onPointerEnd = () => {
      if (!userResizeRef.current) return;
      scheduleClearUserResize();
    };
    window.addEventListener("pointerup", onPointerEnd, true);
    window.addEventListener("pointercancel", onPointerEnd, true);
    return () => {
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerEnd, true);
    };
  }, [hasLeft, scheduleClearUserResize]);

  const handleLeftResize = useCallback(
    (sizePx: number) => {
      if (!canPersistLayout()) return;
      pendingLeftSizeRef.current = sizePx;
      updateSidebarCollapsed(sizePx < MODULE_LEFT_SIDEBAR_COLLAPSED_PX);
    },
    [canPersistLayout, updateSidebarCollapsed],
  );

  const handleLeftLayoutChanged = useCallback(() => {
    const size = pendingLeftSizeRef.current ?? leftPanelRef.current?.getSize().inPixels;
    pendingLeftSizeRef.current = null;
    // 隐藏叠层的布局变化不能写回，而且只写当前模块自己的宽度。
    if (!canPersistLayout()) return;
    if (size == null || size < MODULE_LEFT_SIDEBAR_MIN_PX) {
      updateSidebarCollapsed(size != null && size < MODULE_LEFT_SIDEBAR_COLLAPSED_PX);
      return;
    }
    setModuleLeftSidebarSize(layoutKey, clampModuleLeftSidebarSize(size));
    updateSidebarCollapsed(false);
  }, [canPersistLayout, layoutKey, leftPanelRef, setModuleLeftSidebarSize, updateSidebarCollapsed]);

  useLayoutEffect(() => {
    if (!hasLeft) {
      prevModuleActiveRef.current = moduleActive;
      return;
    }

    if (syncWhenActive && !moduleActive) {
      prevModuleActiveRef.current = moduleActive;
      return;
    }

    if (syncWhenActive) {
      const justActivated = !prevModuleActiveRef.current && moduleActive;
      prevModuleActiveRef.current = moduleActive;
      if (!justActivated) return;
    }

    let cancelled = false;
    let raf = 0;
    let attempts = 0;
    let applied = false;

    const tick = () => {
      if (cancelled) return;
      if (syncWhenActive && !moduleActiveRef.current) return;
      const measurable = rootIsMeasurable(visibleRootRef);
      if (!leftPanelRef.current || !measurable) {
        if (attempts < SIDEBAR_SYNC_MAX_ATTEMPTS) {
          attempts += 1;
          raf = requestAnimationFrame(tick);
        }
        return;
      }
      const ok = applySharedModuleLeftSidebarState(leftPanelRef.current, layoutKey);
      if (!ok) {
        if (attempts < SIDEBAR_SYNC_MAX_ATTEMPTS) {
          attempts += 1;
          raf = requestAnimationFrame(tick);
        }
        return;
      }
      // 库的 ResizeObserver 会在本次布局之后再算一次，下一帧再对齐本模块自己的宽度
      if (!applied) {
        applied = true;
        raf = requestAnimationFrame(tick);
      }
    };

    tick();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [hasLeft, syncWhenActive, moduleActive, layoutKey, leftPanelRef, visibleRootRef]);

  // 窗口变窄时，将超出 40% 上限的侧栏宽度钳回并写回 store
  useEffect(() => {
    if (!hasLeft) return;
    if (syncWhenActive && !moduleActive) return;

    const clampToViewport = () => {
      if (syncWhenActive && !moduleActiveRef.current) return;
      if (!rootIsMeasurable(visibleRootRef)) return;
      const handle = leftPanelRef.current;
      if (!handle || handle.isCollapsed()) return;

      const maxPx = getModuleLeftSidebarMaxPx();
      const current =
        pendingLeftSizeRef.current ??
        handle.getSize().inPixels ??
        getModuleLeftSidebarSize(usePanelLayoutStore.getState().leftSizes, layoutKey);
      if (current == null || current <= maxPx) return;

      const next = clampModuleLeftSidebarSize(current);
      handle.resize(`${next}px`);
      setModuleLeftSidebarSize(layoutKey, next);
    };

    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, [
    hasLeft,
    syncWhenActive,
    moduleActive,
    layoutKey,
    leftPanelRef,
    visibleRootRef,
    setModuleLeftSidebarSize,
  ]);

  return {
    leftSizePx,
    leftDefaultSizePx: leftDefaultSizePxRef.current,
    moduleLeftSidebarCollapsed,
    handleLeftResize,
    handleLeftLayoutChanged,
    handleLeftHandlePointerDown,
    handleLeftHandleKeyDown,
    updateSidebarCollapsed,
  };
}
