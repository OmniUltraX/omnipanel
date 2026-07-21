import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { ChevronRightIcon } from "lucide-react";

import {
  clampMenuPosition,
  computeSubmenuPosition,
} from "../../../lib/contextMenuPosition";
import { useI18n } from "../../../i18n";
import type { ComposerContextItem } from "../../../stores/aiComposerContextStore";
import { useAiComposerContextStore } from "../../../stores/aiComposerContextStore";
import {
  filterComposerContextOptions,
  useComposerContextCatalog,
  type ComposerContextCategoryId,
  type ComposerContextOption,
} from "./composerContextCatalog";

const SUBMENU_CLOSE_MS = 180;
const MENU_MAX_HEIGHT = 280;

type CategoryDef = {
  id: ComposerContextCategoryId;
  label: string;
  children?: ComposerContextOption[];
  onSelect?: () => void;
};

type FlatNavItem =
  | { type: "attachment" }
  | { type: "option"; option: ComposerContextOption };

export type ComposerContextMenuProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 锚定元素（加号按钮）；与 anchorRect 二选一 */
  anchorRef?: RefObject<HTMLElement | null>;
  /** 固定锚点（@ 触发时用输入框底部） */
  anchorRect?: DOMRect | null;
  /** @ 过滤词；有值时优先展示扁平搜索结果 */
  filterQuery?: string;
  onPickAttachment: () => void;
  /** 选中上下文项后的回调（默认写入 store） */
  onPickItem?: (item: ComposerContextItem) => void;
};

function OptionButton({
  option,
  active,
  onPick,
}: {
  option: ComposerContextOption;
  active?: boolean;
  onPick: (option: ComposerContextOption) => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`composer-context-menu__item${active ? " is-active" : ""}`}
      disabled={option.disabled}
      aria-selected={active}
      onClick={() => {
        if (option.disabled) return;
        onPick(option);
      }}
    >
      <span className="composer-context-menu__item-title">{option.label}</span>
      {option.subtitle ? (
        <span className="composer-context-menu__item-desc">{option.subtitle}</span>
      ) : null}
    </button>
  );
}

function SubmenuPanel({
  anchorRef,
  options,
  emptyLabel,
  activeIndex,
  onPick,
  onMouseEnter,
  onMouseLeave,
  onHoverIndex,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  options: ComposerContextOption[];
  emptyLabel: string;
  activeIndex: number;
  onPick: (option: ComposerContextOption) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onHoverIndex: (index: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const el = ref.current;
    if (!anchor || !el) return;
    const size = el.getBoundingClientRect();
    setCoords(computeSubmenuPosition(anchor.getBoundingClientRect(), size));
  }, [anchorRef, options]);

  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(
      `[data-menu-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="composer-context-menu composer-context-menu--submenu"
      style={{
        position: "fixed",
        left: coords?.x ?? 0,
        top: coords?.y ?? 0,
        visibility: coords ? "visible" : "hidden",
        zIndex: "var(--z-popover, 1200)",
        maxHeight: MENU_MAX_HEIGHT,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="composer-context-menu__scroll">
        {options.length === 0 ? (
          <div className="composer-context-menu__empty">{emptyLabel}</div>
        ) : (
          options.map((option, index) => (
            <div
              key={`${option.kind}:${option.id}`}
              data-menu-index={index}
              onMouseEnter={() => onHoverIndex(index)}
            >
              <OptionButton
                option={option}
                active={index === activeIndex}
                onPick={onPick}
              />
            </div>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}

function stepIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (current + delta + length * 100) % length;
}

/**
 * Composer 上下文选择菜单：一级分类 + 二级列表（限高滚动）。
 * 也用于 @ 触发：有 filterQuery 时改为扁平搜索结果。
 * 支持 ↑↓←→ / Enter 键盘选中。
 */
export const ComposerContextMenu: FC<ComposerContextMenuProps> = ({
  open,
  onOpenChange,
  anchorRef,
  anchorRect,
  filterQuery,
  onPickAttachment,
  onPickItem,
}) => {
  const { t } = useI18n();
  const addItem = useAiComposerContextStore((s) => s.addItem);
  const catalog = useComposerContextCatalog();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
    minWidth: number;
  } | null>(null);
  const [openSubmenuId, setOpenSubmenuId] = useState<ComposerContextCategoryId | null>(
    null,
  );
  const [activeRootIndex, setActiveRootIndex] = useState(0);
  const [activeSubIndex, setActiveSubIndex] = useState(0);
  const closeTimerRef = useRef<number | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const pickOption = (option: ComposerContextOption) => {
    const item: ComposerContextItem = {
      kind: option.kind,
      id: option.id,
      label: option.label,
    };
    if (onPickItem) onPickItem(item);
    else addItem(item);
    onOpenChange(false);
  };

  const categories = useMemo((): CategoryDef[] => {
    return [
      {
        id: "attachment",
        label: t("ai.composerContext.attachment"),
        onSelect: () => {
          onPickAttachment();
          onOpenChange(false);
        },
      },
      {
        id: "terminal",
        label: t("ai.composerContext.groupTerminal"),
        children: catalog.terminal,
      },
      {
        id: "ssh",
        label: t("ai.composerContext.groupSsh"),
        children: catalog.ssh,
      },
      {
        id: "database",
        label: t("ai.composerContext.groupDatabase"),
        children: catalog.database,
      },
      {
        id: "docker",
        label: t("ai.composerContext.groupDocker"),
        children: catalog.docker,
      },
    ];
  }, [catalog, onOpenChange, onPickAttachment, t]);

  const flatFiltered = useMemo(() => {
    if (filterQuery == null) return null;
    return filterComposerContextOptions(catalog, filterQuery);
  }, [catalog, filterQuery]);

  const showFlatSearch = flatFiltered != null && (filterQuery?.length ?? 0) > 0;

  const flatNavItems = useMemo((): FlatNavItem[] => {
    if (!showFlatSearch || !flatFiltered) return [];
    return [
      { type: "attachment" },
      ...flatFiltered.map((option) => ({ type: "option" as const, option })),
    ];
  }, [showFlatSearch, flatFiltered]);

  const openSubmenuCategory = openSubmenuId
    ? categories.find((c) => c.id === openSubmenuId)
    : null;
  const submenuOptions = openSubmenuCategory?.children ?? [];

  const cancelCloseSubmenu = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleCloseSubmenu = () => {
    cancelCloseSubmenu();
    closeTimerRef.current = window.setTimeout(() => setOpenSubmenuId(null), SUBMENU_CLOSE_MS);
  };

  const openSubmenuAt = (catId: ComposerContextCategoryId) => {
    cancelCloseSubmenu();
    setOpenSubmenuId(catId);
    const children = categories.find((c) => c.id === catId)?.children ?? [];
    const firstEnabled = children.findIndex((c) => !c.disabled);
    setActiveSubIndex(firstEnabled >= 0 ? firstEnabled : 0);
  };

  useEffect(() => () => cancelCloseSubmenu(), []);

  useEffect(() => {
    if (!open) {
      setOpenSubmenuId(null);
      setMenuPosition(null);
      setActiveRootIndex(0);
      setActiveSubIndex(0);
    }
  }, [open]);

  // 过滤词变化时重置高亮
  useEffect(() => {
    setActiveRootIndex(0);
    setOpenSubmenuId(null);
    setActiveSubIndex(0);
  }, [filterQuery, showFlatSearch]);

  useLayoutEffect(() => {
    if (!open) return;

    const resolveRect = () =>
      anchorRect ?? anchorRef?.current?.getBoundingClientRect() ?? null;

    const sync = () => {
      const rect = resolveRect();
      if (!rect) return;
      const menuEl = rootRef.current;
      const measuredWidth = menuEl?.getBoundingClientRect().width ?? 220;
      const measuredHeight = Math.min(
        menuEl?.getBoundingClientRect().height ?? 200,
        MENU_MAX_HEIGHT,
      );
      const preferAbove = {
        x: rect.left,
        y: rect.top - measuredHeight - 6,
      };
      const anchor =
        preferAbove.y >= 8
          ? preferAbove
          : { x: rect.left, y: rect.bottom + 4 };
      const clamped = clampMenuPosition(anchor, {
        width: measuredWidth,
        height: measuredHeight,
      });
      setMenuPosition({
        top: clamped.y,
        left: clamped.x,
        minWidth: Math.max(measuredWidth, 200),
      });
    };

    const rect = resolveRect();
    if (rect) {
      setMenuPosition({
        top: Math.max(8, rect.top - 200),
        left: rect.left,
        minWidth: 200,
      });
    }

    const raf = window.requestAnimationFrame(sync);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [open, anchorRef, anchorRect, flatFiltered, categories]);

  useLayoutEffect(() => {
    if (!open || openSubmenuId) return;
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-root-index="${activeRootIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [open, activeRootIndex, openSubmenuId, showFlatSearch]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node;
      if (
        rootRef.current?.contains(target) ||
        anchorRef?.current?.contains(target) ||
        (target as Element).closest?.(".composer-context-menu--submenu")
      ) {
        return;
      }
      onOpenChange(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (openSubmenuId) {
          setOpenSubmenuId(null);
          return;
        }
        onOpenChange(false);
        return;
      }

      const navKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"];
      if (!navKeys.includes(event.key)) return;

      event.preventDefault();
      event.stopPropagation();

      // 扁平搜索模式
      if (showFlatSearch) {
        const len = flatNavItems.length;
        if (len === 0) return;
        if (event.key === "ArrowDown") {
          setActiveRootIndex((i) => stepIndex(i, 1, len));
          return;
        }
        if (event.key === "ArrowUp") {
          setActiveRootIndex((i) => stepIndex(i, -1, len));
          return;
        }
        if (event.key === "Enter") {
          const item = flatNavItems[activeRootIndex];
          if (!item) return;
          if (item.type === "attachment") {
            onPickAttachment();
            onOpenChange(false);
            return;
          }
          if (!item.option.disabled) pickOption(item.option);
        }
        return;
      }

      // 二级菜单已打开
      if (openSubmenuId) {
        const len = submenuOptions.length;
        if (event.key === "ArrowLeft" || (event.key === "Escape" as string)) {
          setOpenSubmenuId(null);
          return;
        }
        if (event.key === "ArrowDown" && len > 0) {
          setActiveSubIndex((i) => {
            let next = i;
            for (let n = 0; n < len; n += 1) {
              next = stepIndex(next, 1, len);
              if (!submenuOptions[next]?.disabled) return next;
            }
            return i;
          });
          return;
        }
        if (event.key === "ArrowUp" && len > 0) {
          setActiveSubIndex((i) => {
            let next = i;
            for (let n = 0; n < len; n += 1) {
              next = stepIndex(next, -1, len);
              if (!submenuOptions[next]?.disabled) return next;
            }
            return i;
          });
          return;
        }
        if (event.key === "Enter") {
          const option = submenuOptions[activeSubIndex];
          if (option && !option.disabled) pickOption(option);
        }
        return;
      }

      // 一级分类
      const len = categories.length;
      if (event.key === "ArrowDown") {
        setActiveRootIndex((i) => stepIndex(i, 1, len));
        return;
      }
      if (event.key === "ArrowUp") {
        setActiveRootIndex((i) => stepIndex(i, -1, len));
        return;
      }
      if (event.key === "ArrowRight") {
        const cat = categories[activeRootIndex];
        if (cat && cat.id !== "attachment") {
          openSubmenuAt(cat.id);
        }
        return;
      }
      if (event.key === "Enter") {
        const cat = categories[activeRootIndex];
        if (!cat) return;
        if (cat.id === "attachment") {
          cat.onSelect?.();
          return;
        }
        openSubmenuAt(cat.id);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [
    open,
    onOpenChange,
    anchorRef,
    showFlatSearch,
    flatNavItems,
    activeRootIndex,
    openSubmenuId,
    submenuOptions,
    activeSubIndex,
    categories,
    onPickAttachment,
  ]);

  if (!open) return null;

  const pos = menuPosition ?? { top: -9999, left: -9999, minWidth: 200 };

  const menu: ReactNode = (
    <div
      id={menuId}
      ref={rootRef}
      role="menu"
      className="composer-context-menu"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        minWidth: pos.minWidth,
        maxHeight: MENU_MAX_HEIGHT,
        zIndex: "var(--z-popover, 1200)",
      }}
    >
      <div className="composer-context-menu__scroll">
        {showFlatSearch ? (
          flatNavItems.length === 0 ? (
            <div className="composer-context-menu__empty">
              {t("ai.composerContext.emptySearch")}
            </div>
          ) : (
            flatNavItems.map((item, index) => {
              if (item.type === "attachment") {
                return (
                  <button
                    key="attachment"
                    type="button"
                    role="menuitem"
                    data-root-index={index}
                    className={`composer-context-menu__item${
                      index === activeRootIndex ? " is-active" : ""
                    }`}
                    aria-selected={index === activeRootIndex}
                    onMouseEnter={() => setActiveRootIndex(index)}
                    onClick={() => {
                      onPickAttachment();
                      onOpenChange(false);
                    }}
                  >
                    <span className="composer-context-menu__item-title">
                      {t("ai.composerContext.attachment")}
                    </span>
                  </button>
                );
              }
              return (
                <div
                  key={`${item.option.kind}:${item.option.id}`}
                  data-root-index={index}
                  onMouseEnter={() => setActiveRootIndex(index)}
                >
                  <OptionButton
                    option={item.option}
                    active={index === activeRootIndex}
                    onPick={pickOption}
                  />
                </div>
              );
            })
          )
        ) : (
          categories.map((cat, index) => {
            if (cat.id === "attachment") {
              return (
                <button
                  key={cat.id}
                  type="button"
                  role="menuitem"
                  data-root-index={index}
                  className={`composer-context-menu__item${
                    index === activeRootIndex ? " is-active" : ""
                  }`}
                  aria-selected={index === activeRootIndex}
                  onMouseEnter={() => {
                    setActiveRootIndex(index);
                    setOpenSubmenuId(null);
                  }}
                  onClick={cat.onSelect}
                >
                  <span className="composer-context-menu__item-title">{cat.label}</span>
                </button>
              );
            }
            return (
              <div
                key={cat.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(cat.id, el);
                  else rowRefs.current.delete(cat.id);
                }}
                data-root-index={index}
                className={`composer-context-menu__row${
                  openSubmenuId === cat.id ? " is-open" : ""
                }`}
                onMouseEnter={() => {
                  cancelCloseSubmenu();
                  setActiveRootIndex(index);
                  openSubmenuAt(cat.id);
                }}
                onMouseLeave={scheduleCloseSubmenu}
              >
                <button
                  type="button"
                  role="menuitem"
                  className={`composer-context-menu__item composer-context-menu__item--submenu${
                    index === activeRootIndex ? " is-active" : ""
                  }`}
                  aria-haspopup="menu"
                  aria-expanded={openSubmenuId === cat.id}
                  aria-selected={index === activeRootIndex}
                  onClick={() => {
                    cancelCloseSubmenu();
                    if (openSubmenuId === cat.id) setOpenSubmenuId(null);
                    else openSubmenuAt(cat.id);
                  }}
                >
                  <span className="composer-context-menu__item-title">{cat.label}</span>
                  <span className="composer-context-menu__item-meta">
                    {cat.children?.length ?? 0}
                    <ChevronRightIcon className="size-3.5 opacity-60" aria-hidden />
                  </span>
                </button>
                {openSubmenuId === cat.id ? (
                  <SubmenuPanel
                    anchorRef={{
                      current: rowRefs.current.get(cat.id) ?? null,
                    }}
                    options={cat.children ?? []}
                    emptyLabel={t("ai.composerContext.emptyGroup")}
                    activeIndex={activeSubIndex}
                    onPick={pickOption}
                    onMouseEnter={cancelCloseSubmenu}
                    onMouseLeave={scheduleCloseSubmenu}
                    onHoverIndex={setActiveSubIndex}
                  />
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  return createPortal(menu, document.body);
};
