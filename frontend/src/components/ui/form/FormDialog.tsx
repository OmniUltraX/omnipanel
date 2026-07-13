import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Modal } from "../overlay/Modal";
import { Button } from "../primitives/Button";
import { FormDialogClipboardBar } from "./FormDialogClipboardBar";
import { useI18n } from "../../../i18n";
import type { ClipboardSnapshot } from "../../../lib/readLatestClipboard";
import {
  formFillInputFromClipboard,
  resolveFormFillModelConfig,
  runFormFillSimpleAI,
  type FormFillFieldDef,
  type FormFillValue,
} from "../../ai/simple/formFill";
import { useFormFillModelSelectionId } from "../../../lib/aiScenarioModels";
import { useAiModelsStore } from "../../../stores/aiModelsStore";

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
  variant?: "default" | "secondary" | "ghost";
  size?: "sm" | "default";
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
  /** 介于 header 一body 之间的附加区域（如单元格编辑元信息） */
  beforeBody?: ReactNode;
  className?: string;
  bodyClassName?: string;
  size?: FormDialogSize;
  /** 完全自定乀footer；提供时忽略 cancel / status / actions / primaryAction */
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
  /** 顶部剪贴杀AI 识别栏，默认开吀*/
  clipboardAssist?: boolean;
  onClipboardRecognize?: (snapshot: ClipboardSnapshot | null) => void | Promise<void>;
  /** AI 识别目标字段；与 onAiFill 一起使用时点击「AI识别」会填充表单 */
  aiFillFields?: FormFillFieldDef[];
  onAiFill?: (values: Record<string, FormFillValue>) => void;
  aiFillContext?: string;
  aiModelSelectionId?: string | null;
}

function renderAction(
  action: FormDialogAction,
  fallbackKey: string,
  onBeforeClick?: () => void,
) {
  return (
    <Button
      key={action.key ?? fallbackKey}
      type="button"
      variant={action.variant ?? "secondary"}
      size={action.size ?? "sm"}
      disabled={action.disabled}
      onClick={() => {
        onBeforeClick?.();
        action.onClick?.();
      }}
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
  aiFillFields,
  onAiFill,
  aiFillContext,
  aiModelSelectionId,
}: FormDialogProps) {
  const { t } = useI18n();
  const providers = useAiModelsStore((s) => s.providers);
  const formFillScenarioModelId = useFormFillModelSelectionId();
  const [aiRecognizing, setAiRecognizing] = useState(false);
  const [clipboardStatus, setClipboardStatus] = useState<{
    kind: FormDialogStatusKind;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!open) {
      setClipboardStatus(null);
      setAiRecognizing(false);
    }
  }, [open]);

  const handleClipboardRecognize = useCallback(
    async (snapshot: ClipboardSnapshot | null) => {
      await onClipboardRecognize?.(snapshot);

      if (!aiFillFields?.length || !onAiFill) {
        return;
      }

      const input = formFillInputFromClipboard(snapshot, aiFillFields, aiFillContext);
      if (!input) {
        setClipboardStatus({ kind: "error", message: t("formDialog.clipboard.emptyClipboard") });
        return;
      }

      const modelConfig = resolveFormFillModelConfig(
        providers,
        aiModelSelectionId ?? formFillScenarioModelId,
      );
      if (!modelConfig) {
        setClipboardStatus({ kind: "error", message: t("formDialog.clipboard.noModel") });
        return;
      }

      setAiRecognizing(true);
      setClipboardStatus({ kind: "info", message: t("formDialog.clipboard.recognizing") });
      try {
        const result = await runFormFillSimpleAI(modelConfig, input);
        onAiFill(result.values);
        setClipboardStatus({ kind: "success", message: t("formDialog.clipboard.recognizeSuccess") });
      } catch (error) {
        setClipboardStatus({
          kind: "error",
          message: t("formDialog.clipboard.recognizeFailed", { error: String(error) }),
        });
      } finally {
        setAiRecognizing(false);
      }
    },
    [
      aiFillContext,
      aiFillFields,
      aiModelSelectionId,
      formFillScenarioModelId,
      onAiFill,
      onClipboardRecognize,
      providers,
      t,
    ],
  );

  const clearClipboardStatus = useCallback(() => {
    setClipboardStatus(null);
  }, []);

  if (!open) {
    return null;
  }

  const handleCancel = onCancel ?? onClose;
  const showCancel = cancelLabel !== false;
  const resolvedCancelLabel = cancelLabel === undefined ? t("common.cancel") : cancelLabel;
  /** 父组什status（保孀校验/测试）优先于剪贴杀AI 状态，避免识别成功后遮挡操作反馀*/
  const resolvedStatus = status ?? clipboardStatus;

  const dialogClass = ["modal-dialog", "form-dialog", `form-dialog--${size}`, className]
    .filter(Boolean)
    .join(" ");

  const defaultFooter =
    showCancel || resolvedStatus || (actions && actions.length > 0) || primaryAction ? (
      <div className="modal-footer">
        {showCancel && (
          <Button
            type="button"
            variant={cancelVariant}
            size="sm"
            onClick={() => {
              clearClipboardStatus();
              handleCancel();
            }}
            disabled={cancelDisabled || aiRecognizing}
          >
            {resolvedCancelLabel}
          </Button>
        )}
        {resolvedStatus ? (
          <span
            className={`modal-footer-status modal-footer-status--${resolvedStatus.kind}`}
            title={resolvedStatus.message}
          >
            {resolvedStatus.message}
          </span>
        ) : (
          <div className="modal-footer-spacer" />
        )}
        {actions?.map((action, index) =>
          renderAction(
            { ...action, disabled: action.disabled || aiRecognizing },
            `action-${index}`,
            clearClipboardStatus,
          ),
        )}
        {primaryAction &&
          renderAction(
            {
              ...primaryAction,
              variant: primaryAction.variant ?? "default",
              disabled: primaryAction.disabled || aiRecognizing,
            },
            "primary",
            clearClipboardStatus,
          )}
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
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              disabled={closeDisabled || aiRecognizing}
              aria-label={t("shell.topbar.close")}
            >
              {CLOSE_ICON}
            </Button>
          ) : null}
        </div>

        {clipboardAssist ? (
          <FormDialogClipboardBar
            open={open}
            onRecognize={handleClipboardRecognize}
            recognizing={aiRecognizing}
          />
        ) : null}

        {beforeBody}

        <div className={["modal-body", bodyClassName].filter(Boolean).join(" ")}>{children}</div>

        {footer ?? defaultFooter}
      </div>
    </Modal>
  );
}
