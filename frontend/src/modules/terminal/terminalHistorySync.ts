import { syncBlockCounterFromIds, useBlocksStore } from "../../stores/blocksStore";
import { useTerminalHistoryStore } from "../../stores/terminalHistoryStore";
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

export function bootstrapTerminalHistory(sessionIds: string[]): void {
  const run = () => {
    useTerminalHistoryStore.getState().restoreAllKnownSessions(sessionIds);
    const restoredBlocks = sessionIds.flatMap((sessionId) =>
      useBlocksStore.getState().getBlocks(sessionId),
    );
    syncBlockCounterFromIds(restoredBlocks);
    for (const sessionId of sessionIds) {
      const blocks = useBlocksStore.getState().getBlocks(sessionId);
      sessionHistoryKeys.set(sessionId, computeBlocksHistoryKey(blocks));
    }
  };

  if (useTerminalHistoryStore.persist.hasHydrated()) {
    run();
    return;
  }

  useTerminalHistoryStore.persist.onFinishHydration(run);
}
