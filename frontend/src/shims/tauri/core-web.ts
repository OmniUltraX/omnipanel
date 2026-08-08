/**
 * `@tauri-apps/api/core` 的 Web shim（浏览器运行，经 vite alias 注入）。
 *
 * - `invoke` → `POST /ipc/invoke`（等价 Tauri invoke 语义：成功 resolve data，失败 reject）。
 * - `Channel` → Web 端事件流走 `/ipc/events` WS；Channel 用于单次 invoke 绑定的回调
 *   （`ai_chat_stream` 等暂未在 omnipanel-server 接线，保留构造/回调能力以便后续接入）。
 * - `convertFileSrc` → 浏览器直接返回原路径（无 asset 协议）。
 */

import { webInvoke } from "../../ipc/transport";

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return webInvoke<T>(cmd, args ?? {});
}

/**
 * Channel（Tauri IPC 回调通道的 Web 占位）。
 * Web 模式下通道 id 为客户端自增 id；后端事件帧携带 `channel_id` 时分发到对应回调。
 */
export class Channel<T = unknown> {
  id: number;
  private static seq = 0;
  private _onmessage: ((response: T) => void) | null = null;

  constructor(onmessage?: (response: T) => void) {
    this.id = ++Channel.seq;
    if (onmessage) this._onmessage = onmessage;
  }

  set onmessage(handler: (response: T) => void) {
    this._onmessage = handler;
  }

  get onmessage(): (response: T) => void {
    return this._onmessage ?? (() => {});
  }

  /** Tauri 序列化钩子：Web 端返回通道 id 字符串。 */
  [Symbol.for("__TAURI_TO_IPC_KEY__")](): string {
    return String(this.id);
  }

  toJSON(): string {
    return String(this.id);
  }
}

export function convertFileSrc(filePath: string, _protocol?: string): string {
  // 浏览器无 asset 协议，返回原路径（远程文件走 URL 直链）。
  return filePath;
}

/** Tauri `Resource` 的 Web 占位（plugin-fs 等依赖 core 的 Resource 类型）。 */
export class Resource {
  #rid: number;
  constructor(rid: number) {
    this.#rid = rid;
  }
  get rid(): number {
    return this.#rid;
  }
  async close(): Promise<void> {}
}
