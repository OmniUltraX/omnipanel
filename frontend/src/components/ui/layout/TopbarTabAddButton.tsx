import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TopbarAddMenuItem } from "../../../stores/topbarStore";
import { useI18n } from "../../../i18n";
import { subscribeTopbarAddMenuOpen } from "../../../lib/topbarAddMenu";

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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const addMenuListRef = useRef<HTMLDivElement>(null);
  const addMenuButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const hasAddMenuRef = useRef(hasAddMenu);
  hasAddMenuRef.current = hasAddMenu;
  const addMenuOpenRef = useRef(addMenuOpen);
  addMenuOpenRef.current = addMenuOpen;

  const openMenu = () => {
    if (!hasAddMenuRef.current) return false;
    const rect = addMenuButtonRef.current?.getBoundingClientRect();
    if (rect) {
      setAddMenuPosition({
        top: rect.bottom + 6,
        left: rect.left,
        minWidth: Math.max(rect.width * 6, 240),
      });
    }
    setAddMenuOpen(true);
    return true;
  };

  // 快捷键（如 Mod+T）请求打开本菜单
  useEffect(() => {
    return subscribeTopbarAddMenuOpen(() => {
      if (!hasAddMenuRef.current) return false;
      const btn = addMenuButtonRef.current;
      if (!btn?.isConnected) return false;
      const rect = btn.getBoundingClientRect();
      // 不可见（隐藏分组 / 未布局）时不接管
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (addMenuOpenRef.current) {
        searchInputRef.current?.focus();
        return true;
      }
      return openMenu();
    });
  }, []);

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

  // 打开时聚焦搜索框（或菜单本体，便于键盘导航）
  useEffect(() => {
    if (!addMenuOpen) return;
    const id = requestAnimationFrame(() => {
      if (showSearch) {
        searchInputRef.current?.focus();
      } else {
        addMenuRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [addMenuOpen, showSearch]);

  // 关闭菜单时清空搜索与选中
  useEffect(() => {
    if (!addMenuOpen) {
      setSearchQuery("");
      setSelectedIndex(0);
    }
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

  // 过滤结果变化时钳制选中下标
  useEffect(() => {
    setSelectedIndex((i) => {
      if (renderedItems.length === 0) return 0;
      return Math.min(i, renderedItems.length - 1);
    });
  }, [renderedItems.length, searchQuery]);

  // 选中项滚入可视区
  useEffect(() => {
    if (!addMenuOpen) return;
    const list = addMenuListRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-menu-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [addMenuOpen, selectedIndex]);

  const selectItem = (id: string) => {
    onMenuSelect?.(id);
    setAddMenuOpen(false);
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (searchQuery) {
        setSearchQuery("");
      } else {
        setAddMenuOpen(false);
        addMenuButtonRef.current?.focus();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      if (renderedItems.length === 0) return;
      setSelectedIndex((i) => Math.min(i + 1, renderedItems.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (renderedItems.length === 0) return;
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const item = renderedItems[selectedIndex];
      if (item) selectItem(item.id);
    }
  };

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
              if (addMenuOpen) {
                setAddMenuOpen(false);
              } else {
                openMenu();
              }
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
              tabIndex={-1}
              role="listbox"
              aria-activedescendant={
                renderedItems[selectedIndex]
                  ? `topbar-add-menu-option-${renderedItems[selectedIndex]!.id}`
                  : undefined
              }
              style={{
                position: "fixed",
                top: addMenuPosition.top,
                left: addMenuPosition.left,
                minWidth: addMenuPosition.minWidth,
                zIndex: "var(--z-subwindow-popover)",
              }}
              onKeyDown={onMenuKeyDown}
              // 阻止 mousedown 冒泡到 document，否则会触发菜单关闭
              onMouseDown={(e) => e.stopPropagation()}
            >
              {showSearch && (
                <div className="topbar-add-menu-search">
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
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setSelectedIndex(0);
                    }}
                    onKeyDown={onMenuKeyDown}
                  />
                </div>
              )}
              <div className="topbar-add-menu-list" ref={addMenuListRef}>
                {renderedItems.length === 0 ? (
                  <div className="topbar-add-menu-empty">
                    {t("terminal.newSession.noMatch")}
                  </div>
                ) : (
                  renderedItems.map((item, index) => (
                    <div key={item.id}>
                      {item.dividerBefore && <div className="topbar-add-menu-divider" />}
                      <button
                        type="button"
                        id={`topbar-add-menu-option-${item.id}`}
                        role="option"
                        aria-selected={index === selectedIndex}
                        data-menu-index={index}
                        className={`topbar-add-menu-item${index === selectedIndex ? " is-active" : ""}`}
                        onMouseEnter={() => setSelectedIndex(index)}
                        onClick={() => selectItem(item.id)}
                      >
                        <span className="topbar-add-menu-label">{item.label}</span>
                        {item.subtitle && (
                          <span className="topbar-add-menu-sub">{item.subtitle}</span>
                        )}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>,
            document.body,
          )}
      </div>
    </>
  );
}
