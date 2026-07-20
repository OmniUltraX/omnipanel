import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Button } from "../ui/primitives/Button";
import { TextInput } from "../ui/form/TextInput";

export type SftpComposerProps = {
  title: string;
  /** 标题旁可选说明（如原文件名） */
  hint?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** 主按钮是否可用；默认非空即可提交 */
  canConfirm?: boolean;
  submitting?: boolean;
  /** 输入框额外样式（如 chmod 窄宽） */
  inputStyle?: CSSProperties;
  inputClassName?: string;
};

/** SFTP / 本地文件侧栏共用的内联新建·重命名·权限表单 */
export function SftpComposer({
  title,
  hint,
  value,
  onChange,
  placeholder,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  canConfirm,
  submitting = false,
  inputStyle,
  inputClassName,
}: SftpComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const allowConfirm = (canConfirm ?? value.trim().length > 0) && !submitting;

  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(id);
  }, []);

  return (
    <div className="sftp-composer" role="form" aria-label={title}>
      <div className="sftp-composer__header">
        <span className="sftp-composer__title">{title}</span>
        {hint ? <span className="sftp-composer__hint">{hint}</span> : null}
      </div>
      <div className="sftp-composer__body">
        <TextInput
          ref={inputRef}
          className={["input", "input-sm", "sftp-composer__input", inputClassName]
            .filter(Boolean)
            .join(" ")}
          size="sm"
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          clearable
          copyable={false}
          disabled={submitting}
          style={inputStyle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (allowConfirm) onConfirm();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <div className="sftp-composer__actions">
          <Button
            variant="primary"
            size="sm"
            disabled={!allowConfirm}
            onClick={() => {
              if (allowConfirm) onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={submitting}
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
