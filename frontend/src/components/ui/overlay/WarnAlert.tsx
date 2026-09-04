import { useEffect, type ReactNode } from "react";
import { Modal } from "./Modal";
import { WorkbenchActionButton } from "../primitives/WorkbenchActionButton";
import type { AppDialogAction } from "../../../stores/appDialogStore";

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
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 仅展示确认按钮（关闭/知道了） */
  alertOnly?: boolean;
  /** 确认后是否自动触发 onClose；全局对话框设为 false 以区分确认/取消 */
  closeOnConfirm?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  /** 多按钮模式：传入后替代 confirm/cancel；onChoose(id) 选中即关闭 */
  actions?: AppDialogAction[];
  onChoose?: (actionId: string) => void;
}

function isEditableKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest("textarea, select, [contenteditable='true']")) return true;
  if (target instanceof HTMLInputElement) {
    const type = target.type;
    return type !== "button" && type !== "submit" && type !== "checkbox" && type !== "radio" && type !== "hidden";
  }
  return false;
}

/**
 * 通用警告确认弹窗。危险/覆盖类操作统一使用此组件，保持视觉与交互一致。
 *
 * 全局入口：`appConfirm` / `appAlert` / `appChoose` → `AppDialogHost` → 本组件。
 * 模块内也可直接使用，但优先走 `appConfirm` / `appChoose` 以保持 API 统一。
 */
export function WarnAlert({
  open,
  title,
  message,
  children,
  confirmLabel = "确认",
  cancelLabel = "取消",
  alertOnly = false,
  closeOnConfirm = true,
  onConfirm,
  onClose,
  actions,
  onChoose,
}: WarnAlertProps) {
  const handleConfirm = () => {
    onConfirm();
    if (closeOnConfirm) {
      onClose();
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.defaultPrevented || event.isComposing) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (isEditableKeyTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      onConfirm();
      if (closeOnConfirm) {
        onClose();
      }
    };
    // 捕获阶段：避免焦点在按钮上时浏览器默认再触发一次 click
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onConfirm, onClose, closeOnConfirm]);

  const hasActions = Array.isArray(actions) && actions.length > 0;

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
          {hasActions ? (
            actions!.map((action) => (
              <WorkbenchActionButton
                key={action.id}
                danger={action.variant === "danger"}
                onClick={() => onChoose?.(action.id)}
              >
                {action.label}
              </WorkbenchActionButton>
            ))
          ) : (
            <>
              {!alertOnly && (
                <WorkbenchActionButton onClick={onClose}>
                  {cancelLabel}
                </WorkbenchActionButton>
              )}
              <WorkbenchActionButton danger onClick={handleConfirm}>
                {confirmLabel}
              </WorkbenchActionButton>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
