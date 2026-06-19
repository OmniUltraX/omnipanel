import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { FormDialog, FormField } from "./FormDialog";

export interface QuickInputDialogProps {
  open: boolean;
  title: string;
  subtitle?: string;
  placeholder?: string;
  /** 字段标签；与 description 同时提供时显示 FormField */
  fieldLabel?: string;
  /** 字段说明，显示在 label 旁问号提示中 */
  description?: string;
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
  fieldLabel,
  description,
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
    <FormDialog
      open={open}
      onClose={onCancel}
      title={title}
      subtitle={subtitle}
      size="sm"
      className="quick-input-dialog"
      clipboardAssist={false}
      onCancel={onCancel}
      primaryAction={{ label: t("common.confirm"), onClick: submit }}
    >
      {fieldLabel || description ? (
        <FormField label={fieldLabel ?? ""} description={description}>
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
        </FormField>
      ) : (
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
      )}
      {error && (
        <div style={{ fontSize: "12px", color: "var(--color-danger, #ff3b30)" }}>{error}</div>
      )}
    </FormDialog>
  );
}
