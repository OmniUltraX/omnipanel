import { getCurrentWindow } from "@tauri-apps/api/window";

export const APP_WINDOW_TITLE = "OmniPanel";

/** 同步 WebView 文档标题与 Tauri 原生窗口标题（Windows 任务栏缩略图依赖后者）。 */
export function syncAppWindowTitle(title: string = APP_WINDOW_TITLE): void {
  document.title = title;
  void getCurrentWindow().setTitle(title).catch(() => {});
}
