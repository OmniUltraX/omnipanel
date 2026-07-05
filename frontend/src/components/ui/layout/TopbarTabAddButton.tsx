import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import type { TopbarAddMenuItem } from "../../../stores/topbarStore";

export interface TopbarTabAddButtonProps {
  title?: string;
  menuItems?: TopbarAddMenuItem[];
  onAdd?: () => void;
  onMenuSelect?: (id: string) => void;
  className?: string;
}

export function TopbarTabAddButton({
  title,
  menuItems,
  onAdd,
  onMenuSelect,
  className,
}: TopbarTabAddButtonProps) {
  const hasAddMenu = (menuItems?.length ?? 0) > 0;
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuPosition, setAddMenuPosition] = useState<{
    top: number;
    left: number;
    minWidth: number;
  } | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const addMenuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!addMenuOpen) return;

    const syncMenuPosition = () => {
      const rect = addMenuButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setAddMenuPosition({
        top: rect.bottom + 6,
        left: rect.left,
        minWidth: Math.max(rect.width * 6, 240),
      });
    };

    const onPointerDown = (event: Event) => {
      const target = event.target as Node;
      if (
        !addMenuRef.current?.contains(target) &&
        !addMenuButtonRef.current?.contains(target)
      ) {
        setAddMenuOpen(false);
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
  }, [addMenuOpen]);

  return (
    <>
      <div className="topbar-tab-add-wrap">
        <button
          ref={addMenuButtonRef}
          type="button"
          className={`btn-icon topbar-tab-add drag-ignore${addMenuOpen ? " active" : ""}${className ? ` ${className}` : ""}`}
          title={title}
          onClick={() => {
            if (hasAddMenu) {
              setAddMenuOpen((open) => !open);
              return;
            }
            onAdd?.();
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        {addMenuOpen &&
          hasAddMenu &&
          addMenuPosition &&
          createPortal(
            <div
              className="topbar-add-menu"
              ref={addMenuRef}
              style={{
                position: "fixed",
                top: addMenuPosition.top,
                left: addMenuPosition.left,
                minWidth: addMenuPosition.minWidth,
                zIndex: "var(--z-subwindow-popover)",
              }}
            >
              {menuItems!.map((item) => (
                <div key={item.id}>
                  {item.dividerBefore && <div className="topbar-add-menu-divider" />}
                  <button
                    type="button"
                    className="topbar-add-menu-item"
                    onClick={() => {
                      onMenuSelect?.(item.id);
                      setAddMenuOpen(false);
                    }}
                  >
                    <span className="topbar-add-menu-label">{item.label}</span>
                    {item.subtitle && (
                      <span className="topbar-add-menu-sub">{item.subtitle}</span>
                    )}
                  </button>
                </div>
              ))}
            </div>,
            document.body,
          )}
      </div>
    </>
  );
}
