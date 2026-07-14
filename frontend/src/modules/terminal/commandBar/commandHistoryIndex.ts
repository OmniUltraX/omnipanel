import type { TerminalBlock } from "../../../stores/blocksStore";
import { isAiThreadMessage } from "../../../stores/blocksStore";
import { stripAutoLsSuffix } from "../terminalAutoLsPolicy";
import { normalizeBlockCommand } from "../terminalOutputText";
import { isInternalHistoryCommand } from "./internalHistoryCommands";
import { fuzzyMatchScore } from "./fuzzyMatch";

export type CommandHistoryKind = "shell" | "ai" | "readline";

export type CommandHistoryEntry = {
  text: string;
  kind: CommandHistoryKind;
  timestamp: number;
};
export const HISTORY_PANEL_DISPLAY_LIMIT = 50;
export const HISTORY_SEARCH_DISPLAY_LIMIT = 100;

function normalizeShellHistoryCommand(command: string): string {
  return stripAutoLsSuffix(normalizeBlockCommand(command)).trim();
}

function formatAiHistoryText(query: string): string {
  const trimmed = query.trim();
  return trimmed.startsWith("#") ? trimmed : `# ${trimmed}`;
}

function upsertEntry(
  map: Map<string, IndexedCommandHistoryEntry>,
  text: string,
  kind: CommandHistoryKind,
  timestamp: number,
): void {
  if (!text || isInternalHistoryCommand(text)) return;
  const searchText = text.toLowerCase();
  const existing = map.get(searchText);
  if (!existing || timestamp >= existing.timestamp) {
    map.set(searchText, { text, kind, timestamp, searchText });
  }
}

function collectBlockEntries(blocks: TerminalBlock[]): Map<string, IndexedCommandHistoryEntry> {
  const map = new Map<string, IndexedCommandHistoryEntry>();

  for (const block of blocks) {
    const blockTs = block.completedAt ?? block.timestamp;

    if (block.kind === "ai") {
      for (const item of block.aiThread ?? []) {
        if (!isAiThreadMessage(item) || item.role !== "user") continue;
        const query = item.content.trim();
        if (!query) continue;
        upsertEntry(map, formatAiHistoryText(query), "ai", item.timestamp ?? blockTs);
      }

      const cmd = block.command.trim();
      if (cmd.startsWith("#")) {
        upsertEntry(map, cmd, "ai", blockTs);
      } else if (block.title?.trim()) {
        upsertEntry(map, formatAiHistoryText(block.title.trim()), "ai", blockTs);
      }
      continue;
    }

    const cmd = normalizeShellHistoryCommand(block.command);
    if (!cmd || cmd.startsWith("#")) continue;
    upsertEntry(map, cmd, "shell", blockTs);
  }

  return map;
}

/** 仅依赖命令字段的指纹，忽略 output 变更 */
export function computeBlocksHistoryKey(blocks: TerminalBlock[]): string {
  if (blocks.length === 0) return "0";
  const parts: string[] = new Array(blocks.length);
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]!;
    let part = `${block.id}\x01${block.kind ?? "shell"}\x01${block.command}\x01${block.timestamp}`;
    const thread = block.aiThread;
    if (thread && thread.length > 0) {
      for (const item of thread) {
        if (item.kind === "message" && item.role === "user") {
          part += `\x01${item.id}:${item.content}:${item.timestamp}`;
        }
      }
    }
    parts[i] = part;
  }
  return parts.join("\x02");
}

export type IndexedCommandHistoryEntry = CommandHistoryEntry & {
  searchText: string;
};

/** 构建会话全量历史索引（新 → 旧），readline 应已规范化 */
export function buildHistoryIndex(
  blocks: TerminalBlock[],
  readlineCommands: string[],
): IndexedCommandHistoryEntry[] {
  const blockEntries = collectBlockEntries(blocks);
  const sessionEntries = Array.from(blockEntries.values()).sort(
    (a, b) => b.timestamp - a.timestamp,
  );
  const seen = new Set(blockEntries.keys());
  const readlineEntries: IndexedCommandHistoryEntry[] = [];

  for (let i = 0; i < readlineCommands.length; i += 1) {
    const text = readlineCommands[i]!.trim();
    if (!text || isInternalHistoryCommand(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const kind: CommandHistoryKind = text.startsWith("#") ? "ai" : "readline";
    readlineEntries.push({
      text,
      kind,
      timestamp: readlineCommands.length - i,
      searchText: key,
    });
  }

  return [...sessionEntries, ...readlineEntries];
}

export function filterHistoryIndex(
  index: IndexedCommandHistoryEntry[],
  query: string,
  displayLimit = HISTORY_PANEL_DISPLAY_LIMIT,
  searchLimit = HISTORY_SEARCH_DISPLAY_LIMIT,
): CommandHistoryEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return index.slice(0, displayLimit);
  }

  const matched: CommandHistoryEntry[] = [];
  const scored: Array<{ entry: IndexedCommandHistoryEntry; score: number }> = [];
  for (let i = 0; i < index.length; i += 1) {
    const entry = index[i]!;
    const score = fuzzyMatchScore(normalized, entry.text);
    if (score <= 0) continue;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp);
  const limit = searchLimit;
  for (let i = 0; i < scored.length && matched.length < limit; i += 1) {
    matched.push(scored[i]!.entry);
  }
  return matched;
}
