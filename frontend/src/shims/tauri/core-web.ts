/**
 * `@tauri-apps/api/core` 的 Web shim（浏览器运行，经 vite alias 注入）。
 *
 * - `invoke` → `POST /ipc/invoke`（等价 Tauri invoke 语义：成功 resolve data，失败 reject）。
 * - `Channel` → Web 端事件流走 `/ipc/events` WS。后端把 Channel 回调帧以
 *   `{ event: "@channel", payload: { channelId, payload } }` 广播，本类按 id 分发。
 * - `convertFileSrc` → 浏览器直接返回原路径（无 asset 协议）。
 */

import { webInvoke } from "../../ipc/transport";
import { webListen } from "../../ipc/transport";

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return webInvoke<T>(cmd, args ?? {});
}

interface ChannelFrame {
  channelId: string;
  payload: unknown;
}

/**
 * Channel（Tauri IPC 回调通道的 Web 实现）。
 * 构造后即向 WS 事件总线注册按 id 分发；后端 `emit_channel` 帧到达时调用 `onmessage`。
 */
export class Channel<T = unknown> {
  id: number;
  private static seq = 0;
  private _onmessage: ((response: T) => void) | null = null;

  constructor(onmessage?: (response: T) => void) {
    this.id = ++Channel.seq;
    if (onmessage) this._onmessage = onmessage;
    const channelId = String(this.id);
    // 注册 WS 分发；失败（未连接）时静默，命令本身会报错。
    void webListen<ChannelFrame>("@channel", (event) => {
      const frame = event.payload;
      if (frame && String(frame.channelId) === channelId) {
        try {
          this._onmessage?.(frame.payload as T);
        } catch (e) {
          console.error(`[ipc] channel ${channelId} handler error:`, e);
        }
      }
    });
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
