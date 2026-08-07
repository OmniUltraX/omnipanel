import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { cn } from "../../../lib/utils";

export interface VerticalSplitSidebarSectionConfig {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  /** 非受控自动高度：未传 bodyHeightPx 时，组件按内容自动测量高度并支持拖拽 */
  autoSize?: boolean;
  /** autoSize 模式下按 id 持久化高度到 localStorage */
  autoSizePersist?: { storageKey: string; id: string };
}

export interface VerticalSplitSidebarProps {
  children: ReactNode;
  className?: string;
}

/** 纵向均分、可折叠的多段侧栏容器（数据库 Schema、文件连接等模块复用） */
export function VerticalSplitSidebar({ children, className }: VerticalSplitSidebarProps) {
  return <div className={cn("vsplit-sidebar", className)}>{children}</div>;
}

export function VerticalSplitSidebarSection({
  title,
  expanded,
  onToggle,
  actions,
  children,
  keepMounted = false,
  bodyHeightPx,
  onBodyHeightChange,
  minBodyHeightPx = 72,
  maxBodyHeightPx = 480,
  autoSize = false,
  autoSizePersist,
}: VerticalSplitSidebarSectionConfig & {
  actions?: ReactNode;
  children: ReactNode;
  /** 折叠时仍挂载子树（用于向标题栏上报操作按钮） */
  keepMounted?: boolean;
  /** 指定 body 高度（px）；传入后本段不再参与 flex 均分，由连接等 flex 段吃剩余空间 */
  bodyHeightPx?: number;
  /** 提供后在段顶显示拖拽手柄，可调整 bodyHeightPx */
  onBodyHeightChange?: (heightPx: number) => void;
  minBodyHeightPx?: number;
  maxBodyHeightPx?: number;
}) {
  const showBody = expanded || keepMounted;
  const controlled = typeof bodyHeightPx === "number" && Number.isFinite(bodyHeightPx);
  const autoActive = !controlled && autoSize;

  // autoSize 非受控模式：内部维护高度，用户拖过后停止自动跟随
  const [autoHeight, setAutoHeight] = useState<number | undefined>(() => {
    if (!autoActive || !autoSizePersist) return undefined;
    return readPersistedSizeValue(autoSizePersist.storageKey, autoSizePersist.id);
  });
  const [userSized, setUserSized] = useState(
    () => autoActive && Number.isFinite(autoHeight),
  );
  const userSizedRef = useRef(userSized);
  userSizedRef.current = userSized;
  /** 侧栏拖宽时内容换行会触发 ResizeObserver；有稳定高度后忽略纯宽度变化 */
  const measuredBoxRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const autoHeightRef = useRef(autoHeight);
  autoHeightRef.current = autoHeight;

  const measureRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);

  const clampHeight = useCallback(
    (value: number) => Math.max(minBodyHeightPx, Math.min(maxBodyHeightPx, Math.round(value))),
    [maxBodyHeightPx, minBodyHeightPx],
  );

  // 自动测量内容高度（未手动拖拽时跟随内容；侧栏宽度变化不改已有高度）
  // userSized 进入依赖：拖高后 effect 清理并拆除 ResizeObserver，
  // 避免侧栏横向改宽触发内容重排时把高度测回去。
  useLayoutEffect(() => {
    if (!autoActive || !expanded || userSized) return;
    const el = measureRef.current;
    if (!el) return;
    const measure = () => {
      if (userSizedRef.current) return;
      const rect = el.getBoundingClientRect();
      const w = rect.width;
      const h = el.scrollHeight || rect.height;
      if (!Number.isFinite(h) || h <= 0) return;
      const prev = measuredBoxRef.current;
      const hasStableHeight =
        (autoHeightRef.current != null && Number.isFinite(autoHeightRef.current)) || prev.h > 0;
      // 宽度变了且已有高度：视为侧栏拖宽引起的重排，保持当前折叠面板高度
      if (hasStableHeight && prev.w > 0 && Math.abs(w - prev.w) > 0.5) {
        measuredBoxRef.current = { w, h: prev.h > 0 ? prev.h : clampHeight(h) };
        return;
      }
      const next = clampHeight(h);
      measuredBoxRef.current = { w, h: next };
      setAutoHeight((prevHeight) => (prevHeight === next ? prevHeight : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [autoActive, expanded, clampHeight, userSized]);

  // 合并受控/非受控：受控优先
  const effectiveHeight = controlled
    ? bodyHeightPx
    : autoActive
      ? (autoHeight ?? minBodyHeightPx)
      : undefined;
  const effectiveOnChange = controlled
    ? onBodyHeightChange
    : autoActive
      ? (h: number) => {
          userSizedRef.current = true;
          setUserSized(true);
          measuredBoxRef.current = { w: measuredBoxRef.current.w, h };
          setAutoHeight(h);
          if (autoSizePersist) writePersistedSizeValue(autoSizePersist.storageKey, autoSizePersist.id, h);
        }
      : undefined;

  const sized = typeof effectiveHeight === "number" && Number.isFinite(effectiveHeight);
  const resizable = sized && typeof effectiveOnChange === "function" && expanded;

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!effectiveOnChange || typeof effectiveHeight !== "number") return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: effectiveHeight,
      };
    },
    [effectiveHeight, effectiveOnChange],
  );

  const onResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !effectiveOnChange) return;
      // 手柄在段顶部：向上拖增大本段高度（边界上移挤压上段、本段变高）
      const next = clampHeight(drag.startHeight - (event.clientY - drag.startY));
      effectiveOnChange(next);
    },
    [clampHeight, effectiveOnChange],
  );

  const onResizePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
  }, []);

  return (
    <section
      className={cn(
        "vsplit-sidebar-section",
        !expanded && "vsplit-sidebar-section--collapsed",
        sized && expanded && "vsplit-sidebar-section--sized",
      )}
    >
      {resizable ? (
        <div
          className="vsplit-sidebar-section__resize"
          role="separator"
          aria-orientation="horizontal"
          aria-valuenow={effectiveHeight}
          aria-valuemin={minBodyHeightPx}
          aria-valuemax={maxBodyHeightPx}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
        />
      ) : null}
      <div className="vsplit-sidebar-section__header-row window-drag-surface" data-tauri-drag-region>
        <button
          type="button"
          className="vsplit-sidebar-section__header window-drag-surface--interactive"
          data-tauri-drag-region="false"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <span className={cn("tree-arrow", expanded && "tree-arrow--open")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </span>
          <span className="vsplit-sidebar-section__title">{title}</span>
        </button>
        {actions ? (
          <div
            className="vsplit-sidebar-section__actions window-drag-surface--interactive"
            data-tauri-drag-region="false"
            onClick={(event) => event.stopPropagation()}
          >
            {actions}
          </div>
        ) : null}
      </div>
      {showBody ? (
        <div
          className={cn(
            "vsplit-sidebar-section__body",
            !expanded && keepMounted && "vsplit-sidebar-section__body--hidden",
          )}
          style={
            sized && expanded
              ? { height: effectiveHeight, flex: "0 0 auto", overflowY: "auto" }
              : undefined
          }
        >
          {autoActive ? (
            <div ref={measureRef} className="vsplit-sidebar-section__measure">
              {children}
            </div>
          ) : (
            children
          )}
        </div>
      ) : null}
    </section>
  );
}

function readPersistedSections<T extends string>(
  storageKey: string,
  defaults: Record<T, boolean>,
): Record<T, boolean> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Record<T, boolean>>;
    const next = { ...defaults };
    for (const key of Object.keys(defaults) as T[]) {
      if (typeof parsed[key] === "boolean") {
        next[key] = parsed[key] as boolean;
      }
    }
    return next;
  } catch {
    return defaults;
  }
}

/** 持久化各分段的展开/折叠状态 */
export function usePersistedVerticalSplitSections<T extends string>(
  storageKey: string,
  defaults: Record<T, boolean>,
) {
  const [sections, setSections] = useState(() => readPersistedSections(storageKey, defaults));

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(sections));
  }, [storageKey, sections]);

  const toggleSection = useCallback((key: T) => {
    setSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const setSectionExpanded = useCallback((key: T, expanded: boolean) => {
    setSections((prev) => (prev[key] === expanded ? prev : { ...prev, [key]: expanded }));
  }, []);

  return { sections, setSections, toggleSection, setSectionExpanded };
}

function readPersistedSizes<T extends string>(
  storageKey: string,
): Partial<Record<T, number>> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Record<T, unknown>>;
    const next: Partial<Record<T, number>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        next[key as T] = value;
      }
    }
    return next;
  } catch {
    return {};
  }
}

/**
 * 持久化可调整高度的分段 body 高度。
 * 未手动拖过的段可继续用内容测量结果覆盖。
 */
export function usePersistedVerticalSplitSizes<T extends string>(storageKey: string) {
  const [sizes, setSizes] = useState(() => readPersistedSizes<T>(storageKey));
  const userSizedKeysRef = useRef<Set<T>>(
    new Set(Object.keys(readPersistedSizes<T>(storageKey)) as T[]),
  );

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(sizes));
  }, [storageKey, sizes]);

  const setSize = useCallback((key: T, heightPx: number, options?: { user?: boolean }) => {
    if (options?.user) {
      userSizedKeysRef.current.add(key);
    }
    setSizes((prev) => (prev[key] === heightPx ? prev : { ...prev, [key]: heightPx }));
  }, []);

  const isUserSized = useCallback((key: T) => userSizedKeysRef.current.has(key), []);

  return { sizes, setSize, isUserSized };
}

/** autoSize 模式下按 id 读写单段高度（存储为 { [id]: number }） */
function readPersistedSizeValue(storageKey: string, id: string): number | undefined {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const v = parsed[id];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function writePersistedSizeValue(storageKey: string, id: string, value: number) {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    parsed[id] = value;
    localStorage.setItem(storageKey, JSON.stringify(parsed));
  } catch {
    // ignore
  }
}
