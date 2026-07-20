import { createPortal } from "react-dom";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { VariantProps } from "class-variance-authority";
import { clampMenuPosition } from "../../../lib/contextMenuPosition";
import { cn } from "@/lib/utils";
import { Button, type buttonVariants } from "../primitives/Button";

export interface IconDropdownButtonItem {
  id: string;
  label: string;
  subtitle?: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface IconDropdownButtonProps {
  title: string;
  ariaLabel?: string;
  icon: ReactNode;
  items: IconDropdownButtonItem[];
  disabled?: boolean;
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  className?: string;
  menuMinWidth?: number;
  /** 菜单相对按钮展开方向；页脚场景用 top */
  placement?: "bottom" | "top";
}

/** 图标触发器 + 下拉菜单，适用于工具栏等紧凑场景 */
export function IconDropdownButton({
  title,
  ariaLabel,
  icon,
  items,
  disabled = false,
  variant = "icon",
  size = "icon-sm",
  className,
  menuMinWidth = 180,
  placement = "bottom",
}: IconDropdownButtonProps) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
    minWidth: number;
  } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }

    const syncMenuPosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      const menuEl = menuRef.current;
      if (!rect || !menuEl) {
        return;
      }

      const measuredWidth = menuEl.getBoundingClientRect().width || menuMinWidth;
      const measuredHeight = menuEl.getBoundingClientRect().height;
      const preferredY =
        placement === "top" ? rect.top - measuredHeight - 4 : rect.bottom + 4;
      const anchor = clampMenuPosition(
        { x: rect.left, y: preferredY },
        { width: Math.max(measuredWidth, menuMinWidth), height: measuredHeight },
      );

      setMenuPosition({
        top: anchor.y,
        left: anchor.x,
        minWidth: Math.max(measuredWidth, menuMinWidth),
      });
    };

    syncMenuPosition();
    window.addEventListener("resize", syncMenuPosition);
    window.addEventListener("scroll", syncMenuPosition, true);
    return () => {
      window.removeEventListener("resize", syncMenuPosition);
      window.removeEventListener("scroll", syncMenuPosition, true);
    };
  }, [open, items, menuMinWidth, placement]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: Event) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !wrapRef.current?.contains(target)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  return (
    <>
      <div className={cn("icon-dropdown-button", className)} ref={wrapRef}>
        <Button
          ref={buttonRef}
          type="button"
          variant={variant}
          size={size}
          title={title}
          aria-label={ariaLabel ?? title}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          className={cn("icon-dropdown-button__trigger", open && "icon-dropdown-button__trigger--open")}
          onClick={() => setOpen((value) => !value)}
        >
          {icon}
        </Button>
      </div>
      {open
        ? createPortal(
            <div
              id={menuId}
              role="menu"
              ref={menuRef}
              className="icon-dropdown-button__menu"
              style={{
                position: "fixed",
                top: menuPosition?.top ?? 0,
                left: menuPosition?.left ?? 0,
                minWidth: menuPosition?.minWidth ?? menuMinWidth,
                zIndex: "var(--z-popover, 1200)",
                visibility: menuPosition ? "visible" : "hidden",
                pointerEvents: menuPosition ? "auto" : "none",
              }}
            >
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="icon-dropdown-button__item"
                  disabled={item.disabled}
                  onClick={() => {
                    if (item.disabled) {
                      return;
                    }
                    item.onSelect();
                    setOpen(false);
                  }}
                >
                  <span className="icon-dropdown-button__item-title">{item.label}</span>
                  {item.subtitle ? (
                    <span className="icon-dropdown-button__item-desc">{item.subtitle}</span>
                  ) : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
