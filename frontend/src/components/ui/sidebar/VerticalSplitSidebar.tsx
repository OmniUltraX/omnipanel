import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
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
  /**
   * 作为最后一个展开段时撑满剩余空间（自动高度退为最小高度）。
   * 一般由父容器自动注入，无需手动传入。
   */
  fillRemainingSpace?: boolean;
}

export interface VerticalSplitSidebarProps {
  children: ReactNode;
  className?: string;
}

/** 读取子元素对应的分段状态（直挂分段 / section 属性透传面板） */
function readChildSectionState(child: ReactNode): {
  expanded: boolean;
  autoSize: boolean;
  controlled: boolean;
} | null {
  if (!isValidElement(child)) return null;
  const props = child.props as {
    expanded?: unknown;
    autoSize?: unknown;
    bodyHeightPx?: unknown;
    section?: unknown;
  };
  const section =
    props.section && typeof props.section === "object"
      ? (props.section as { expanded?: unknown; autoSize?: unknown; bodyHeightPx?: unknown })
      : null;
  // 直挂分段以自身 props 为准；section 透传面板（如数据库查询/同步）以内层 section 为准
  const source = section ?? ("expanded" in props ? props : null);
  if (!source) return null;
  return {
    expanded: source.expanded !== false,
    autoSize: (source as { autoSize?: unknown }).autoSize === true,
    controlled: typeof (source as { bodyHeightPx?: unknown }).bodyHeightPx === "number",
  };
}

/** 纵向均分、可折叠的多段侧栏容器（数据库 Schema、文件连接等模块复用） */
export function VerticalSplitSidebar({ children, className }: VerticalSplitSidebarProps) {
  const items = Children.toArray(children);
  // 最后一个展开段：若为自动高度且没有普通段展开分摊空间，则令其撑满剩余空间，
  // 避免固定内容高度在容器底部留下空白。
  let lastExpandedIndex = -1;
  let hasExpandedFlexSection = false;
  items.forEach((child, index) => {
    const state = readChildSectionState(child);
    if (!state || !state.expanded) return;
    lastExpandedIndex = index;
    if (!state.autoSize && !state.controlled) hasExpandedFlexSection = true;
  });
  const filled = items.map((child, index) => {
    if (index !== lastExpandedIndex || hasExpandedFlexSection) return child;
    const state = readChildSectionState(child);
    if (!state || !state.autoSize || state.controlled) return child;
    if (!isValidElement(child)) return child;
    const props = child.props as {
      section?: Record<string, unknown>;
      fillRemainingSpace?: unknown;
    };
    if (props.section && typeof props.section === "object") {
      if (props.section.fillRemainingSpace === true) return child;
      return cloneElement(child as ReactElement<Record<string, unknown>>, {
        section: { ...props.section, fillRemainingSpace: true },
      });
    }
    if (props.fillRemainingSpace === true) return child;
    return cloneElement(child as ReactElement<Record<string, unknown>>, {
      fillRemainingSpace: true,
    });
  });
  return <div className={cn("vsplit-sidebar", className)}>{filled}</div>;
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
  /** 拖拽手柄位置：首段常用 bottom，其余段默认 top */
  resizePlacement = "top",
  fillRemainingSpace = false,
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
  resizePlacement?: "top" | "bottom";
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
      const next = clampHeight(h);
      // 宽度变了但内容长高了（展开文件夹/新增条目）：必须跟进新高度。
      // （滚动条出现会改变宽度，旧逻辑会把这次长高吞掉导致内容被截断。）
      // 只有新高度没有变高时，才视为侧栏拖宽引起的重排而保持原高度。
      if (hasStableHeight && prev.w > 0 && Math.abs(w - prev.w) > 0.5 && next <= prev.h) {
        measuredBoxRef.current = { w, h: prev.h > 0 ? prev.h : next };
        return;
      }
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
  // 最后一个展开的自动高度段：撑满剩余空间，测量/拖拽高度退为最小高度；
  // 拖拽只改变撑满的下限，不阻止填充（否则陈旧的持久化高度会永久冻住填充）。
  const fillActive = fillRemainingSpace && expanded && autoActive && !controlled;

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
      const delta = event.clientY - drag.startY;
      const next =
        resizePlacement === "bottom"
          ? clampHeight(drag.startHeight + delta)
          : clampHeight(drag.startHeight - delta);
      effectiveOnChange(next);
    },
    [clampHeight, effectiveOnChange, resizePlacement],
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

  const resizeHandle = resizable ? (
    <div
      className={cn(
        "vsplit-sidebar-section__resize",
        resizePlacement === "bottom" && "vsplit-sidebar-section__resize--bottom",
      )}
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
  ) : null;

  return (
    <section
      className={cn(
        "vsplit-sidebar-section",
        !expanded && "vsplit-sidebar-section--collapsed",
        sized && expanded && "vsplit-sidebar-section--sized",
        fillActive && "vsplit-sidebar-section--fill",
      )}
    >
      {resizePlacement !== "bottom" ? resizeHandle : null}
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
              ? fillActive
                ? { minHeight: effectiveHeight, flex: "1 1 auto", overflowY: "auto" }
                : { height: effectiveHeight, flex: "0 0 auto", overflowY: "auto" }
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
      {resizePlacement === "bottom" ? resizeHandle : null}
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

type PersistedSizeBundle<T extends string> = {
  sizes: Partial<Record<T, number>>;
  userSized: T[];
};

function readNumericSizeMap<T extends string>(
  source: Record<string, unknown>,
): Partial<Record<T, number>> {
  const next: Partial<Record<T, number>> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "userSized" || key === "sizes") continue;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      next[key as T] = value;
    }
  }
  return next;
}

function readPersistedSizeBundle<T extends string>(storageKey: string): PersistedSizeBundle<T> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { sizes: {}, userSized: [] };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.sizes && typeof parsed.sizes === "object" && !Array.isArray(parsed.sizes)) {
      const sizes = readNumericSizeMap<T>(parsed.sizes as Record<string, unknown>);
      const userSized = Array.isArray(parsed.userSized)
        ? parsed.userSized.filter((key): key is T => typeof key === "string")
        : [];
      return { sizes, userSized };
    }
    return { sizes: readNumericSizeMap<T>(parsed), userSized: [] };
  } catch {
    return { sizes: {}, userSized: [] };
  }
}

/**
 * 持久化可调整高度的分段 body 高度。
 * 未手动拖过的段可继续用内容测量结果覆盖。
 */
export function usePersistedVerticalSplitSizes<T extends string>(storageKey: string) {
  const initialBundleRef = useRef<PersistedSizeBundle<T> | null>(null);
  if (!initialBundleRef.current) {
    initialBundleRef.current = readPersistedSizeBundle<T>(storageKey);
  }
  const initialBundle = initialBundleRef.current;

  const [sizes, setSizes] = useState(() => initialBundle.sizes);
  const userSizedKeysRef = useRef<Set<T>>(new Set(initialBundle.userSized));

  useEffect(() => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        sizes,
        userSized: [...userSizedKeysRef.current],
      }),
    );
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
    if (parsed.sizes && typeof parsed.sizes === "object" && !Array.isArray(parsed.sizes)) {
      const v = (parsed.sizes as Record<string, unknown>)[id];
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
    }
    const v = parsed[id];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function writePersistedSizeValue(storageKey: string, id: string, value: number) {
  try {
    const bundle = readPersistedSizeBundle(storageKey);
    bundle.sizes[id] = value;
    if (!bundle.userSized.includes(id)) {
      bundle.userSized.push(id);
    }
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        sizes: bundle.sizes,
        userSized: bundle.userSized,
      }),
    );
  } catch {
    // ignore
  }
}
