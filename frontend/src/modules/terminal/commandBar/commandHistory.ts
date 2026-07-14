import type { CommandHistoryKind } from "./commandHistoryIndex";
import {
  buildHistoryIndex,
  filterHistoryIndex,
} from "./commandHistoryIndex";
import { fuzzyMatchScore } from "./fuzzyMatch";

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

export function filterCompletionLabels<T extends { label: string; description?: string; timestamp?: number }>(
  items: T[],
  query: string,
): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;
  const scored = items
    .map((item) => {
      const haystack = `${item.label} ${item.description ?? ""}`;
      return { item, score: fuzzyMatchScore(normalized, haystack) };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.item.timestamp ?? 0) - (a.item.timestamp ?? 0),
    );
  return scored.map((entry) => entry.item);
}
