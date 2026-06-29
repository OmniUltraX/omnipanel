import type { ReactNode } from "react";

interface SettingsCollapsibleSectionProps {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

/** 设置页通用折叠区块 */
export function SettingsCollapsibleSection({
  title,
  description,
  defaultOpen = false,
  children,
}: SettingsCollapsibleSectionProps) {
  return (
    <details className="settings-collapsible" open={defaultOpen}>
      <summary className="settings-collapsible-summary">
        <div className="setting-label">
          <h4>{title}</h4>
          {description ? <p>{description}</p> : null}
        </div>
        <svg
          className="settings-collapsible-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </summary>
      <div className="settings-collapsible-body">{children}</div>
    </details>
  );
}
