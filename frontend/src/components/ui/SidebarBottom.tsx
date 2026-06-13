import { useCallback, useEffect, useRef, type ReactNode } from "react";
import type { OnPanelResize, PanelImperativeHandle } from "react-resizable-panels";
import { DockWorkspace } from "../dock";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";

export interface SidebarBottomProps {
  /** 主内容区 */
  children: ReactNode;
  /** 底部侧栏（可拖拽调整高度，拖至最矮可折叠隐藏） */
  sidebar: ReactNode;
  /** 覆盖底部侧栏默认高度（px） */
  sidebarSizePx?: number;
  /** 底部侧栏最小高度（px） */
  sidebarMinPx?: number;
  /** 底部侧栏最大高度（px） */
  sidebarMaxPx?: number;
  className?: string;
}

/**
 * 底部可调整/可折叠边栏布局。
 * 与 SidebarWorkspace / SidebarSecondary 风格一致，侧栏位于底部，从下方向上扩展。
 * 拖拽顶部 dock-handle 可改变侧栏高度，拖至最矮可折叠隐藏。
 *
 * 订阅 `useBottomPanelStore` 的 expandSignal：触发后调用底部面板 ref 的
 * `expand()`，使被折叠的底栏自动展开。
 */
export function SidebarBottom({
  children,
  sidebar,
  sidebarSizePx = 220,
  sidebarMinPx = 160,
  sidebarMaxPx = 420,
  className,
}: SidebarBottomProps) {
  const bottomPanelRef = useRef<PanelImperativeHandle | null>(null);
  const expandSignal = useBottomPanelStore((state) => state.expandSignal);
  const collapseSignal = useBottomPanelStore((state) => state.collapseSignal);
  const setIsOpen = useBottomPanelStore((state) => state.setIsOpen);

  const syncOpenState = useCallback(() => {
    const handle = bottomPanelRef.current;
    if (handle) {
      setIsOpen(!handle.isCollapsed());
    }
  }, [setIsOpen]);

  useEffect(() => {
    if (expandSignal === 0) return;
    const handle = bottomPanelRef.current;
    if (handle?.isCollapsed()) {
      handle.expand();
    }
    syncOpenState();
  }, [expandSignal, syncOpenState]);

  useEffect(() => {
    if (collapseSignal === 0) return;
    const handle = bottomPanelRef.current;
    if (handle && !handle.isCollapsed()) {
      handle.collapse();
    }
    syncOpenState();
  }, [collapseSignal, syncOpenState]);

  const handleBottomPanelResize = useCallback<OnPanelResize>(() => {
    syncOpenState();
  }, [syncOpenState]);

  return (
    <DockWorkspace
      main={children}
      bottom={sidebar}
      bottomSizePx={sidebarSizePx}
      bottomMinPx={sidebarMinPx}
      bottomMaxPx={sidebarMaxPx}
      bottomPanelRef={bottomPanelRef}
      onBottomPanelResize={handleBottomPanelResize}
      className={className}
    />
  );
}
