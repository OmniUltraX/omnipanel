/**
 * `@tauri-apps/api/window` 的 Web shim（浏览器运行）。
 *
 * Web 单窗口下，窗口 API 退化为最小可用实现：
 * - `getCurrentWindow()` → 返回浏览器 window 的最小代理（`listen`/`once` 转发本地事件，
 *   `onCloseRequested` 为 no-op，避免浏览器弹窗拦截）。
 * - `getAllWindows()` → 返回 `[getCurrentWindow()]`。
 * - `cursorPosition()` → 返回 `{ x: 0, y: 0 }`（桌面拖拽专属，Web 下不调用）。
 */

import { once, listen, type UnlistenFn } from "./event";

export type CloseRequestedEvent = { preventDefault: () => void; isPreventDefault: () => boolean };

/** 最小窗口代理：与 Tauri `Window` 常用 API 签名兼容。 */
class WebWindowProxy {
  readonly label = "main";

  async listen<T>(event: string, handler: (e: { event: string; payload: T }) => void): Promise<UnlistenFn> {
    return listen<T>(event, (e) => handler(e));
  }

  async once<T>(event: string, handler: (e: { event: string; payload: T }) => void): Promise<UnlistenFn> {
    return once<T>(event, (e) => handler(e));
  }

  onCloseRequested(_handler: (event: CloseRequestedEvent) => void): Promise<UnlistenFn> {
    return Promise.resolve(() => {});
  }

  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async minimize(): Promise<void> {}
  async maximize(): Promise<void> {}
  async unmaximize(): Promise<void> {}
  async close(): Promise<void> {}
  async setFocus(): Promise<void> {}
  async setTitle(_title: string): Promise<void> {}
  async setSize(_size: unknown): Promise<void> {}
  async setPosition(_pos: unknown): Promise<void> {}
  async scaleFactor(): Promise<number> {
    return window.devicePixelRatio || 1;
  }
  async innerSize(): Promise<{ width: number; height: number }> {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  async outerSize(): Promise<{ width: number; height: number }> {
    return { width: window.outerWidth, height: window.outerHeight };
  }
}

let current: WebWindowProxy | null = null;

export function getCurrentWindow(): WebWindowProxy {
  if (!current) current = new WebWindowProxy();
  return current;
}

export async function getAllWindows(): Promise<WebWindowProxy[]> {
  return [getCurrentWindow()];
}

export async function cursorPosition(): Promise<{ x: number; y: number }> {
  return { x: 0, y: 0 };
}

/** 显示器信息（Web 下退化为当前窗口所在屏幕）。 */
export interface Monitor {
  name: string | null;
  size: { width: number; height: number };
  position: { x: number; y: number };
  scaleFactor: number;
}

function currentMonitorInfo(): Monitor {
  const screen = window.screen as Screen & { availLeft?: number; availTop?: number };
  return {
    name: null,
    size: { width: screen?.width ?? 1920, height: screen?.height ?? 1080 },
    position: { x: screen?.availLeft ?? 0, y: screen?.availTop ?? 0 },
    scaleFactor: window.devicePixelRatio || 1,
  };
}

export async function currentMonitor(): Promise<Monitor | null> {
  return currentMonitorInfo();
}

export async function primaryMonitor(): Promise<Monitor | null> {
  return currentMonitorInfo();
}

export async function availableMonitors(): Promise<Monitor[]> {
  return [currentMonitorInfo()];
}
