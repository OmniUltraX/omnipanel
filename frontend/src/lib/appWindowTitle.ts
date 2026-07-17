import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "./isTauriRuntime";

export const APP_WINDOW_TITLE = "OmniPanel";

/** 同步 WebView 文档标题与 Tauri 原生窗口标题（Windows 任务栏缩略图依赖后者）。 */
export function syncAppWindowTitle(title: string = APP_WINDOW_TITLE): void {
  document.title = title;
  if (!isTauriRuntime()) return;
  try {
    void getCurrentWindow().setTitle(title).catch(() => {});
  } catch {
    // ignore（非 Tauri 环境或 internals 未就绪）
  }
}
