import type { FormEvent, ReactNode } from "react";
import { Modal } from "../overlay/Modal";
import { Button } from "../primitives/Button";
import { useI18n } from "../../../i18n";

export interface CellEditDialogProps {
  open: boolean;
  title: ReactNode;
  /** 列名、类型等元信息，显示在标题与编辑区之�?*/
  meta?: ReactNode;
  children: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  confirmDisabled?: boolean;
  className?: string;
}

/**
 * 单元格编辑专用弹窗：轻量表单壳，不含剪贴�?AI �?FormDialog 能力�?
 */
export function CellEditDialog({
  open,
  title,
  meta,
  children,
  onConfirm,
  onCancel,
  confirmLabel,
  cancelLabel,
  confirmDisabled = false,
  className,
}: CellEditDialogProps) {
  const { t } = useI18n();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!confirmDisabled) {
      onConfirm();
    }
  };

  if (!open) {
    return null;
  }

  const dialogClass = ["modal-dialog", "cell-edit-dialog", className].filter(Boolean).join(" ");

  return (
    <Modal open={open} onClose={onCancel}>
      <form className={dialogClass} onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="cell-edit-dialog__heading">
            <h3>{title}</h3>
          </div>
          <Button
            type="button"
            variant="icon"
            onClick={onCancel}
            aria-label={t("shell.topbar.close")}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </Button>
        </div>

        {meta}

        <div className="modal-body cell-edit-dialog__body">{children}</div>

        <div className="modal-footer">
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
            {cancelLabel ?? t("common.cancel")}
          </Button>
          <div className="modal-footer-spacer" />
          <Button type="submit" variant="primary" size="sm" disabled={confirmDisabled}>
            {confirmLabel ?? t("common.confirm")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
