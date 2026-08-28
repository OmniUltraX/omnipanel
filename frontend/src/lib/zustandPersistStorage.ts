import type { StateStorage } from "zustand/middleware";
import { wrapTeamScopedStorage } from "./teamPersist";

/**
 * 包装 localStorage 为 zustand persist 的 StateStorage，提供：
 *
 * 1. 同步 getItem —— 保持启动 hydration 行为不变（与原生 localStorage 一致）
 * 2. 防抖合流 setItem —— 同一 microtask 内多次 set 只触发一次实际写入
 * 3. 错误吞并 —— 配额超限 / 隐私模式等异常不抛出，避免阻断 store 状态更新
 *
 * 背景：terminalStore 中的 setStatus / setBackendSessionId / setTerminal 等
 * 高频运行时状态变更会触发 persist 中间件同步 setItem。在多 tab / 多 session
 * 场景下，连续写入会迅速逼近 localStorage 5MB 配额，触发 QuotaExceededError
 * 冒泡到 ensureBackendSession / initTerminal，导致终端初始化崩溃。
 *
 * 此 wrapper 不改变持久化语义（仍写入 localStorage），仅优化写入频率与错误处理。
 * pendingWrites 为模块级共享，多个 store 的写入会合流到同一次 flush，进一步
 * 减少 localStorage 往返次数。
 */
interface PendingWrite {
  value: string;
}

const pendingWrites = new Map<string, PendingWrite>();
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flushPendingWrites);
}

function flushPendingWrites(): void {
  flushScheduled = false;
  if (pendingWrites.size === 0) return;
  const entries = Array.from(pendingWrites.entries());
  pendingWrites.clear();
  for (const [key, { value }] of entries) {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      // 配额超限或隐私模式：不抛出，避免阻断 store 状态更新。
      // 内存中的状态始终是最新的，仅丢失本次持久化镜像。
      // 限频打印避免刷屏（每 key 每分钟最多一次 warn）。
      logQuotaErrorThrottled(key, err);
    }
  }
}

const lastWarnAt = new Map<string, number>();
const WARN_THROTTLE_MS = 60_000;

function logQuotaErrorThrottled(key: string, err: unknown): void {
  const now = Date.now();
  const last = lastWarnAt.get(key) ?? 0;
  if (now - last < WARN_THROTTLE_MS) return;
  lastWarnAt.set(key, now);
  console.warn(
    `[persist] localStorage.setItem(${JSON.stringify(key)}) failed; ` +
      `in-memory state preserved but persistence skipped. ` +
      `Consider migrating this store to createIndexedDBStorage for large payloads.`,
    err,
  );
}

export function createSafeLocalStorage(): StateStorage {
  return wrapTeamScopedStorage({
    getItem(name: string): string | null {
      try {
        return localStorage.getItem(name);
      } catch {
        return null;
      }
    },
    setItem(name: string, value: string): void {
      pendingWrites.set(name, { value });
      scheduleFlush();
    },
    removeItem(name: string): void {
      // 取消可能 pending 的写入，再同步删除
      pendingWrites.delete(name);
      try {
        localStorage.removeItem(name);
      } catch {
        // ignore
      }
    },
  });
}
