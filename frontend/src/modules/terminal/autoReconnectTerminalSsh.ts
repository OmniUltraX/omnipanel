import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isSshAuthHeld } from "../server/ssh/sshAuthHold";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { reconnectTerminalSession } from "./terminalReconnect";

/** 最大重试次数（含首次），覆盖大部分短暂网络抖动而又不会对挂掉的服务器无限狂打。 */
export const AUTO_RECONNECT_MAX_ATTEMPTS = 5;

/** 指数退避：1s → 2s → 4s → 8s → 16s。 */
const BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000];

export interface AutoReconnectCallbacks {
  /** 一次重连开始执行（在 backoff 等待结束后立即触发） */
  onAttempt?: (attempt: number, maxAttempts: number) => void;
  /** 重连 schedule 成功（开始等待 backoff） */
  onScheduled?: (attempt: number, delayMs: number, maxAttempts: number) => void;
  /** 达到 max attempts 后放弃，写入「请手动重连」提示 */
  onGiveUp?: (maxAttempts: number) => void;
}

/** 重试计数（与 timer 解耦：timer 触发后保留 attempt，等下次 schedule 自然 +1） */
const sessionAttempts = new Map<string, number>();
/** 当前 pending 的 timer 引用，用于 idempotent check / 取消 */
const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>();
let listenerUnlisten: UnlistenFn | null = null;
let statusUnsub: (() => void) | null = null;
let listenerSetupPromise: Promise<void> | null = null;

function isAutoReconnectEnabled(): boolean {
  return useSettingsStore.getState().terminalAutoReconnectSsh !== false;
}

function isSessionLive(sessionId: string): boolean {
  const tabs = useTerminalStore.getState().tabs;
  return tabs.some((tab) => tab.sessionId === sessionId);
}

function runReconnect(sessionId: string): void {
  reconnectTerminalSession(sessionId);
}

function scheduleNext(sessionId: string, callbacks: AutoReconnectCallbacks): void {
  const attempt = (sessionAttempts.get(sessionId) ?? 0) + 1;

  if (attempt > AUTO_RECONNECT_MAX_ATTEMPTS) {
    sessionAttempts.delete(sessionId);
    sessionTimers.delete(sessionId);
    useTerminalStore.getState().setStatus(sessionId, "disconnected");
    callbacks.onGiveUp?.(AUTO_RECONNECT_MAX_ATTEMPTS);
    return;
  }

  // 防御性：清掉已存在的 timer（正常情况不会触发）
  const prevTimer = sessionTimers.get(sessionId);
  if (prevTimer) {
    clearTimeout(prevTimer);
    sessionTimers.delete(sessionId);
  }

  const delayMs = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
  callbacks.onScheduled?.(attempt, delayMs, AUTO_RECONNECT_MAX_ATTEMPTS);

  const timer = setTimeout(() => {
    sessionTimers.delete(sessionId);
    if (!isSessionLive(sessionId)) {
      // 用户在 backoff 等待期间关闭了 tab — 清 attempt 计数并放弃
      sessionAttempts.delete(sessionId);
      return;
    }
    callbacks.onAttempt?.(attempt, AUTO_RECONNECT_MAX_ATTEMPTS);
    runReconnect(sessionId);
  }, delayMs);

  sessionAttempts.set(sessionId, attempt);
  sessionTimers.set(sessionId, timer);
}

/**
 * 调度一次 SSH 自动重连。
 * - 已有 pending 重连时为 no-op
 * - 用户已关闭该 tab 时为 no-op
 * - 设置关闭时为 no-op
 * 返回是否成功 schedule。
 */
export function scheduleAutoReconnectSsh(
  sessionId: string,
  callbacks?: AutoReconnectCallbacks,
): boolean {
  if (!isAutoReconnectEnabled()) return false;
  if (sessionTimers.has(sessionId)) return false;
  if (!isSessionLive(sessionId)) return false;
  const resourceId = useTerminalStore
    .getState()
    .tabs.find((item) => item.sessionId === sessionId)?.session?.resourceId;
  if (isSshAuthHeld(resourceId)) return false;
  scheduleNext(sessionId, callbacks ?? {});
  return true;
}

/** 取消 pending 中的重连（用户主动 close tab / 手动 reconnect / 切换设置时调用） */
export function cancelAutoReconnectSsh(sessionId: string): void {
  const timer = sessionTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    sessionTimers.delete(sessionId);
  }
  sessionAttempts.delete(sessionId);
}

/** 当前 attempt（0 表示没有 active 重连），用于 UI 显示。 */
export function getAutoReconnectAttempt(sessionId: string): number {
  return sessionAttempts.get(sessionId) ?? 0;
}

/** 是否运行在真实的 Tauri 宿主里（jsdom / 浏览器 Web 版没有 __TAURI_INTERNALS__）。 */
function isTauriEventHostAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 循环依赖（terminalStore → assistant → … → 本模块）会让模块加载期的
 * `useTerminalStore` 取到 undefined，安全探测一次；TDZ 下 typeof 也会抛，一并兜住。
 */
function peekTerminalStore(): typeof useTerminalStore | null {
  try {
    return typeof useTerminalStore?.subscribe === "function" ? useTerminalStore : null;
  } catch {
    return null;
  }
}

/** 等到 store 就绪再订阅，避免模块加载期拿到 undefined 而永久丢掉状态订阅。 */
async function subscribeStatusWhenReady(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const store = peekTerminalStore();
    if (store) {
      // 监听 store 状态：reconnect 成功（status -> connected）后清掉 attempt 计数。
      // 如果不监听，连续两次 exit 都会从 attempt 1 重新开始，而不是 1 -> 2 -> 3。
      statusUnsub = store.subscribe((state) => {
        for (const sessionId of sessionTimers.keys()) {
          const tab = state.tabs.find((t) => t.sessionId === sessionId);
          if (tab?.status === "connected") {
            cancelAutoReconnectSsh(sessionId);
          }
        }
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("useTerminalStore 未就绪，跳过重连状态订阅");
}

async function setupListener(): Promise<void> {
  if (listenerSetupPromise) return listenerSetupPromise;
  listenerSetupPromise = (async () => {
    // listen 保持同步发起，维持「模块加载即注册」的语义。
    const listenPromise = listen<{ session_id: string; event: string }>(
      "terminal-event",
      (ev) => {
        if (ev.payload.event !== "exited") return;
        scheduleAutoReconnectSsh(ev.payload.session_id);
      },
    ).then((unlisten) => {
      listenerUnlisten = unlisten;
    });
    // 关键：先给 listenPromise 挂一个 handler。若下方订阅失败提前退出，
    // 这个 rejected promise 就再没人接管，会变成 unhandled rejection 拖红整个测试套件。
    void listenPromise.catch(() => undefined);

    await subscribeStatusWhenReady();
    await listenPromise;
  })().catch((err) => {
    // 监听建立失败不应让模块加载炸掉：非 Tauri 宿主（jsdom 测试、浏览器 Web 版）
    // 里 listen() 本身就不可用，属预期情况，静默即可。
    if (isTauriEventHostAvailable()) {
      console.warn("[autoReconnectSsh] 事件监听建立失败，SSH 自动重连不可用：", err);
    }
    // 置空以便后续重试
    listenerSetupPromise = null;
  });
  return listenerSetupPromise;
}

void setupListener();

/** 测试 / 卸载时清理 listener */
export function disposeAutoReconnectSshListener(): void {
  if (listenerUnlisten) {
    listenerUnlisten();
    listenerUnlisten = null;
  }
  if (statusUnsub) {
    statusUnsub();
    statusUnsub = null;
  }
  for (const sessionId of [...sessionTimers.keys()]) {
    cancelAutoReconnectSsh(sessionId);
  }
  listenerSetupPromise = null;
}
