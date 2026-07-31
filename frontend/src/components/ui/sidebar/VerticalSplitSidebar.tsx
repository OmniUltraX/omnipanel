import {
  useCallback,
  useEffect,
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
  const sized = typeof bodyHeightPx === "number" && Number.isFinite(bodyHeightPx);
  const resizable = sized && typeof onBodyHeightChange === "function" && expanded;
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);

  const clampHeight = useCallback(
    (value: number) => Math.max(minBodyHeightPx, Math.min(maxBodyHeightPx, Math.round(value))),
    [maxBodyHeightPx, minBodyHeightPx],
  );

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!onBodyHeightChange || typeof bodyHeightPx !== "number") return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: bodyHeightPx,
      };
    },
    [bodyHeightPx, onBodyHeightChange],
  );

  const onResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !onBodyHeightChange) return;
      // 手柄在段顶部：向下拖增大本段高度
      const next = clampHeight(drag.startHeight + (event.clientY - drag.startY));
      onBodyHeightChange(next);
    },
    [clampHeight, onBodyHeightChange],
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
          aria-valuenow={bodyHeightPx}
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
          style={sized && expanded ? { height: bodyHeightPx, flex: "0 0 auto" } : undefined}
        >
          {children}
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
