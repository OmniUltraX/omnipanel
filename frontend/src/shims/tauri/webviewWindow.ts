/**
 * `@tauri-apps/api/webviewWindow` 的 Web shim（浏览器运行）。
 *
 * Web 单窗口下无多窗口：`getCurrentWebviewWindow()` 返回主窗口代理，
 * `getAllWebviewWindows()` 返回 `[主窗口]`，`WebviewWindow` 类构造为 no-op（返回主窗口代理）。
 */

import { getCurrentWindow } from "./window";

export class WebviewWindow {
  readonly label: string;
  readonly __proxy: ReturnType<typeof getCurrentWindow>;

  constructor(label?: string, _options?: unknown) {
    this.label = label ?? "main";
    this.__proxy = getCurrentWindow();
  }

  get __tauriWindow__() {
    return this.__proxy;
  }

  async listen<T>(event: string, handler: (e: { event: string; payload: T }) => void) {
    return this.__proxy.listen(event, handler);
  }

  async once<T>(event: string, handler: (e: { event: string; payload: T }) => void) {
    return this.__proxy.once(event, handler);
  }

  async close(): Promise<void> {}
  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async setFocus(): Promise<void> {}
}

export function getCurrentWebviewWindow(): WebviewWindow {
  return new WebviewWindow("main");
}

export async function getAllWebviewWindows(): Promise<WebviewWindow[]> {
  return [getCurrentWebviewWindow()];
}
