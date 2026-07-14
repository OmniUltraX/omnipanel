import type { TerminalBlock } from "../../stores/blocksStore";
import { isAiThreadMessage } from "../../stores/blocksStore";
import { getResolvedAiThread } from "./aiThreadBridge";
import { extractCommandOutput, normalizeBlockCommand } from "./terminalOutputText";

export type FeedKindFilter = "all" | "shell" | "ai";

export type FeedSearchFilters = {
  query: string;
  kind: FeedKindFilter;
  failedOnly: boolean;
};

export const DEFAULT_FEED_SEARCH_FILTERS: FeedSearchFilters = {
  query: "",
  kind: "all",
  failedOnly: false,
};

export function isFeedBlockFailed(block: TerminalBlock): boolean {
  return block.status === "failed" || (block.exitCode !== null && block.exitCode !== 0);
}

function blockSearchLabel(block: TerminalBlock): string {
  if (block.kind === "ai") {
    return block.title?.trim() || block.command.trim() || "AI";
  }
  return normalizeBlockCommand(block.command).trim();
}

function blockSearchOutput(block: TerminalBlock): string {
  if (block.kind === "ai") {
    const thread = getResolvedAiThread(block);
    const parts: string[] = [];
    for (const item of thread) {
      if (isAiThreadMessage(item)) {
        const text = item.content.trim() || item.reasoning?.trim();
        if (text) parts.push(text);
      }
    }
    return parts.join("\n");
  }
  const cleaned = extractCommandOutput(block.output, block.command);
  return (cleaned || block.output).trim();
}

export function buildFeedBlockHaystack(block: TerminalBlock): string {
  return `${blockSearchLabel(block)} ${blockSearchOutput(block)} ${block.cwd ?? ""}`.toLowerCase();
}

export function isFeedSearchFiltering(filters: FeedSearchFilters): boolean {
  return Boolean(filters.query.trim()) || filters.kind !== "all" || filters.failedOnly;
}

export function feedBlockMatchesSearch(block: TerminalBlock, filters: FeedSearchFilters): boolean {
  if (filters.kind === "shell" && block.kind !== "shell") return false;
  if (filters.kind === "ai" && block.kind !== "ai") return false;
  if (filters.failedOnly && !isFeedBlockFailed(block)) return false;
  const query = filters.query.trim().toLowerCase();
  if (!query) return true;
  return buildFeedBlockHaystack(block).includes(query);
}

export function listFeedSearchMatchIds(
  blocks: TerminalBlock[],
  filters: FeedSearchFilters,
  isVisible: (block: TerminalBlock) => boolean,
): string[] {
  return blocks
    .filter(isVisible)
    .filter((block) => feedBlockMatchesSearch(block, filters))
    .map((block) => block.id);
}
