import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  getModuleLeftSidebarSize,
  MODULE_LEFT_SIDEBAR_DEFAULT_PX,
  MODULE_LEFT_SIDEBAR_MIN_PX,
  usePanelLayoutStore,
} from "../stores/panelLayoutStore";

export const MODULE_LEFT_SIDEBAR_COLLAPSED_PX = 12;

export function applySharedModuleLeftSidebarState(
  handle: PanelImperativeHandle | null,
): boolean {
  if (!handle) return false;

  const { moduleLeftSidebarCollapsed: collapsed, leftSizes } = usePanelLayoutStore.getState();
  const width = getModuleLeftSidebarSize(leftSizes) ?? MODULE_LEFT_SIDEBAR_DEFAULT_PX;

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

export interface UseSharedModuleLeftSidebarOptions {
  leftPanelRef: RefObject<PanelImperativeHandle | null>;
  /** 模块路由激活时再同步（避免隐藏叠层模块抢写面板状态） */
  syncWhenActive?: boolean;
  moduleActive?: boolean;
  hasLeft?: boolean;
  propSizePx?: number;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function useSharedModuleLeftSidebar({
  leftPanelRef,
  syncWhenActive = false,
  moduleActive = true,
  hasLeft = true,
  propSizePx,
  onCollapsedChange,
}: UseSharedModuleLeftSidebarOptions) {
  const savedSize = usePanelLayoutStore((s) => getModuleLeftSidebarSize(s.leftSizes));
  const moduleLeftSidebarCollapsed = usePanelLayoutStore((s) => s.moduleLeftSidebarCollapsed);
  const setModuleLeftSidebarSize = usePanelLayoutStore((s) => s.setModuleLeftSidebarSize);
  const setModuleLeftSidebarCollapsed = usePanelLayoutStore((s) => s.setModuleLeftSidebarCollapsed);
  const leftSizePx = propSizePx ?? savedSize ?? MODULE_LEFT_SIDEBAR_DEFAULT_PX;
  const pendingLeftSizeRef = useRef<number | null>(null);
  const prevModuleActiveRef = useRef(false);

  const updateSidebarCollapsed = useCallback(
    (collapsed: boolean) => {
      setModuleLeftSidebarCollapsed(collapsed);
      onCollapsedChange?.(collapsed);
    },
    [setModuleLeftSidebarCollapsed, onCollapsedChange],
  );

  const handleLeftResize = useCallback(
    (sizePx: number) => {
      pendingLeftSizeRef.current = sizePx;
      updateSidebarCollapsed(sizePx < MODULE_LEFT_SIDEBAR_COLLAPSED_PX);
    },
    [updateSidebarCollapsed],
  );

  const handleLeftLayoutChanged = useCallback(() => {
    const size = pendingLeftSizeRef.current ?? leftPanelRef.current?.getSize().inPixels;
    pendingLeftSizeRef.current = null;
    if (size == null || size < MODULE_LEFT_SIDEBAR_MIN_PX) {
      updateSidebarCollapsed(size != null && size < MODULE_LEFT_SIDEBAR_COLLAPSED_PX);
      return;
    }
    setModuleLeftSidebarSize(size);
    updateSidebarCollapsed(false);
  }, [leftPanelRef, setModuleLeftSidebarSize, updateSidebarCollapsed]);

  const syncFromStore = useCallback(() => {
    if (!hasLeft) return false;
    if (syncWhenActive && !moduleActive) return false;
    return applySharedModuleLeftSidebarState(leftPanelRef.current);
  }, [hasLeft, syncWhenActive, moduleActive, leftPanelRef]);

  useLayoutEffect(() => {
    if (!hasLeft) {
      prevModuleActiveRef.current = moduleActive;
      return;
    }

    if (syncWhenActive) {
      if (!moduleActive) {
        prevModuleActiveRef.current = moduleActive;
        return;
      }
      const justActivated = !prevModuleActiveRef.current && moduleActive;
      prevModuleActiveRef.current = moduleActive;
      if (!justActivated) return;
    }

    if (!syncFromStore()) {
      requestAnimationFrame(() => {
        syncFromStore();
      });
    }
  }, [hasLeft, syncWhenActive, moduleActive, syncFromStore]);

  return {
    leftSizePx,
    moduleLeftSidebarCollapsed,
    handleLeftResize,
    handleLeftLayoutChanged,
    updateSidebarCollapsed,
    syncFromStore,
  };
}
