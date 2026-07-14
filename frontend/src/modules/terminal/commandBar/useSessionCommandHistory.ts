import { useMemo } from "react";
import { EMPTY_TERMINAL_BLOCKS, useBlocksStore } from "../../../stores/blocksStore";
import type { CommandHistoryEntry } from "./commandHistory";
import {
  buildHistoryIndex,
  computeBlocksHistoryKey,
  filterHistoryIndex,
  type IndexedCommandHistoryEntry,
} from "./commandHistoryIndex";
import { EMPTY_READLINE_HISTORY, useSessionShellHistoryStore } from "./sessionShellHistoryStore";
import {
  getSessionHistoryIndexCache,
  invalidateSessionHistoryIndex,
  setSessionHistoryIndexCache,
} from "./historyIndexCache";

export { invalidateSessionHistoryIndex };

function getCachedIndex(
  sessionId: string,
  blockKey: string,
  readlineCommands: string[],
): IndexedCommandHistoryEntry[] {
  const cached = getSessionHistoryIndexCache<IndexedCommandHistoryEntry[]>(sessionId);
  if (
    cached &&
    cached.blockKey === blockKey &&
    cached.readlineRef === readlineCommands
  ) {
    return cached.entries;
  }

  const blocks = useBlocksStore.getState().getBlocks(sessionId);
  const entries = buildHistoryIndex(blocks, readlineCommands);
  setSessionHistoryIndexCache(sessionId, { blockKey, readlineRef: readlineCommands, entries });
  return entries;
}

export function useSessionCommandHistory(
  sessionId: string,
  query: string,
): CommandHistoryEntry[] {
  const blockHistoryKey = useBlocksStore((state) =>
    computeBlocksHistoryKey(state.blocks[sessionId] ?? EMPTY_TERMINAL_BLOCKS),
  );

  const readlineCommands = useSessionShellHistoryStore(
    (state) => state.bySession[sessionId]?.commands ?? EMPTY_READLINE_HISTORY,
  );

  const shellHistorySyncedAt = useSessionShellHistoryStore(
    (state) => state.bySession[sessionId]?.syncedAt ?? 0,
  );

  const index = useMemo(
    () => getCachedIndex(sessionId, blockHistoryKey, readlineCommands),
    [sessionId, blockHistoryKey, readlineCommands, shellHistorySyncedAt],
  );

  return useMemo(() => filterHistoryIndex(index, query), [index, query]);
}

/** 无 React 依赖的同步查询（↑↓ 浏览等） */
export function listSessionCommandHistoryEntriesFast(
  sessionId: string,
  query = "",
): CommandHistoryEntry[] {
  const blocks = useBlocksStore.getState().getBlocks(sessionId);
  const blockKey = computeBlocksHistoryKey(blocks);
  const readline =
    useSessionShellHistoryStore.getState().getCommands(sessionId) ?? EMPTY_READLINE_HISTORY;
  const index = getCachedIndex(sessionId, blockKey, readline);
  return filterHistoryIndex(index, query);
}

export function listSessionCommandHistoryFast(sessionId: string, query = ""): string[] {
  return listSessionCommandHistoryEntriesFast(sessionId, query).map((entry) => entry.text);
}
