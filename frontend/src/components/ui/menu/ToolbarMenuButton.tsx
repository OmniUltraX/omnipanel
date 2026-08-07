import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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

  const syncMenuPosition = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;

    const margin = 8;
    const minWidth = Math.max(rect.width, 180);
    const measured = menuRef.current?.getBoundingClientRect().width ?? 0;
    const width = Math.max(minWidth, measured);

    // 靠右的工具栏按钮：优先与 trigger 右对齐，避免菜单伸出窗口右侧被裁切
    let left = rect.right - width;
    if (left < margin) {
      left = rect.left;
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

    let top = rect.bottom + 4;
    const menuHeight = menuRef.current?.getBoundingClientRect().height ?? 0;
    if (menuHeight > 0 && top + menuHeight > window.innerHeight - margin) {
      const above = rect.top - menuHeight - 4;
      if (above >= margin) top = above;
    }

    setMenuPosition((prev) => {
      if (
        prev &&
        prev.top === top &&
        prev.left === left &&
        prev.minWidth === minWidth
      ) {
        return prev;
      }
      return { top, left, minWidth };
    });
  };

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }
    syncMenuPosition();
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !menuPosition) return;
    // 菜单挂载后再量一次真实宽度，纠正初次估算
    syncMenuPosition();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在打开后首帧与宽度估算变化时复测
  }, [open, menuPosition?.minWidth, items.length]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: Event) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !wrapRef.current?.contains(target)) {
        setOpen(false);
      }
    };

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
              zIndex: 200010,
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
