import { confirm } from "@tauri-apps/plugin-dialog";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 跨平台确认框：Tauri 使用原生 dialog，浏览器 dev 回退 window.confirm */
export async function appConfirm(message: string, title = "OmniPanel"): Promise<boolean> {
  if (isTauriRuntime()) {
    return confirm(message, { title, kind: "warning" });
  }
  return window.confirm(message);
}
