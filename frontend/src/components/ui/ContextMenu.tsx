import { useEffect, useRef, useState } from "react";

export interface ContextMenuItem {
  /** 菜单项唯一标识（用于 React key，避免嵌套菜单索引冲突） */
  id: string;
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** 子菜单项（仅一层，不再递归） */
  children?: ContextMenuItem[];
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

/** 子菜单列表（独立组件类型，避免与主面板递归复用导致 React key/state 错乱） */
function ContextMenuSubmenuList({
  items,
  onClose,
}: {
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  return (
    <div className="context-menu-submenu" role="menu">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="context-menu-item"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onClick?.();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function ContextMenuPanel({
  items,
  onClose,
}: {
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);

  return (
    <div className="context-menu-panel">
      {items.map((item) => {
        const hasChildren = (item.children?.length ?? 0) > 0;
        return (
          <div
            key={item.id}
            className={`context-menu-row${hasChildren ? " context-menu-row--submenu" : ""}`}
            onMouseEnter={() => hasChildren && setOpenSubmenuId(item.id)}
            onMouseLeave={() => hasChildren && setOpenSubmenuId((prev) => (prev === item.id ? null : prev))}
          >
            <button
              type="button"
              className={`context-menu-item${item.danger ? " context-menu-item--danger" : ""}${hasChildren ? " context-menu-item--has-children" : ""}`}
              disabled={item.disabled}
              onClick={() => {
                if (hasChildren || item.disabled) return;
                item.onClick?.();
                onClose();
              }}
            >
              <span>{item.label}</span>
              {hasChildren && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10" aria-hidden>
                  <path d="M9 18l6-6-6-6" />
                </svg>
              )}
            </button>
            {hasChildren && openSubmenuId === item.id && (
              <ContextMenuSubmenuList items={item.children!} onClose={onClose} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") onClose();
        return;
      }
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", handler);
    };
  }, [onClose]);

  const menuStyle: React.CSSProperties = {
    left: position.x,
    top: position.y,
  };

  return (
    <div className="context-menu" ref={ref} style={menuStyle}>
      <ContextMenuPanel items={items} onClose={onClose} />
    </div>
  );
}
