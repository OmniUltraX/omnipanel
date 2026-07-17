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
  return [
    block.status,
    block.exitCode ?? "",
    block.completedAt ?? "",
    block.command.length,
    block.output.length,
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
    void useTerminalHistoryStore.getState().refreshCounts();
  } catch (err) {
    // 写失败则重新标记，下次再试
    for (const id of ids) markDirty(sessionId, id);
    console.warn("[terminal-history] upsert 失败", err);
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

  // 被删除的块
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

  // 会话被清空
  if (prevMap.size > 0 && blocks.length === 0) {
    if (shouldPersistTerminalHistory()) {
      void terminalHistoryRepo.clearSession(sessionId).catch(() => undefined);
    }
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

  return () => {
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
