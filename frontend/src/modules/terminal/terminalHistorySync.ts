import { syncBlockCounterFromIds, useBlocksStore } from "../../stores/blocksStore";
import { useTerminalHistoryStore } from "../../stores/terminalHistoryStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { computeBlocksHistoryKey } from "./commandBar/commandHistoryIndex";

const SYNC_DEBOUNCE_MS = 800;
const sessionSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
const sessionHistoryKeys = new Map<string, string>();

let blocksSubscription: (() => void) | null = null;

function scheduleSessionSync(sessionId: string): void {
  const existing = sessionSyncTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  sessionSyncTimers.set(
    sessionId,
    setTimeout(() => {
      sessionSyncTimers.delete(sessionId);
      const blocks = useBlocksStore.getState().getBlocks(sessionId);
      useTerminalHistoryStore.getState().syncSession(sessionId, blocks);
    }, SYNC_DEBOUNCE_MS),
  );
}

export function startTerminalHistorySync(): () => void {
  if (blocksSubscription) return () => undefined;

  blocksSubscription = useBlocksStore.subscribe((state, prevState) => {
    const sessionIds = new Set([
      ...Object.keys(state.blocks),
      ...Object.keys(prevState.blocks),
    ]);
    for (const sessionId of sessionIds) {
      const blocks = state.blocks[sessionId] ?? [];
      const key = computeBlocksHistoryKey(blocks);
      if (sessionHistoryKeys.get(sessionId) === key) continue;
      sessionHistoryKeys.set(sessionId, key);
      scheduleSessionSync(sessionId);
    }
  });

  return () => {
    if (blocksSubscription) {
      blocksSubscription();
      blocksSubscription = null;
    }
    for (const timer of sessionSyncTimers.values()) {
      clearTimeout(timer);
    }
    sessionSyncTimers.clear();
    sessionHistoryKeys.clear();
  };
}

function restoreHistoryForSessions(sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  useTerminalHistoryStore.getState().restoreAllKnownSessions(sessionIds);
  const restoredBlocks = sessionIds.flatMap((sessionId) =>
    useBlocksStore.getState().getBlocks(sessionId),
  );
  syncBlockCounterFromIds(restoredBlocks);
  for (const sessionId of sessionIds) {
    const blocks = useBlocksStore.getState().getBlocks(sessionId);
    sessionHistoryKeys.set(sessionId, computeBlocksHistoryKey(blocks));
  }
}

function scheduleIdleHistoryRestore(sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  let index = 0;
  const step = () => {
    if (index >= sessionIds.length) return;
    restoreHistoryForSessions([sessionIds[index++]]);
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(step, { timeout: 1500 });
    } else {
      window.setTimeout(step, 32);
    }
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(step, { timeout: 2000 });
  } else {
    window.setTimeout(step, 100);
  }
}

/** 优先恢复当前会话历史，其余会话空闲时再灌入，避免进终端时同步卡死主线程 */
export function bootstrapTerminalHistory(sessionIds: string[]): void {
  const run = () => {
    const uniqueIds = [...new Set(sessionIds.filter(Boolean))];
    if (uniqueIds.length === 0) return;

    const activeSessionId = useTerminalStore.getState().activeSessionId;
    const activeTabId = useTerminalStore.getState().activeTabId;
    const preferredId =
      (activeSessionId && uniqueIds.includes(activeSessionId) ? activeSessionId : null) ??
      (activeTabId && uniqueIds.includes(activeTabId) ? activeTabId : null) ??
      uniqueIds[0];

    restoreHistoryForSessions([preferredId]);
    scheduleIdleHistoryRestore(uniqueIds.filter((id) => id !== preferredId));
  };

  if (useTerminalHistoryStore.persist.hasHydrated()) {
    run();
    return;
  }

  useTerminalHistoryStore.persist.onFinishHydration(run);
}
