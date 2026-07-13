import { useCallback, useRef, type MouseEvent as ReactMouseEvent } from "react";
import type { IDockviewPanelHeaderProps } from "dockview-react";

interface DockTabChromeProps extends Pick<IDockviewPanelHeaderProps, "api"> {
  closable?: boolean;
  tooltip?: string;
  isPreview?: boolean;
  onContextMenu?: (event: ReactMouseEvent) => void;
  onPointerDown?: (event: React.PointerEvent) => void;
  onPointerUp?: (event: React.PointerEvent) => void;
  onPointerLeave?: (event: React.PointerEvent) => void;
  onDoubleClick?: (event: ReactMouseEvent) => void;
  onClick?: (event: ReactMouseEvent) => void;
  tabId?: string;
  children: React.ReactNode;
}

/**
 * dockview v6 的 DockviewDefaultTab 只渲染 api.title，不渲染 children。
 * 本组件复刻其拖拽/关闭交互，内容由 children 完全自定义（图标、标题、状态点等）。
 */
export function DockTabChrome({
  api,
  closable = true,
  tooltip,
  isPreview = false,
  onContextMenu,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  onDoubleClick,
  onClick,
  tabId,
  children,
}: DockTabChromeProps) {
  const isMiddleMouseButton = useRef(false);

  const onClose = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      api.close();
    },
    [api],
  );

  const onBtnPointerDown = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      isMiddleMouseButton.current = event.button === 1;
      onPointerDown?.(event);
    },
    [onPointerDown],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent) => {
      if (isMiddleMouseButton.current && event.button === 1 && closable) {
        isMiddleMouseButton.current = false;
        onClose(event);
      }
      onPointerUp?.(event);
    },
    [onPointerUp, onClose, closable],
  );

  const handlePointerLeave = useCallback(
    (event: React.PointerEvent) => {
      isMiddleMouseButton.current = false;
      onPointerLeave?.(event);
    },
    [onPointerLeave],
  );

  return (
    <div
      className={`dv-default-tab${isPreview ? " dv-default-tab--preview" : ""}`}
      title={tooltip}
      data-dock-tab-id={tabId}
      onContextMenu={onContextMenu}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onDoubleClick={onDoubleClick}
      onClick={onClick}
    >
      <span className="dv-default-tab-content dock-tab-header-inner">{children}</span>
      {closable ? (
        <div
          className="dv-default-tab-action drag-ignore"
          onPointerDown={onBtnPointerDown}
          onClick={onClose}
        >
          <svg width="16" height="16" viewBox="0 0 28 28" fill="none" aria-hidden>
            <path stroke="currentColor" strokeWidth="2" d="M8 8l12 12M20 8L8 20" />
          </svg>
        </div>
      ) : null}
    </div>
  );
}
