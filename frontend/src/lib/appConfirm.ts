import { requestAppConfirm } from "../stores/appDialogStore";

/** 应用内确认框，替代 window.confirm / Tauri 原生 dialog */
export function appConfirm(message: string, title = "OmniPanel"): Promise<boolean> {
  return requestAppConfirm(message, title);
}
