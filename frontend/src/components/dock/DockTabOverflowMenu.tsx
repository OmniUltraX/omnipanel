import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { clampMenuPosition } from "../../lib/contextMenuPosition";
import { DockHeaderIcon } from "./DockHeaderIcon";
import {
  buildDockTabOverflowSections,
  splitMatch,
  type DockTabOverflowTab,
} from "./dockTabOverflowModel";

export interface DockTabOverflowAnchorBox {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

interface DockTabOverflowMenuProps {
  anchor: DockTabOverflowAnchorBox;
  tabs: DockTabOverflowTab[];
  activeTabId: string;
  mru: readonly string[];
  resolveGroupLabel: (panelType: string) => string;
  onActivate: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onDismiss: () => void;
}

const MENU_WIDTH = 300;
const VIEWPORT_GAP = 8;

function tabStatusClass(status?: string) {
  if (status === "connected" || status === "online") return "online";
  if (status === "connecting") return "connecting";
  if (status === "offline") return "offline";
  return "idle";
}

function placeMenu(anchor: DockTabOverflowAnchorBox, height: number) {
  const gap = 4;
  let top = anchor.bottom + gap;
  let origin = "top right";
  if (
    top + height > window.innerHeight - VIEWPORT_GAP &&
    anchor.top - height - gap > VIEWPORT_GAP
  ) {
    top = anchor.top - height - gap;
    origin = "bottom right";
  }
  const point = clampMenuPosition(
    { x: anchor.right - MENU_WIDTH, y: top },
    { width: MENU_WIDTH, height },
  );
  return { left: point.x, top: point.y, origin };
}

export function DockTabOverflowMenu({
  anchor,
  tabs,
  activeTabId,
  mru,
  resolveGroupLabel,
  onActivate,
  onCloseTab,
  onDismiss,
}: DockTabOverflowMenuProps) {
  const { t } = useI18n();
  const listId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [position, setPosition] = useState(() => placeMenu(anchor, 280));

  const sections = useMemo(
    () => buildDockTabOverflowSections(tabs, query, mru, resolveGroupLabel),
    [tabs, query, mru, resolveGroupLabel],
  );
  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const safeIndex = flat.length === 0 ? -1 : Math.min(highlight, flat.length - 1);

  const requestClose = () => {
    if (leaving) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onDismiss();
      return;
    }
    setLeaving(true);
  };

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(onDismiss, 80);
    return () => window.clearTimeout(timer);
  }, [leaving, onDismiss]);

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const height = menuRef.current?.offsetHeight ?? 280;
    setPosition(placeMenu(anchor, height));
  }, [anchor, sections, query]);

  useEffect(() => {
    const row = menuRef.current?.querySelector<HTMLElement>('[data-highlight="1"]');
    const list = menuRef.current?.querySelector<HTMLElement>(".dock-tab-overflow__list");
    if (!row || !list) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < listRect.top) {
      list.scrollTop -= listRect.top - rowRect.top;
    } else if (rowRect.bottom > listRect.bottom) {
      list.scrollTop += rowRect.bottom - listRect.bottom;
    }
  }, [safeIndex, query]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".dv-tabs-overflow-dropdown-root")) return;
      requestClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  });

  const moveHighlight = (delta: number) => {
    if (flat.length === 0) return;
    setHighlight((current) => {
      const base = Math.min(current, flat.length - 1);
      return (base + delta + flat.length) % flat.length;
    });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
    } else if (event.key === "Enter" && safeIndex >= 0) {
      event.preventDefault();
      const item = flat[safeIndex];
      if (item) onActivate(item.id);
    }
  };

  let cursor = 0;
  const bucketLabel = (bucket: "overflow" | "visible") =>
    bucket === "overflow"
      ? t("shell.tabOverflow.overflowBucket")
      : t("shell.tabOverflow.visibleBucket");

  return createPortal(
    <div
      ref={menuRef}
      className={`dock-tab-overflow${leaving ? " is-leaving" : ""}`}
      style={{
        left: position.left,
        top: position.top,
        ["--dock-tab-overflow-origin" as string]: position.origin,
      }}
      role="dialog"
      aria-label={t("shell.tabOverflow.label")}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="dock-tab-overflow__search-wrap">
        <input
          ref={inputRef}
          className="dock-tab-overflow__search"
          value={query}
          placeholder={t("shell.tabOverflow.searchPlaceholder")}
          aria-label={t("shell.tabOverflow.searchPlaceholder")}
          aria-controls={listId}
          aria-activedescendant={safeIndex >= 0 ? `${listId}-${safeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(0);
          }}
        />
        {query ? (
          <button
            type="button"
            className="dock-tab-overflow__clear"
            onClick={() => {
              setQuery("");
              setHighlight(0);
              inputRef.current?.focus();
            }}
          >
            {t("common.clear")}
          </button>
        ) : null}
      </div>
      {flat.length === 0 ? (
        <div className="dock-tab-overflow__empty">{t("shell.tabOverflow.empty")}</div>
      ) : (
        <div id={listId} className="dock-tab-overflow__list" role="listbox">
          {sections.map((section) => (
            <div key={section.key}>
              {section.bucket ? (
                <div className="dock-tab-overflow__bucket">
                  <span>{bucketLabel(section.bucket)}</span>
                  <span className="dock-tab-overflow__count">{section.bucketCount}</span>
                </div>
              ) : null}
              {section.groupLabel ? (
                <div className="dock-tab-overflow__group">
                  <span>{section.groupLabel}</span>
                  <span className="dock-tab-overflow__count">{section.items.length}</span>
                </div>
              ) : null}
              {section.items.map((item) => {
                const index = cursor;
                cursor += 1;
                const optionId = `${listId}-${index}`;
                const highlighted = index === safeIndex;
                return (
                  <div
                    key={item.id}
                    id={optionId}
                    role="option"
                    aria-selected={highlighted}
                    data-highlight={highlighted ? "1" : undefined}
                    className={[
                      "dock-tab-overflow__row",
                      highlighted ? "is-highlight" : "",
                      item.id === activeTabId ? "is-current" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    title={item.tooltip || item.label}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => onActivate(item.id)}
                    onPointerDown={(event) => {
                      if (event.button === 1) event.preventDefault();
                    }}
                    onAuxClick={(event: ReactMouseEvent) => {
                      if (event.button !== 1 || !item.closable) return;
                      event.preventDefault();
                      onCloseTab(item.id);
                    }}
                  >
                    {item.icon ? (
                      <DockHeaderIcon kind={item.icon} />
                    ) : (
                      <span className="dock-tab-overflow__icon-spacer" aria-hidden />
                    )}
                    {item.status ? (
                      <span className={`topbar-tab-dot ${tabStatusClass(item.status)}`} />
                    ) : null}
                    <span
                      className={`dock-tab-overflow__label${item.preview ? " is-preview" : ""}`}
                    >
                      {splitMatch(item.label, query).map((part, partIndex) =>
                        part.match ? (
                          <mark key={partIndex} className="dock-tab-overflow__mark">
                            {part.text}
                          </mark>
                        ) : (
                          <span key={partIndex}>{part.text}</span>
                        ),
                      )}
                    </span>
                    {item.dirty ? <span className="dock-tab-dirty" aria-label="未保存" /> : null}
                    {!item.dirty && item.saved ? (
                      <span className="dock-tab-saved" aria-label="已保存" />
                    ) : null}
                    {item.closable ? (
                      <button
                        type="button"
                        className="dock-tab-overflow__close"
                        aria-label={t("shell.tabOverflow.closeTab")}
                        onClick={(event) => {
                          event.stopPropagation();
                          onCloseTab(item.id);
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
                          <path stroke="currentColor" strokeWidth="1.5" d="M4 4l8 8M12 4L4 12" />
                        </svg>
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <div className="dock-tab-overflow__hint">{t("shell.tabOverflow.hint")}</div>
    </div>,
    document.body,
  );
}
