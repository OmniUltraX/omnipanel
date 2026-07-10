import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface StatusBarPanelPopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** 默认在锚点上方展开（状态栏场景） */
  placement?: "above" | "below";
}

/**
 * 状态栏面板 Popover：portal 渲染，默认在触发按钮上方展开。
 */
export function StatusBarPanelPopover({
  anchorRef,
  open,
  onClose,
  title,
  children,
  placement = "above",
}: StatusBarPanelPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const [ready, setReady] = useState(false);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const el = panelRef.current;
    if (!anchor || !el) return;

    const anchorRect = anchor.getBoundingClientRect();
    const { width, height } = el.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    const desiredLeft = anchorRect.right - width;
    const left = Math.max(margin, Math.min(desiredLeft, window.innerWidth - width - margin));
    const popoverHeight = height > 0 ? height : 120;
    const spaceBelow = window.innerHeight - anchorRect.bottom - gap;
    const spaceAbove = anchorRect.top - gap;

    let openBelow = placement === "below";
    if (openBelow && spaceBelow < popoverHeight && spaceAbove >= spaceBelow) {
      openBelow = false;
    } else if (!openBelow && spaceAbove < popoverHeight && spaceBelow > spaceAbove) {
      openBelow = true;
    }

    if (openBelow) {
      setCoords({ left, top: anchorRect.bottom + gap });
    } else {
      setCoords({ left, bottom: window.innerHeight - anchorRect.top + gap });
    }
    setReady(true);
  }, [anchorRef, placement]);

  useLayoutEffect(() => {
    if (!open) {
      setReady(false);
      setCoords(null);
      return;
    }
    updatePosition();
  }, [open, updatePosition, title]);

  useEffect(() => {
    if (!open) return;
    const el = panelRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => updatePosition());
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return createPortal(
    <div
      ref={panelRef}
      className={`statusbar-panel-popover${ready ? " is-ready" : ""}`}
      style={coords ?? undefined}
      role="dialog"
      aria-label={title}
    >
      {title ? <div className="statusbar-panel-popover__title">{title}</div> : null}
      <div className="statusbar-panel-popover__body">{children}</div>
    </div>,
    document.body,
  );
}
