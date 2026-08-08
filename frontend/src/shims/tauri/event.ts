/**
 * `@tauri-apps/api/event` 的 Web shim（浏览器运行）。
 *
 * - `listen` → WebSocket 订阅 `/ipc/events`（事件名即 topic，与 Tauri `listen` 语义一致）。
 * - `emit` / `emitTo` → Web 端为同源浏览器内广播（`window.dispatchEvent`），
 *   桌面端专属的跨窗口事件在 Web 单窗口下退化为本地派发。
 */

import { webListen } from "../../ipc/transport";

export type UnlistenFn = () => void;

export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}

export type EventCallback<T> = (event: Event<T>) => void;

/** 浏览器本地事件派发（替代 Tauri 跨窗口 emit）。 */
function emitLocal<T>(event: string, payload: T): void {
  window.dispatchEvent(
    new CustomEvent(`omnipanel:${event}`, { detail: payload }),
  );
}

export async function listen<T>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  return webListen<T>(event, (ev) => {
    handler({ event: ev.event, id: 0, payload: ev.payload as T });
  });
}

export async function once<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const unlisten = await listen<T>(event, (ev) => {
    unlisten();
    handler(ev);
  });
  return unlisten;
}

export async function emit<T>(event: string, payload?: T): Promise<void> {
  emitLocal(event, payload);
}

export async function emitTo<T>(target: string, event: string, payload?: T): Promise<void> {
  emitLocal(`${target}:${event}`, payload);
}
