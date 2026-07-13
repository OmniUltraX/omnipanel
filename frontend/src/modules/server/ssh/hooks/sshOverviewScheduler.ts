/**
 * 全局概览轮询调度器。
 *
 * 解决问题：原 useSshOverview / useLocalOverview 每个实例都起一个独立 setInterval，
 * N 个终端连同一主机时会有 N 个定时器叠加，有效刷新频率从 1次/30s 变为 N次/30s。
 *
 * 本调度器按 resourceId 引用计数管理定时器：相同主机的多个面板复用同一定时器，
 * 最后一个面板卸载时才真正 clearInterval。
 *
 * 同时提供 in-flight Promise 去重：并发 load() 共享同一 Promise，避免 N 个面板
 * 同时切 tab 瞬间各发一个 IPC 请求。
 */

type Loader = (opts?: { silent?: boolean; processesOnly?: boolean }) => Promise<void>;

interface PollerEntry {
  refs: number;
  timer: ReturnType<typeof setInterval> | null;
  /** 轮询触发的 load 配置，固定走 silent 模式 */
  intervalMs: number;
  loader: Loader;
  /** 当前正在进行的 load() Promise，用于 in-flight 去重 */
  inflight: Promise<void> | null;
  /** load() 互斥：正在进行 silent load 时跳过新的 silent load */
  silentLoading: boolean;
}

const pollers: Record<string, PollerEntry> = {};

/**
 * 获取或创建某主机的轮询调度器。
 * 相同 resourceId 多次调用只增加 refs，不重复创建定时器。
 */
export function acquireOverviewPoller(
  resourceId: string,
  loader: Loader,
  intervalMs: number,
): void {
  const existing = pollers[resourceId];
  if (existing) {
    existing.refs++;
    // loader 可能因 hook 重建而更新（依赖变化），保留最新引用
    existing.loader = loader;
    // intervalMs 若变化则重启定时器
    if (existing.intervalMs !== intervalMs) {
      restartTimer(existing, resourceId, intervalMs);
    }
    return;
  }
  pollers[resourceId] = {
    refs: 1,
    timer: null,
    intervalMs,
    loader,
    inflight: null,
    silentLoading: false,
  };
  startTimer(pollers[resourceId]!, resourceId);
}

/**
 * 释放一个引用，refs 归零时真正 clearInterval。
 */
export function releaseOverviewPoller(resourceId: string): void {
  const entry = pollers[resourceId];
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    if (entry.timer !== null) {
      clearInterval(entry.timer);
      entry.timer = null;
    }
    delete pollers[resourceId];
  }
}

/**
 * 更新 loader 引用（hook 依赖变化时调用，避免闭包过期）。
 */
export function updateOverviewLoader(
  resourceId: string,
  loader: Loader,
  intervalMs?: number,
): void {
  const entry = pollers[resourceId];
  if (!entry) return;
  entry.loader = loader;
  if (intervalMs !== undefined && intervalMs !== entry.intervalMs) {
    restartTimer(entry, resourceId, intervalMs);
  }
}

/**
 * 手动触发一次 load，in-flight 去重。
 * 同一 resourceId 的并发调用共享同一 Promise。
 *
 * 注意：显式（非 silent）的 load 不会被去重，因为用户可能希望强制刷新。
 */
export function runOverviewLoadDedup(
  resourceId: string,
  opts?: { silent?: boolean; processesOnly?: boolean },
): Promise<void> | null {
  const entry = pollers[resourceId];
  if (!entry) return null;
  // silent 轮询触发时走 in-flight 去重
  if (opts?.silent && !opts.processesOnly) {
    if (entry.silentLoading && entry.inflight) {
      return entry.inflight;
    }
    entry.silentLoading = true;
    entry.inflight = entry
      .loader({ silent: true })
      .finally(() => {
        entry.silentLoading = false;
        entry.inflight = null;
      });
    return entry.inflight;
  }
  // 非静默（用户手动刷新）直接执行，不去重
  return entry.loader(opts);
}

function startTimer(entry: PollerEntry, resourceId: string): void {
  if (entry.timer !== null) return;
  entry.timer = setInterval(() => {
    // 定时器触发走 silent 路径，享受 in-flight 去重
    void runOverviewLoadDedup(resourceId, { silent: true });
  }, entry.intervalMs);
}

function restartTimer(entry: PollerEntry, resourceId: string, intervalMs: number): void {
  if (entry.timer !== null) {
    clearInterval(entry.timer);
  }
  entry.intervalMs = intervalMs;
  startTimer(entry, resourceId);
}
