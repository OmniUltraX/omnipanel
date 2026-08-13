import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../../i18n";
import { PasswordInput } from "./PasswordInput";
import { TextInput } from "./TextInput";

export interface QuickInputDialogProps {
  open: boolean;
  /** 无障碍标签；也可在未传 placeholder 时作为占位文案 */
  title: string;
  /** 兼容旧调用（界面不展示） */
  subtitle?: string;
  placeholder?: string;
  /** 兼容旧调用（界面不展示） */
  fieldLabel?: string;
  /** 兼容旧调用（界面不展示） */
  description?: string;
  defaultValue?: string;
  /** 密码输入（如 SSH 密码补全） */
  password?: boolean;
  onCancel: () => void;
  onConfirm: (value: string) => void;
  validate?: (value: string) => string | null;
}

/**
 * 单字段字符串输入 — 模仿 VS Code Quick Input：
 * 靠近视口顶部只显示一个输入框，Enter 确认，Esc / 点击遮罩取消。
 */
export function QuickInputDialog({
  open,
  title,
  placeholder,
  defaultValue = "",
  password = false,
  onCancel,
  onConfirm,
  validate,
}: QuickInputDialogProps) {
  const { t } = useI18n();
  const labelId = useId();
  const inputWrapRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setValue(defaultValue);
    setError(null);
  }, [open, defaultValue]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, onCancel]);

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => {
      const input = inputWrapRef.current?.querySelector<HTMLInputElement>("input");
      if (!input) return;
      input.focus();
      if (defaultValue) {
        input.select();
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [open, defaultValue, password]);

  if (!open) {
    return null;
  }

  const submit = () => {
    const trimmed = value.trim();
    const validationError = validate?.(trimmed) ?? (trimmed ? null : t("quickInput.required"));
    if (validationError) {
      setError(validationError);
      return;
    }
    onConfirm(trimmed);
  };

  const onChange = (next: string) => {
    setValue(next);
    if (error) setError(null);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      submit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  const resolvedPlaceholder = placeholder?.trim() || title;

  return createPortal(
    <div
      className="quick-input-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="quick-input"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span id={labelId} className="quick-input__sr-only">
          {title}
        </span>
        <div className="quick-input__field" ref={inputWrapRef}>
          {password ? (
            <PasswordInput
              className="input quick-input__control"
              autoFocus
              copyable={false}
              placeholder={resolvedPlaceholder}
              value={value}
              onChange={onChange}
              onKeyDown={onKeyDown}
              aria-labelledby={labelId}
              aria-invalid={Boolean(error)}
              style={{ width: "100%" }}
            />
          ) : (
            <TextInput
              className="input quick-input__control"
              autoFocus
              clearable={false}
              copyable={false}
              placeholder={resolvedPlaceholder}
              value={value}
              onChange={onChange}
              onKeyDown={onKeyDown}
              aria-labelledby={labelId}
              aria-invalid={Boolean(error)}
              style={{ width: "100%" }}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
