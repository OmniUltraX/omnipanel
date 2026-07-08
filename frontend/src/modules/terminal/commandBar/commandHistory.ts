import type { CommandHistoryKind } from "./commandHistoryIndex";
import {
  buildHistoryIndex,
  filterHistoryIndex,
} from "./commandHistoryIndex";

export type { CommandHistoryKind };
export type CommandHistoryEntry = {
  text: string;
  kind: CommandHistoryKind;
  timestamp: number;
};

export {
  HISTORY_PANEL_DISPLAY_LIMIT,
  HISTORY_SEARCH_DISPLAY_LIMIT,
  buildHistoryIndex,
  filterHistoryIndex,
  computeBlocksHistoryKey,
} from "./commandHistoryIndex";

export function listCommandHistoryFromBlocks(
  blocks: Parameters<typeof buildHistoryIndex>[0],
  readlineCommands: string[],
  query = "",
): CommandHistoryEntry[] {
  const index = buildHistoryIndex(blocks, readlineCommands);
  return filterHistoryIndex(index, query);
}

export function filterCompletionLabels<T extends { label: string; description?: string }>(
  items: T[],
  query: string,
): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;
  return items.filter((item) => {
    const haystack = `${item.label} ${item.description ?? ""}`.toLowerCase();
    return haystack.includes(normalized);
  });
}
