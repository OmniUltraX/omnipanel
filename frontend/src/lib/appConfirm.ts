import { requestAppConfirm } from "../stores/appDialogStore";

export type AppConfirmOptions = {
  okLabel?: string;
  cancelLabel?: string;
  confirmLabel?: string;
  kind?: "info" | "warning" | "error";
};

/**
 * 应用内确认框（全局 `AppDialogHost` + `WarnAlert` 渲染）。
 *
 * **禁止**改为 Tauri / `window.confirm` 原生弹窗；需要改样式请改 `WarnAlert`。
 */
export function appConfirm(
  message: string,
  title = "OmniPanel",
  options?: AppConfirmOptions,
): Promise<boolean> {
  return requestAppConfirm(message, title, {
    confirmLabel: options?.confirmLabel ?? options?.okLabel,
    cancelLabel: options?.cancelLabel,
  });
}
