/**
 * IPC 传输层（Tauri IPC ↔ HTTP/WS 桥的 Web 实现）。
 *
 * 设计：不改任何业务代码，只把 `invoke` / `listen` 的底层传输从 Tauri IPC 换成 HTTP + WebSocket。
 * 浏览器和桌面共用同一套前端产物、同一个 Rust 后端。
 *
 * - `invoke(cmd, args)` → `POST /ipc/invoke`，与 Tauri `invoke` 语义一致（命令错误 reject）。
 * - `listen(event, handler)` → WebSocket 订阅（`/ipc/events`），按 `event` 字段分发。
 * - `Channel` → 请求内联回调（P0 保留 Tauri 语义：Web 端通过事件帧携带 channel id 分发，
 *   尚未接线的命令会走 `invoke` 直连模式）。
 */

import { isTauriRuntime } from "../lib/isTauriRuntime";

/** Web 模式下后端服务地址（同源部署：与静态资源同源，反代到后端）。 */
const WEB_API_BASE = import.meta.env.VITE_OMNIPANEL_API_BASE ?? "";
const WEB_WS_BASE = (() => {
  const base = import.meta.env.VITE_OMNIPANEL_API_BASE ?? "";
  if (base.startsWith("http")) {
    return base.replace(/^http/, "ws");
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${base}`;
})();

/**
 * 发送 IPC 命令。Web 模式下等价于 Tauri `invoke`：
 * - 命令成功（HTTP 200 且 `ok:true`）→ resolve `data`
 * - 命令失败（HTTP 200 且 `ok:false`，或网络错误）→ reject error
 */
export async function webInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const apiKey = import.meta.env.VITE_OMNIPANEL_API_KEY as string | undefined;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  let resp: Response;
  try {
    resp = await fetch(`${WEB_API_BASE}/ipc/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cmd, args: args ?? {} }),
    });
  } catch (e) {
    throw new Error(`IPC 网络错误: ${String(e)}`);
  }
  if (!resp.ok) {
    throw new Error(`IPC HTTP ${resp.status}`);
  }
  const body = (await resp.json()) as { ok: boolean; data?: T; error?: string };
  if (body.ok) {
    return body.data as T;
  }
  const err = new Error(body.error ?? `命令 ${cmd} 执行失败`) as Error & {
    code?: string | null;
    cause?: string | null;
  };
  err.code = null;
  err.cause = null;
  throw err;
}

/* ------------------------------------------------------------------ */
/* WebSocket 事件总线（P0 事件：terminal-output / terminal-event）       */
/* ------------------------------------------------------------------ */

interface WsEventFrame {
  event: string;
  payload: unknown;
}

type EventHandler = (event: { event: string; payload: unknown }) => void;

class WebEventBus {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<EventHandler>>();
  private seq = 0;
  private queue: Array<() => void> = [];

  private connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return this.ws.readyState === WebSocket.OPEN
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            this.ws!.addEventListener("open", () => resolve(), { once: true });
            this.ws!.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
          });
    }

    return new Promise((resolve, reject) => {
      const apiKey = import.meta.env.VITE_OMNIPANEL_API_KEY as string | undefined;
      const url = WEB_WS_BASE.replace(/\/$/, "") + "/ipc/events";
      const ws = new WebSocket(apiKey ? `${url}?token=${encodeURIComponent(apiKey)}` : url);
      this.ws = ws;

      ws.onopen = () => {
        // 处理连接建立前的积压订阅
        const pending = this.queue;
        this.queue = [];
        pending.forEach((fn) => fn());
        resolve();
      };
      ws.onerror = () => {
        reject(new Error("WebSocket 连接失败"));
      };
      ws.onmessage = (ev) => {
        try {
          const frame = JSON.parse(String(ev.data)) as WsEventFrame;
          const set = this.handlers.get(frame.event);
          if (set) {
            set.forEach((h) => {
              try {
                h({ event: frame.event, payload: frame.payload });
              } catch (e) {
                console.error(`[ipc] event handler error (${frame.event}):`, e);
              }
            });
          }
        } catch (e) {
          console.error("[ipc] 解析 WS 事件失败:", e);
        }
      };
      ws.onclose = () => {
        this.ws = null;
      };
    });
  }

  async listen(event: string, handler: EventHandler): Promise<() => void> {
    const id = ++this.seq;
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);

    const doListen = async () => {
      try {
        await this.connect();
      } catch (e) {
        console.error(`[ipc] 订阅 ${event} 失败:`, e);
      }
    };
    if (this.ws?.readyState === WebSocket.OPEN) {
      // 已连接，直接可用
    } else if (this.ws?.readyState === WebSocket.CONNECTING) {
      this.queue.push(doListen);
    } else {
      this.queue.push(doListen);
      void this.connect().catch(() => {});
    }

    return () => {
      const set = this.handlers.get(event);
      if (set) {
        set.delete(handler);
        if (set.size === 0) this.handlers.delete(event);
      }
      void id;
    };
  }
}

const webBus = new WebEventBus();

/** Web 模式下的 `listen`（与 `@tauri-apps/api/event` 同签名）。 */
export async function webListen<T>(
  event: string,
  handler: (event: { event: string; payload: T }) => void,
): Promise<() => void> {
  return webBus.listen(event, handler as EventHandler);
}

/** 是否是 Web（浏览器）运行环境。 */
export function isWebRuntime(): boolean {
  return !isTauriRuntime();
}
