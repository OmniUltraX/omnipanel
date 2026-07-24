import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { TagTreePanel } from "./TagTreePanel";
import { EMPTY_TAG_IDS, useTagStore, useTagUiStore } from "./tagStore";
import { MODULE_TAG_FILTER_SCOPE } from "./moduleTagScope";
import type { TagDto } from "../../ipc/bindings";

/** 估算：mode / chip / +N / gap，用于按宽度算能放几个 chip */
const MODE_W = 34;
const CHIP_W = 52;
const COUNT_W = 28;
const GAP = 4;
const POPOVER_W = 280;
const POPOVER_H = 360;
const EMPTY_TAGS: TagDto[] = [];

interface ModuleTagHeaderProps {
  moduleKey: string;
}

function TagEntryIcon() {
  return (
    <svg
      className="module-tag-header__entry-icon"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function chipsThatFit(width: number, total: number): number {
  if (total <= 0 || width < MODE_W) return 0;
  let available = width - MODE_W - GAP;
  let n = 0;
  while (n < total) {
    const remainingAfter = total - n - 1;
    const need = CHIP_W + (remainingAfter > 0 ? GAP + COUNT_W : 0);
    if (available < need) break;
    available -= CHIP_W + GAP;
    n += 1;
  }
  return n;
}

/**
 * 侧栏标题行：入口紧贴标题，chips 按可用宽度自适应。
 * 弹窗用 portal，避免被标题行 overflow 裁切。
 */
export function ModuleTagHeader({ moduleKey }: ModuleTagHeaderProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const entryRef = useRef<HTMLButtonElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(0);
  const [showClear, setShowClear] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);

  const selectedIds = useTagUiStore(
    (s) => s.selectedByModule[moduleKey] ?? EMPTY_TAG_IDS,
  );
  const matchMode = useTagUiStore((s) => s.matchModes[moduleKey] ?? "and");
  const setMatchMode = useTagUiStore((s) => s.setMatchMode);
  const toggleSelected = useTagUiStore((s) => s.toggleSelected);
  const setSelected = useTagUiStore((s) => s.setSelected);
  // 仅本模块被 focus 时 selector 才变化，避免所有模块标题一起重渲
  const focusNonce = useTagUiStore((s) =>
    s.focusModuleKey === moduleKey ? s.focusNonce : 0,
  );
  const needsTagNames = selectedIds.length > 0;
  const tags = useTagStore((s) => (needsTagNames ? s.tags : EMPTY_TAGS));
  const refreshTags = useTagStore((s) => s.refresh);
  const tagsLoaded = useTagStore((s) => s.loaded);

  useEffect(() => {
    if (!tagsLoaded) void refreshTags();
  }, [tagsLoaded, refreshTags]);

  useEffect(() => {
    if (focusNonce === 0) return;
    setOpen(true);
  }, [focusNonce]);

  const updatePopoverPos = useCallback(() => {
    const entry = entryRef.current;
    if (!entry) return;
    const rect = entry.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, rect.left),
      window.innerWidth - POPOVER_W - 8,
    );
    const below = rect.bottom + 4;
    const top =
      below + POPOVER_H > window.innerHeight - 8
        ? Math.max(8, rect.top - POPOVER_H - 4)
        : below;
    setPopoverPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPopoverPos(null);
      return;
    }
    updatePopoverPos();
    window.addEventListener("resize", updatePopoverPos);
    return () => window.removeEventListener("resize", updatePopoverPos);
  }, [open, updatePopoverPos]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // 延后绑定，避免打开时同一 click 立刻关掉
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", onDoc);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selectedTags = useMemo(() => {
    if (selectedIds.length === 0) return [];
    const map = new Map(tags.map((tag) => [tag.id, tag]));
    return selectedIds
      .map((id) => map.get(id))
      .filter((tag): tag is NonNullable<typeof tag> => Boolean(tag));
  }, [tags, selectedIds]);

  const total = selectedTags.length;

  // 单次 ResizeObserver，只在数值变化时 setState，避免布局抖动与多余渲染。
  // total===0（无选中标签，常态）时不创建 ResizeObserver：窗口最大化/还原时所有模块
  // 侧栏 root 尺寸变化会同时触发所有实例的 RO 回调，各自读 clientWidth 强制 layout flush，
  // 形成 ResizeObserver 雪崩。无标签时 visibleCount 恒为 0，无需测量。
  useLayoutEffect(() => {
    const root = rootRef.current;
    const chips = chipsRef.current;
    if (!root) return;

    if (total === 0 || !chips) {
      setShowClear(false);
      setVisibleCount(0);
      return;
    }

    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const nextShowClear = root.clientWidth >= 72;
        setShowClear((prev) => (prev === nextShowClear ? prev : nextShowClear));
        const nextVisible = chipsThatFit(chips.clientWidth, total);
        setVisibleCount((prev) => (prev === nextVisible ? prev : nextVisible));
      });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    if (chips) ro.observe(chips);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [total]);

  const visible = selectedTags.slice(0, visibleCount);
  const hiddenCount = total - visibleCount;

  const popover =
    open && popoverPos
      ? createPortal(
          <div
            ref={popoverRef}
            className="module-tag-header__popover"
            role="dialog"
            aria-label={t("tags.panelTitle")}
            style={{ top: popoverPos.top, left: popoverPos.left }}
          >
            <TagTreePanel
              selectedIds={selectedIds}
              onToggle={(id) => toggleSelected(moduleKey, id)}
              matchMode={matchMode}
              onMatchModeChange={(mode) => setMatchMode(moduleKey, mode)}
              filterScope={MODULE_TAG_FILTER_SCOPE[moduleKey] ?? null}
            />
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="module-tag-header" ref={rootRef}>
      <button
        ref={entryRef}
        type="button"
        className={`module-tag-header__entry${open || selectedIds.length > 0 ? " is-active" : ""}`}
        title={t("tags.shellEntry")}
        aria-label={t("tags.shellEntry")}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <TagEntryIcon />
        {selectedIds.length > 0 ? (
          <span className="module-tag-header__entry-badge">{selectedIds.length}</span>
        ) : null}
      </button>

      {total > 0 ? (
        <>
          <div className="module-tag-header__chips" ref={chipsRef}>
            <button
              type="button"
              className="module-tag-header__mode"
              title={t("tags.matchMode")}
              onClick={() =>
                setMatchMode(moduleKey, matchMode === "and" ? "or" : "and")
              }
            >
              {matchMode.toUpperCase()}
            </button>
            {visible.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className="module-tag-header__chip"
                title={tag.path}
                onClick={() => toggleSelected(moduleKey, tag.id)}
              >
                #{tag.name}
                <span className="module-tag-header__chip-x">×</span>
              </button>
            ))}
            {hiddenCount > 0 ? (
              <button
                type="button"
                className="module-tag-header__count"
                onClick={() => setOpen(true)}
                title={selectedTags.map((tag) => tag.path).join(", ")}
              >
                +{hiddenCount}
              </button>
            ) : null}
          </div>
          {showClear ? (
            <button
              type="button"
              className="module-tag-header__clear"
              title={t("tags.clearSelection")}
              onClick={() => setSelected(moduleKey, EMPTY_TAG_IDS)}
            >
              {t("tags.clearSelection")}
            </button>
          ) : null}
        </>
      ) : (
        <div className="module-tag-header__chips" aria-hidden />
      )}

      {popover}
    </div>
  );
}
