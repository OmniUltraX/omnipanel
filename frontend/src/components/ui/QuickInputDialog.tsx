import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { Modal } from "./Modal";

export interface QuickInputDialogProps {
  open: boolean;
  title: string;
  subtitle?: string;
  placeholder?: string;
  defaultValue?: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
  validate?: (value: string) => string | null;
}

export function QuickInputDialog({
  open,
  title,
  subtitle,
  placeholder,
  defaultValue = "",
  onCancel,
  onConfirm,
  validate,
}: QuickInputDialogProps) {
  const { t } = useI18n();
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setValue(defaultValue);
    setError(null);
  }, [open, defaultValue]);

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

  return (
    <Modal open={open} onClose={onCancel}>
      <div className="modal-dialog quick-input-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="quick-input-heading">
            <h3>{title}</h3>
            {subtitle && <p className="quick-input-subtitle">{subtitle}</p>}
          </div>
          <button className="btn-icon" type="button" onClick={onCancel}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <input
            className="input"
            autoFocus
            placeholder={placeholder}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
            style={{ width: "100%" }}
          />
          {error && (
            <div style={{ fontSize: "12px", color: "var(--color-danger, #ff3b30)" }}>{error}</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
