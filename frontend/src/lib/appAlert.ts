import { requestAppAlert } from "../stores/appDialogStore";

export type AppAlertOptions = {
  kind?: "info" | "warning" | "error";
  okLabel?: string;
};

/**
 * 应用内提示框（全局 `AppDialogHost` + `WarnAlert` 渲染）。
 *
 * **禁止**改为 Tauri / `window.alert` 原生弹窗。
 */
export function appAlert(
  message: string,
  title = "OmniPanel",
  options?: AppAlertOptions,
): Promise<void> {
  return requestAppAlert(message, title, {
    confirmLabel: options?.okLabel,
  });
}
