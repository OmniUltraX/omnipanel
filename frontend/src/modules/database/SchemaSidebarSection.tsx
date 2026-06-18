import type { ReactNode } from "react";

export interface SchemaSidebarSectionConfig {
  title: string;
  expanded: boolean;
  onToggle: () => void;
}

export function SchemaSidebarSection({
  title,
  expanded,
  onToggle,
  actions,
  children,
}: SchemaSidebarSectionConfig & {
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className={`schema-sidebar-section${expanded ? "" : " schema-sidebar-section--collapsed"}`}
    >
      <div className="schema-sidebar-section__header-row">
        <button
          type="button"
          className="schema-sidebar-section__header"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <span className={`tree-arrow${expanded ? " tree-arrow--open" : ""}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </span>
          <span className="schema-sidebar-section__title">{title}</span>
        </button>
        {actions ? (
          <div
            className="schema-sidebar-section__actions"
            onClick={(event) => event.stopPropagation()}
          >
            {actions}
          </div>
        ) : null}
      </div>
      {expanded && <div className="schema-sidebar-section__body">{children}</div>}
    </section>
  );
}
