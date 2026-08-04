import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "./isTauriRuntime";

/** 开发构建用独立标题，便于与正式版任务栏区分。 */
export const APP_WINDOW_TITLE = import.meta.env.DEV ? "OmniPanel Dev" : "OmniPanel";

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
