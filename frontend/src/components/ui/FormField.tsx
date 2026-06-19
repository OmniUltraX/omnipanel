import { useId, type ReactNode } from "react";

export interface FormFieldProps {
  /** 字段标签 */
  label: ReactNode;
  /** 关联控件 id */
  htmlFor?: string;
  /** 字段说明，悬停 label 旁问号时显示 */
  description?: string;
  /** 输入框下方的补充说明（较长文本） */
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

const HELP_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12" aria-hidden>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M6.2 6.1a1.8 1.8 0 013.1 1.2c0 1.2-1.55 1.45-1.55 2.55" />
    <circle cx="8" cy="11.75" r="0.6" fill="currentColor" stroke="none" />
  </svg>
);

export function FormField({
  label,
  htmlFor,
  description,
  hint,
  children,
  className,
}: FormFieldProps) {
  const tooltipId = useId();
  const rootClass = ["form-field", className].filter(Boolean).join(" ");

  return (
    <div className={rootClass}>
      <div className="form-label-row">
        <label className="form-label" htmlFor={htmlFor}>
          {label}
        </label>
        {description ? (
          <span className="form-label-help" aria-describedby={tooltipId}>
            <span className="form-label-help__trigger" tabIndex={0} aria-label={description}>
              {HELP_ICON}
            </span>
            <span id={tooltipId} role="tooltip" className="form-label-help__tooltip">
              {description}
            </span>
          </span>
        ) : null}
      </div>
      {children}
      {hint ? <div className="form-field-hint">{hint}</div> : null}
    </div>
  );
}
