import { useCallback, useId, useState, type InputHTMLAttributes } from "react";
import { Button } from "./Button";
import { useI18n } from "../../i18n";
import {
  CheckIcon,
  CopyIcon,
  EyeClosedIcon,
  EyeOpenIcon,
  inputFieldActionClass,
  useCopyFeedback,
} from "./inputFieldShared";

export interface PasswordInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange" | "size"> {
  value: string;
  onChange: (value: string) => void;
  /** 是否显示复制按钮 */
  copyable?: boolean;
  /** 控件高度，与 Select / TextInput 对齐 */
  size?: "sm" | "md";
}

export function PasswordInput({
  value,
  onChange,
  copyable = false,
  size = "md",
  className = "input",
  style,
  disabled,
  id: idProp,
  ...rest
}: PasswordInputProps) {
  const { t } = useI18n();
  const autoId = useId();
  const inputId = idProp ?? autoId;
  const [visible, setVisible] = useState(false);
  const { copied, copy } = useCopyFeedback();

  const actionCount = copyable ? 2 : 1;

  const handleCopy = useCallback(async () => {
    if (!value || disabled) return;
    await copy(value);
  }, [copy, disabled, value]);

  return (
    <div className={inputFieldActionClass(actionCount, size)}>
      <input
        {...rest}
        id={inputId}
        className={className}
        type={visible ? "text" : "password"}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", ...style }}
        autoComplete={rest.autoComplete ?? "off"}
      />
      <div className="input-field__actions">
        <Button
          type="button"
          variant="icon"
          size="icon-sm"
          className="input-field__action"
          title={visible ? t("common.hideSecret") : t("common.showSecret")}
          aria-label={visible ? t("common.hideSecret") : t("common.showSecret")}
          disabled={disabled}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeClosedIcon /> : <EyeOpenIcon />}
        </Button>
        {copyable && (
          <Button
            type="button"
            variant="icon"
            size="icon-sm"
            className="input-field__action"
            title={copied ? t("common.copied") : t("common.copy")}
            aria-label={copied ? t("common.copied") : t("common.copy")}
            disabled={disabled || !value}
            onClick={() => void handleCopy()}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        )}
      </div>
    </div>
  );
}
