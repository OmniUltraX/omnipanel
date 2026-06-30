import { requestAppAlert } from "../stores/appDialogStore";

/** 应用内提示框，替代 window.alert */
export function appAlert(message: string, title = "OmniPanel"): Promise<void> {
  return requestAppAlert(message, title);
}
