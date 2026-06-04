import { Modal } from "./Modal";

const WARN_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20" aria-hidden>
    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

export interface WarnAlertProps {
  open: boolean;
  title: string;
  /** 正文；也可用 children 传入更复杂内容 */
  message?: string;
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 仅展示确认按钮（关闭/知道了） */
  alertOnly?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * 通用警告确认弹窗。危险/覆盖类操作统一使用此组件，保持视觉与交互一致。
 */
export function WarnAlert({
  open,
  title,
  message,
  children,
  confirmLabel = "确认",
  cancelLabel = "取消",
  alertOnly = false,
  onConfirm,
  onClose,
}: WarnAlertProps) {
  const handleConfirm = () => {
    onConfirm();
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose}>
      <div
        className="warn-alert-dialog"
        role="alertdialog"
        aria-labelledby="warn-alert-title"
        aria-describedby={message ? "warn-alert-desc" : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="warn-alert-header">
          <span className="warn-alert-icon" aria-hidden>
            {WARN_ICON}
          </span>
          <h3 id="warn-alert-title" className="warn-alert-title">
            {title}
          </h3>
        </div>
        <div className="warn-alert-body">
          {message ? (
            <p id="warn-alert-desc" className="warn-alert-message">
              {message}
            </p>
          ) : null}
          {children}
        </div>
        <div className="warn-alert-footer">
          {!alertOnly && (
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              {cancelLabel}
            </button>
          )}
          <button type="button" className="btn btn-warn" onClick={handleConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
