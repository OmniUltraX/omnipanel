import { useCallback, useEffect, useState, type ReactNode } from "react";
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

/** 纵向均分、可折叠的多段侧栏容器（数据�?Schema、文件连接等模块复用�?*/
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
}: VerticalSplitSidebarSectionConfig & {
  actions?: ReactNode;
  children: ReactNode;
  /** 折叠时仍挂载子树（用于向标题栏上报操作按钮） */
  keepMounted?: boolean;
}) {
  const showBody = expanded || keepMounted;
  return (
    <section
      className={cn("vsplit-sidebar-section", !expanded && "vsplit-sidebar-section--collapsed")}
    >
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

/** 持久化各分段的展开/折叠状�?*/
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
