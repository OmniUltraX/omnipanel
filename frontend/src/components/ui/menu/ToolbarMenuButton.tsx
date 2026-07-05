import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState } from "react";
import { Button, type buttonVariants } from "../primitives/Button";
import type { VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export interface ToolbarMenuButtonItem {
  id: string;
  label: string;
  subtitle?: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface ToolbarMenuButtonProps {
  label: string;
  title?: string;
  disabled?: boolean;
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  className?: string;
  items: ToolbarMenuButtonItem[];
}

/** 工具栏下拉按钮：主按钮展开菜单项。 */
export function ToolbarMenuButton({
  label,
  title,
  disabled = false,
  variant = "secondary",
  size = "sm",
  className,
  items,
}: ToolbarMenuButtonProps) {
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

  useEffect(() => {
    if (!open) return;

    const syncMenuPosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPosition({
        top: rect.bottom + 4,
        left: rect.left,
        minWidth: Math.max(rect.width, 168),
      });
    };

    const onPointerDown = (event: Event) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !wrapRef.current?.contains(target)) {
        setOpen(false);
      }
    };

    syncMenuPosition();
    window.addEventListener("resize", syncMenuPosition);
    window.addEventListener("scroll", syncMenuPosition, true);
    document.addEventListener("mousedown", onPointerDown);

    return () => {
      window.removeEventListener("resize", syncMenuPosition);
      window.removeEventListener("scroll", syncMenuPosition, true);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  return (
    <>
      <div className={cn("toolbar-menu-button", className)} ref={wrapRef}>
        <Button
          ref={buttonRef}
          type="button"
          variant={variant}
          size={size}
          title={title ?? label}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          className={cn("toolbar-menu-button__trigger", open && "toolbar-menu-button__trigger--open")}
          onClick={() => setOpen((value) => !value)}
        >
          <span>{label}</span>
          <svg
            className="toolbar-menu-button__chevron"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </Button>
      </div>
      {open &&
        menuPosition &&
        createPortal(
          <div
            id={menuId}
            role="menu"
            ref={menuRef}
            className="toolbar-menu-button__menu"
            style={{
              position: "fixed",
              top: menuPosition.top,
              left: menuPosition.left,
              minWidth: menuPosition.minWidth,
            }}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className="toolbar-menu-button__item"
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return;
                  item.onSelect();
                  setOpen(false);
                }}
              >
                <span className="toolbar-menu-button__item-label">{item.label}</span>
                {item.subtitle ? (
                  <span className="toolbar-menu-button__item-sub">{item.subtitle}</span>
                ) : null}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
