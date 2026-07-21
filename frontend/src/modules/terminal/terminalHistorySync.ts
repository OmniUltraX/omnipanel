import {
  syncBlockCounterFromIds,
  useBlocksStore,
  type TerminalBlock,
} from "../../stores/blocksStore";
import { useTerminalHistoryStore } from "../../stores/terminalHistoryStore";
import { useTerminalStore } from "../../stores/terminalStore";
import {
  shouldPersistTerminalHistory,
  terminalHistoryRepo,
} from "./terminalHistoryRepo";

/** 运行中（含 AI 流式）防抖写盘 */
const RUNNING_FLUSH_MS = 2500;
/** 创建 / 终态 短防抖 */
const LIFECYCLE_FLUSH_MS = 300;

const dirtyBlockIds = new Map<string, Set<string>>();
const sessionFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const sessionFlushDelay = new Map<string, number>();
/** 已见过的块快照（用于检测删除与状态变化） */
const knownBlocks = new Map<string, Map<string, string>>();

let blocksSubscription: (() => void) | null = null;
let migrating: Promise<void> | null = null;

function blockFingerprint(block: TerminalBlock): string {
  const liveLen = block.liveOutput
    ? block.liveOutput.lines.reduce((n, line) => n + line.length, 0) +
      block.liveOutput.currentLine.length
    : 0;
  return [
    block.status,
    block.exitCode ?? "",
    block.completedAt ?? "",
    block.command.length,
    block.output.length,
    liveLen,
    block.reasoning?.length ?? 0,
    block.aiThread?.length ?? 0,
    block.title ?? "",
    block.aiStalled ? "1" : "0",
  ].join("|");
}

/** 冷启动灌入后调用，避免把恢复的块当成 dirty 再写一遍 */
export function noteRestoredSessionBlocks(sessionId: string, blocks: TerminalBlock[]): void {
  const map = new Map<string, string>();
  for (const block of blocks) {
    map.set(block.id, blockFingerprint(block));
  }
  knownBlocks.set(sessionId, map);
  dirtyBlockIds.delete(sessionId);
  const timer = sessionFlushTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    sessionFlushTimers.delete(sessionId);
    sessionFlushDelay.delete(sessionId);
  }
}

function markDirty(sessionId: string, blockId: string): void {
  let set = dirtyBlockIds.get(sessionId);
  if (!set) {
    set = new Set();
    dirtyBlockIds.set(sessionId, set);
  }
  set.add(blockId);
}

function scheduleFlush(sessionId: string, delayMs: number): void {
  const existingDelay = sessionFlushDelay.get(sessionId);
  // 已有更短延迟的定时器则不拉长；有更长的则重置为更短
  if (existingDelay != null && existingDelay <= delayMs && sessionFlushTimers.has(sessionId)) {
    return;
  }
  const existing = sessionFlushTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  sessionFlushDelay.set(sessionId, delayMs);
  sessionFlushTimers.set(
    sessionId,
    setTimeout(() => {
      sessionFlushTimers.delete(sessionId);
      sessionFlushDelay.delete(sessionId);
      void flushSession(sessionId);
    }, delayMs),
  );
}

async function flushSession(sessionId: string): Promise<void> {
  if (!shouldPersistTerminalHistory() || !sessionId) {
    dirtyBlockIds.delete(sessionId);
    return;
  }
  const dirty = dirtyBlockIds.get(sessionId);
  if (!dirty?.size) return;
  const ids = [...dirty];
  dirtyBlockIds.delete(sessionId);

  const blocks = useBlocksStore.getState().getBlocks(sessionId);
  const toWrite = blocks.filter((b) => ids.includes(b.id));
  if (toWrite.length === 0) return;

  try {
    await terminalHistoryRepo.upsertBlocks(sessionId, toWrite);
    useTerminalHistoryStore.getState().cacheSessionBlocks(sessionId, blocks);
    noteRestoredSessionBlocks(sessionId, blocks);
    void useTerminalHistoryStore.getState().refreshCounts();
  } catch (err) {
    // 写失败则重新标记，下次再试
    for (const id of ids) markDirty(sessionId, id);
    scheduleFlush(sessionId, LIFECYCLE_FLUSH_MS);
    console.warn("[terminal-history] upsert 失败", err);
  }
}

function cancelScheduledFlush(sessionId: string): void {
  const timer = sessionFlushTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  sessionFlushTimers.delete(sessionId);
  sessionFlushDelay.delete(sessionId);
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

const lastForceFlushAt = new Map<string, number>();
const FORCE_FLUSH_DEDUP_MS = 2_000;

/**
 * 跨窗口转移前强制落盘：取消防抖，把可持久化块一次性 upsert。
 * 写盘前让出一帧，减轻拖拽/关窗时的主线程卡顿。
 * 短时间内重复调用且无脏块则跳过，避免 handoff 批量二次写。
 */
export async function flushSessionNow(sessionId: string): Promise<void> {
  if (!shouldPersistTerminalHistory() || !sessionId) {
    dirtyBlockIds.delete(sessionId);
    return;
  }
  cancelScheduledFlush(sessionId);

  const dirty = dirtyBlockIds.get(sessionId);
  const lastAt = lastForceFlushAt.get(sessionId) ?? 0;
  if (!dirty?.size && Date.now() - lastAt < FORCE_FLUSH_DEDUP_MS) {
    return;
  }

  const blocks = useBlocksStore.getState().getBlocks(sessionId);
  const toWrite = blocks.filter(
    (b) => b.command.trim().length > 0 || b.kind === "ai",
  );
  dirtyBlockIds.delete(sessionId);
  if (toWrite.length === 0) {
    lastForceFlushAt.set(sessionId, Date.now());
    return;
  }

  await yieldToUi();
  try {
    await terminalHistoryRepo.upsertBlocks(sessionId, toWrite);
    useTerminalHistoryStore.getState().cacheSessionBlocks(sessionId, blocks);
    noteRestoredSessionBlocks(sessionId, blocks);
    lastForceFlushAt.set(sessionId, Date.now());
  } catch (err) {
    for (const b of toWrite) markDirty(sessionId, b.id);
    console.warn("[terminal-history] 强制 flush 失败", err);
  }
}

function reconcileSession(sessionId: string, blocks: TerminalBlock[]): void {
  const prevMap = knownBlocks.get(sessionId) ?? new Map<string, string>();
  const nextMap = new Map<string, string>();
  const prevIds = new Set(prevMap.keys());
  let needsRunningFlush = false;
  let needsLifecycleFlush = false;

  for (const block of blocks) {
    const fp = blockFingerprint(block);
    nextMap.set(block.id, fp);
    const prevFp = prevMap.get(block.id);
    if (prevFp === fp) {
      prevIds.delete(block.id);
      continue;
    }
    markDirty(sessionId, block.id);
    if (block.status === "running") {
      needsRunningFlush = true;
    } else {
      needsLifecycleFlush = true;
    }
    prevIds.delete(block.id);
  }

  // 被删除的块：仅「部分删除」时写库。
  // 整会话内存清空时禁止在此删 SQLite——否则短暂空态 / StrictMode 会误清已落盘历史。
  // 用户「清除全部」走 clearAllSessionBlocks → historyStore.clearSession。
  const sessionEmptied = prevMap.size > 0 && blocks.length === 0;
  if (!sessionEmptied) {
    for (const removedId of prevIds) {
      if (shouldPersistTerminalHistory()) {
        void terminalHistoryRepo.removeBlock(sessionId, removedId).catch(() => undefined);
      }
      const cached = useTerminalHistoryStore.getState().bySession[sessionId];
      if (cached) {
        useTerminalHistoryStore.setState((state) => ({
          bySession: {
            ...state.bySession,
            [sessionId]: (state.bySession[sessionId] ?? []).filter((b) => b.id !== removedId),
          },
        }));
      }
    }
  } else {
    useTerminalHistoryStore.setState((state) => {
      const next = { ...state.bySession };
      delete next[sessionId];
      return { bySession: next };
    });
  }

  knownBlocks.set(sessionId, nextMap);

  if (needsLifecycleFlush) {
    scheduleFlush(sessionId, LIFECYCLE_FLUSH_MS);
  } else if (needsRunningFlush) {
    scheduleFlush(sessionId, RUNNING_FLUSH_MS);
  }
}

export function startTerminalHistorySync(): () => void {
  if (blocksSubscription) return () => undefined;

  void ensureHistoryMigrated();

  blocksSubscription = useBlocksStore.subscribe((state, prevState) => {
    const sessionIds = new Set([
      ...Object.keys(state.blocks),
      ...Object.keys(prevState.blocks),
    ]);
    for (const sessionId of sessionIds) {
      const blocks = state.blocks[sessionId] ?? [];
      reconcileSession(sessionId, blocks);
    }
  });

  // 订阅不会回放当前快照：启动时把已有块纳入 known/dirty，避免 StrictMode 重挂后漏写
  seedExistingBlocks();

  const onPageHide = () => {
    void flushAllSessionsNow();
  };
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("beforeunload", onPageHide);

  return () => {
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("beforeunload", onPageHide);
    // 停订阅前尽量落盘，避免 React StrictMode / 热更新丢掉防抖中的脏块
    void flushAllSessionsNow();
    if (blocksSubscription) {
      blocksSubscription();
      blocksSubscription = null;
    }
    for (const timer of sessionFlushTimers.values()) {
      clearTimeout(timer);
    }
    sessionFlushTimers.clear();
    sessionFlushDelay.clear();
    dirtyBlockIds.clear();
    knownBlocks.clear();
  };
}

/** 将 store 中已有会话块登记为 dirty 并调度 flush（不预写 known，交给 flush/reconcile） */
function seedExistingBlocks(): void {
  const all = useBlocksStore.getState().blocks;
  for (const [sessionId, blocks] of Object.entries(all)) {
    if (!blocks?.length) continue;
    if (knownBlocks.has(sessionId)) continue;
    for (const block of blocks) {
      markDirty(sessionId, block.id);
    }
    const hasRunning = blocks.some((b) => b.status === "running");
    scheduleFlush(sessionId, hasRunning ? RUNNING_FLUSH_MS : LIFECYCLE_FLUSH_MS);
  }
}

/** 强制刷新所有有脏块或内存中可持久化块的会话（退出 / F5 / 停同步前） */
export async function flushAllSessionsNow(): Promise<void> {
  const sessionIds = new Set<string>([
    ...dirtyBlockIds.keys(),
    ...Object.keys(useBlocksStore.getState().blocks),
  ]);
  for (const sessionId of sessionIds) {
    await flushSessionNow(sessionId);
  }
}

function ensureHistoryMigrated(): Promise<void> {
  if (!migrating) {
    migrating = (async () => {
      await useTerminalHistoryStore.getState().migrateFromLocalStorageIfNeeded();
      await useTerminalHistoryStore.getState().refreshCounts();
    })();
  }
  return migrating;
}

async function restoreHistoryForSessions(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  await useTerminalHistoryStore.getState().restoreAllKnownSessions(sessionIds);
  const restoredBlocks = sessionIds.flatMap((sessionId) =>
    useBlocksStore.getState().getBlocks(sessionId),
  );
  syncBlockCounterFromIds(restoredBlocks);
  for (const sessionId of sessionIds) {
    const blocks = useBlocksStore.getState().getBlocks(sessionId);
    noteRestoredSessionBlocks(sessionId, blocks);
  }
}

function scheduleIdleHistoryRestore(sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  let index = 0;
  const step = () => {
    if (index >= sessionIds.length) return;
    void restoreHistoryForSessions([sessionIds[index++]]).then(() => {
      if (index >= sessionIds.length) return;
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(step, { timeout: 1500 });
      } else {
        window.setTimeout(step, 32);
      }
    });
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(step, { timeout: 2000 });
  } else {
    window.setTimeout(step, 100);
  }
}

/** 优先恢复当前会话历史，其余会话空闲时再灌入 */
export function bootstrapTerminalHistory(sessionIds: string[]): void {
  void (async () => {
    await ensureHistoryMigrated();
    const uniqueIds = [...new Set(sessionIds.filter(Boolean))];
    if (uniqueIds.length === 0) return;

    const activeSessionId = useTerminalStore.getState().activeSessionId;
    const activeTabId = useTerminalStore.getState().activeTabId;
    const preferredId =
      (activeSessionId && uniqueIds.includes(activeSessionId) ? activeSessionId : null) ??
      (activeTabId && uniqueIds.includes(activeTabId) ? activeTabId : null) ??
      uniqueIds[0];

    await restoreHistoryForSessions([preferredId]);
    scheduleIdleHistoryRestore(uniqueIds.filter((id) => id !== preferredId));
  })();
}
