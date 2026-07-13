import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { clampMenuPosition, computeSubmenuPosition, type Point } from "../../../lib/contextMenuPosition";

export interface ContextMenuItem {
  /** 菜单项唯一标识（用于React key，避免嵌套菜单索引冲突） */
  id: string;
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** 分隔线（仅渲染线，不响应点击）*/
  separator?: boolean;
  /** 左侧图标（可选） */
  icon?: ReactNode;
  /** 右侧快捷键提示（可选） */
  shortcut?: string;
  /** 禁用时悬停提示（配合 `disabledReasonIcon` 展示问号图标）*/
  disabledReason?: string;
  /** 禁用时在右侧显示原因提示图标，默认 true */
  disabledReasonIcon?: boolean;
  /** 子菜单项（仅一层，不再递归）*/
  children?: ContextMenuItem[];
}

function ContextMenuDisabledHint({ reason }: { reason: string }) {
  const [visible, setVisible] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties>({});

  const updateTooltipPosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setTooltipStyle({
      position: "fixed",
      left: rect.right + 8,
      top: rect.top + rect.height / 2,
      transform: "translateY(-50%)",
      zIndex: 100001,
    });
  }, []);

  const showTooltip = () => {
    updateTooltipPosition();
    setVisible(true);
  };

  const hideTooltip = () => {
    setVisible(false);
  };

  return (
    <>
      <span
        ref={anchorRef}
        className="context-menu-item__hint"
        aria-label={reason}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <circle cx="8" cy="8" r="6.25" />
          <path d="M6.2 6.1a1.8 1.8 0 0 1 3.5.7c0 1.2-1.7 1.3-1.7 2.4" />
          <circle cx="8" cy="11.6" r="0.55" fill="currentColor" stroke="none" />
        </svg>
      </span>
      {visible
        ? createPortal(
            <div className="context-menu-item__hint-tooltip" style={tooltipStyle} role="tooltip">
              {reason}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function ContextMenuDisabledHintSlot({ reason }: { reason: string }) {
  return (
    <div className="context-menu-item__hint-slot">
      <ContextMenuDisabledHint reason={reason} />
    </div>
  );
}

export interface ContextMenuProps {
  items: ContextMenuItem[];
  position: Point;
  onClose: () => void;
  /** 附加 class，如 context-menu--wide */
  className?: string;
}

const SUBMENU_HOVER_DELAY_MS = 120;

function isContextMenuNode(target: EventTarget | null): boolean {
  return Boolean((target as Node | null) && (target as Element).closest?.(".context-menu, .context-menu-submenu"));
}

function runItemAction(item: ContextMenuItem, onClose: () => void) {
  if (item.disabled || item.separator) return;
  item.onClick?.();
  onClose();
}

function ContextMenuSubmenuList({
  items,
  anchorRef,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: {
  items: ContextMenuItem[];
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<Point | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const el = ref.current;
    if (!anchor || !el) return;
    const { width, height } = el.getBoundingClientRect();
    setCoords(computeSubmenuPosition(anchor.getBoundingClientRect(), { width, height }));
  }, [items, anchorRef]);

  const submenu = (
    <div
      ref={ref}
      className="context-menu-submenu"
      style={{
        left: coords?.x ?? 0,
        top: coords?.y ?? 0,
        visibility: coords ? "visible" : "hidden",
      }}
      role="menu"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {items.map((item) =>
        item.separator ? (
          <div key={item.id} className="context-menu-sep" role="separator" />
        ) : (
          <div key={item.id} className="context-menu-row context-menu-row--with-hint">
            <button
              type="button"
              role="menuitem"
              className="context-menu-item"
              disabled={item.disabled}
              onClick={() => runItemAction(item, onClose)}
            >
              {item.icon ? <span className="context-menu-item__icon">{item.icon}</span> : null}
              <span className="context-menu-item__label">{item.label}</span>
              {item.shortcut ? (
                <span className="context-menu-item__shortcut">{item.shortcut}</span>
              ) : null}
            </button>
            {item.disabled && item.disabledReason && item.disabledReasonIcon !== false ? (
              <ContextMenuDisabledHintSlot reason={item.disabledReason} />
            ) : null}
          </div>
        ),
      )}
    </div>
  );

  return createPortal(submenu, document.body);
}

function ContextMenuPanel({
  items,
  onClose,
}: {
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const cancelCloseSubmenu = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleCloseSubmenu = () => {
    cancelCloseSubmenu();
    closeTimerRef.current = window.setTimeout(() => setOpenSubmenuId(null), SUBMENU_HOVER_DELAY_MS);
  };

  const openSubmenu = (id: string) => {
    cancelCloseSubmenu();
    setOpenSubmenuId(id);
  };

  useEffect(() => () => cancelCloseSubmenu(), []);

  return (
    <div className="context-menu-panel">
      {items.map((item) => {
        if (item.separator) {
          return <div key={item.id} className="context-menu-sep" role="separator" />;
        }

        const hasChildren = (item.children?.length ?? 0) > 0;
        const showDisabledHint =
          item.disabled && item.disabledReason && item.disabledReasonIcon !== false;
        return (
          <div
            key={item.id}
            ref={(el) => {
              if (el) rowRefs.current.set(item.id, el);
              else rowRefs.current.delete(item.id);
            }}
            className={`context-menu-row${hasChildren ? " context-menu-row--submenu" : ""}${showDisabledHint ? " context-menu-row--with-hint" : ""}`}
            onMouseEnter={() => hasChildren && openSubmenu(item.id)}
            onMouseLeave={() => hasChildren && scheduleCloseSubmenu()}
          >
            <button
              type="button"
              className={`context-menu-item${item.danger ? " context-menu-item--danger" : ""}${hasChildren ? " context-menu-item--has-children" : ""}`}
              disabled={item.disabled}
              onClick={() => {
                if (hasChildren || item.disabled) return;
                runItemAction(item, onClose);
              }}
            >
              {item.icon ? <span className="context-menu-item__icon">{item.icon}</span> : null}
              <span className="context-menu-item__label">{item.label}</span>
              {item.shortcut ? (
                <span className="context-menu-item__shortcut">{item.shortcut}</span>
              ) : null}
              {hasChildren && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10" aria-hidden>
                  <path d="M9 18l6-6-6-6" />
                </svg>
              )}
            </button>
            {showDisabledHint ? (
              <ContextMenuDisabledHintSlot reason={item.disabledReason!} />
            ) : null}
            {hasChildren && openSubmenuId === item.id && (
              <ContextMenuSubmenuList
                items={item.children!}
                anchorRef={{ current: rowRefs.current.get(item.id) ?? null }}
                onClose={onClose}
                onMouseEnter={cancelCloseSubmenu}
                onMouseLeave={scheduleCloseSubmenu}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ContextMenu({ items, position, onClose, className }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState(position);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setCoords(clampMenuPosition(position, { width, height }));
    setReady(true);
  }, [position.x, position.y, items]);

  useEffect(() => {
    const handler = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") onClose();
        return;
      }
      if (isContextMenuNode(e.target)) return;
      onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", handler);
    };
  }, [onClose]);

  return createPortal(
    <>
      <div
        className="context-menu-backdrop"
        aria-hidden
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        className={`context-menu${className ? ` ${className}` : ""}`}
        style={{
          left: coords.x,
          top: coords.y,
          visibility: ready ? "visible" : "hidden",
        }}
        role="menu"
      >
        <ContextMenuPanel items={items} onClose={onClose} />
      </div>
    </>,
    document.body,
  );
}
