import type { ReactNode } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { FormDialogClipboardBar } from "./FormDialogClipboardBar";
import { useI18n } from "../../i18n";
import type { ClipboardSnapshot } from "../../lib/readLatestClipboard";

export { FormField, type FormFieldProps } from "./FormField";

const CLOSE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" aria-hidden>
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

export type FormDialogSize = "sm" | "md" | "lg" | "xl";
export type FormDialogStatusKind = "info" | "success" | "error";

export interface FormDialogAction {
  key?: string;
  label: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "icon";
  size?: "sm" | "md";
  disabled?: boolean;
  onClick?: () => void;
}

export interface FormDialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  titleId?: string;
  children: ReactNode;
  /** 介于 header 与 body 之间的附加区域（如单元格编辑元信息） */
  beforeBody?: ReactNode;
  className?: string;
  bodyClassName?: string;
  size?: FormDialogSize;
  /** 完全自定义 footer；提供时忽略 cancel / status / actions / primaryAction */
  footer?: ReactNode;
  showCloseButton?: boolean;
  closeDisabled?: boolean;
  cancelLabel?: string | false;
  onCancel?: () => void;
  cancelVariant?: "ghost" | "secondary";
  cancelDisabled?: boolean;
  status?: { kind: FormDialogStatusKind; message: string } | null;
  actions?: FormDialogAction[];
  primaryAction?: FormDialogAction;
  /** 顶部剪贴板 AI 识别栏，默认开启 */
  clipboardAssist?: boolean;
  onClipboardRecognize?: (snapshot: ClipboardSnapshot | null) => void;
}

function renderAction(action: FormDialogAction, fallbackKey: string) {
  return (
    <Button
      key={action.key ?? fallbackKey}
      type="button"
      variant={action.variant ?? "secondary"}
      size={action.size ?? "sm"}
      disabled={action.disabled}
      onClick={action.onClick}
    >
      {action.label}
    </Button>
  );
}

export function FormDialog({
  open,
  onClose,
  title,
  subtitle,
  titleId,
  children,
  beforeBody,
  className,
  bodyClassName,
  size = "md",
  footer,
  showCloseButton = true,
  closeDisabled = false,
  cancelLabel,
  onCancel,
  cancelVariant = "secondary",
  cancelDisabled = false,
  status,
  actions,
  primaryAction,
  clipboardAssist = true,
  onClipboardRecognize,
}: FormDialogProps) {
  const { t } = useI18n();

  if (!open) {
    return null;
  }

  const handleCancel = onCancel ?? onClose;
  const showCancel = cancelLabel !== false;
  const resolvedCancelLabel = cancelLabel === undefined ? t("common.cancel") : cancelLabel;

  const dialogClass = ["modal-dialog", "form-dialog", `form-dialog--${size}`, className]
    .filter(Boolean)
    .join(" ");

  const defaultFooter =
    showCancel || status || (actions && actions.length > 0) || primaryAction ? (
      <div className="modal-footer">
        {showCancel && (
          <Button
            type="button"
            variant={cancelVariant}
            size="sm"
            onClick={handleCancel}
            disabled={cancelDisabled}
          >
            {resolvedCancelLabel}
          </Button>
        )}
        {status ? (
          <span
            className={`modal-footer-status modal-footer-status--${status.kind}`}
            title={status.message}
          >
            {status.message}
          </span>
        ) : (
          <div className="modal-footer-spacer" />
        )}
        {actions?.map((action, index) => renderAction(action, `action-${index}`))}
        {primaryAction && renderAction({ ...primaryAction, variant: primaryAction.variant ?? "primary" }, "primary")}
      </div>
    ) : null;

  return (
    <Modal open={open} onClose={onClose}>
      <div
        className={dialogClass}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-header">
          <div className="form-dialog__heading">
            <h3 id={titleId}>{title}</h3>
            {subtitle ? <p className="modal-subtitle">{subtitle}</p> : null}
          </div>
          {showCloseButton ? (
            <Button
              type="button"
              variant="icon"
              onClick={onClose}
              disabled={closeDisabled}
              aria-label={t("shell.topbar.close")}
            >
              {CLOSE_ICON}
            </Button>
          ) : null}
        </div>

        {clipboardAssist ? (
          <FormDialogClipboardBar open={open} onRecognize={onClipboardRecognize} />
        ) : null}

        {beforeBody}

        <div className={["modal-body", bodyClassName].filter(Boolean).join(" ")}>{children}</div>

        {footer ?? defaultFooter}
      </div>
    </Modal>
  );
}
