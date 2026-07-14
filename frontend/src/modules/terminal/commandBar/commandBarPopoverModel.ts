import type { CompletionCandidate } from "./types";
import type { CommandHistoryEntry } from "./commandHistory";

export type CommandBarPopoverBadge =
  | "shell"
  | "ai"
  | "readline"
  | "path"
  | "command"
  | "resource"
  | "template"
  | "history";

export type CommandBarPopoverMode = "history" | "completion";

export type CommandBarPopoverItem = {
  id: string;
  label: string;
  description?: string;
  badge: CommandBarPopoverBadge;
};

const CANDIDATE_BADGE: Record<CompletionCandidate["source"], CommandBarPopoverBadge> = {
  history: "history",
  command: "command",
  path: "path",
  resource: "resource",
  template: "template",
  ai: "ai",
};

export function historyEntryToPopoverItem(entry: CommandHistoryEntry): CommandBarPopoverItem {
  return {
    id: `history:${entry.kind}:${entry.text}:${entry.timestamp}`,
    label: entry.text,
    badge: entry.kind,
  };
}

export function candidateToPopoverItem(candidate: CompletionCandidate): CommandBarPopoverItem {
  const badge =
    candidate.historyKind ??
    (candidate.source === "ai" ? "ai" : CANDIDATE_BADGE[candidate.source]);
  return {
    id: candidate.id,
    label: candidate.label,
    description: candidate.description,
    badge,
  };
}

export const PICKER_PAGE_SIZE = 8;

export const POPOVER_BADGE_I18N: Record<CommandBarPopoverBadge, string> = {
  shell: "terminal.command.historyKindShell",
  ai: "terminal.command.historyKindAi",
  readline: "terminal.command.historyKindReadline",
  path: "terminal.command.pickerKindPath",
  command: "terminal.command.pickerKindCommand",
  resource: "terminal.command.pickerKindResource",
  template: "terminal.command.pickerKindTemplate",
  history: "terminal.command.pickerKindHistory",
};
