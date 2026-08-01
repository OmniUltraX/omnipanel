import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TopbarAddMenuItem } from "../../../stores/topbarStore";
import { useI18n } from "../../../i18n";

export interface TopbarTabAddButtonProps {
  title?: string;
  menuItems?: TopbarAddMenuItem[];
  onAdd?: () => void;
  onMenuSelect?: (id: string) => void;
  className?: string;
}

/** 菜单项超过该数量时显示搜索过滤框 */
const SEARCH_THRESHOLD = 6;

export function TopbarTabAddButton({
  title,
  menuItems,
  onAdd,
  onMenuSelect,
  className,
}: TopbarTabAddButtonProps) {
  const { t } = useI18n();
  const hasAddMenu = (menuItems?.length ?? 0) > 0;
  const showSearch = (menuItems?.length ?? 0) > SEARCH_THRESHOLD;
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuPosition, setAddMenuPosition] = useState<{
    top: number;
    left: number;
    minWidth: number;
  } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const addMenuRef = useRef<HTMLDivElement>(null);
  const addMenuButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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
    // 菜单打开时聚焦搜索框（下一帧，确保 DOM 已渲染）
    if (showSearch) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
    window.addEventListener("resize", syncMenuPosition);
    window.addEventListener("scroll", syncMenuPosition, true);
    document.addEventListener("mousedown", onPointerDown);

    return () => {
      window.removeEventListener("resize", syncMenuPosition);
      window.removeEventListener("scroll", syncMenuPosition, true);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [addMenuOpen, showSearch]);

  // 关闭菜单时清空搜索
  useEffect(() => {
    if (!addMenuOpen) setSearchQuery("");
  }, [addMenuOpen]);

  const filteredItems = useMemo(() => {
    if (!menuItems || !showSearch) return menuItems ?? [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return menuItems;
    return menuItems.filter((item) => {
      const label = (item.label ?? "").toLowerCase();
      const sub = (item.subtitle ?? "").toLowerCase();
      return label.includes(q) || sub.includes(q);
    });
  }, [menuItems, searchQuery, showSearch]);

  // 清理过滤后的 dividerBefore：第一项不显示分隔符
  const renderedItems = useMemo(() => {
    if (filteredItems.length === 0) return [];
    return filteredItems.map((item, idx) =>
      idx === 0 && item.dividerBefore ? { ...item, dividerBefore: false } : item,
    );
  }, [filteredItems]);

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
              {showSearch && (
                <div
                  className="topbar-add-menu-search"
                  // 阻止 mousedown 冒泡到 document，否则会触发菜单关闭
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <svg
                    className="topbar-add-menu-search-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                  <input
                    ref={searchInputRef}
                    type="text"
                    className="topbar-add-menu-search-input"
                    placeholder={t("terminal.newSession.searchPlaceholder")}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        if (searchQuery) {
                          setSearchQuery("");
                        } else {
                          setAddMenuOpen(false);
                        }
                      }
                    }}
                  />
                </div>
              )}
              {renderedItems.length === 0 ? (
                <div className="topbar-add-menu-empty">
                  {t("terminal.newSession.noMatch")}
                </div>
              ) : (
                renderedItems.map((item) => (
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
                ))
              )}
            </div>,
            document.body,
          )}
      </div>
    </>
  );
}
