import { forwardRef, useCallback, useId, useImperativeHandle, useRef, type InputHTMLAttributes } from "react";
import { Button } from "../primitives/Button";
import { useI18n } from "../../../i18n";
import {
  CheckIcon,
  ClearIcon,
  CopyIcon,
  inputFieldActionClass,
  useCopyFeedback,
} from "./inputFieldShared";

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange" | "size"> {
  value: string;
  onChange: (value: string) => void;
  /** 是否显示清空按钮，默�?true */
  clearable?: boolean;
  /** 是否显示复制按钮，默�?true */
  copyable?: boolean;
  /** 控件高度，与 Select / PasswordInput 对齐 */
  size?: "sm" | "md";
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  {
    value,
    onChange,
    clearable = true,
    copyable = true,
    size = "md",
    className = "input",
    style,
    disabled,
    id: idProp,
    ...rest
  },
  ref,
) {
  const { t } = useI18n();
  const autoId = useId();
  const inputId = idProp ?? autoId;
  const inputRef = useRef<HTMLInputElement>(null);
  const { copied, copy } = useCopyFeedback();

  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

  const actionCount = (clearable ? 1 : 0) + (copyable ? 1 : 0);

  const handleClear = useCallback(() => {
    if (disabled || !value) return;
    onChange("");
  }, [disabled, onChange, value]);

  const handleCopy = useCallback(() => {
    if (disabled || !value) return;
    void copy(value);
  }, [copy, disabled, value]);

  const controlClassName = [
    className,
    size === "sm" ? "input-sm" : "",
    actionCount === 0 ? "input-field__control--standalone" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (actionCount === 0) {
    return (
      <input
        {...rest}
        ref={inputRef}
        id={inputId}
        type="text"
        className={controlClassName}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", ...style }}
      />
    );
  }

  return (
    <div className={inputFieldActionClass(actionCount, size)}>
      <input
        {...rest}
        ref={inputRef}
        id={inputId}
        type="text"
        className={className}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", ...style }}
      />
      <div className="input-field__actions">
        {clearable && (
          <Button
            type="button"
            variant="icon"
            size="icon-sm"
            className="input-field__action"
            title={t("common.clear")}
            aria-label={t("common.clear")}
            disabled={disabled || !value}
            onClick={handleClear}
          >
            <ClearIcon />
          </Button>
        )}
        {copyable && (
          <Button
            type="button"
            variant="icon"
            size="icon-sm"
            className="input-field__action"
            title={copied ? t("common.copied") : t("common.copy")}
            aria-label={copied ? t("common.copied") : t("common.copy")}
            disabled={disabled || !value}
            onClick={handleCopy}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        )}
      </div>
    </div>
  );
});
