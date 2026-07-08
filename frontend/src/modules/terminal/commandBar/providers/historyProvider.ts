import type { CompletionCandidate, TerminalCompletionContext } from "../types";
import { listSessionCommandHistoryFast } from "../useSessionCommandHistory";
import { buildReplacementRange, parseCommandLineForCompletion } from "../parseCommandLine";

export function suggestHistory(ctx: TerminalCompletionContext): CompletionCandidate[] {
  const parsed = parseCommandLineForCompletion(ctx.input, ctx.cursor);
  const token = parsed.activeToken;
  if (!token || token.kind === "path" || token.kind === "resource") return [];

  const prefix = token.text.toLowerCase();
  const commands = listSessionCommandHistoryFast(ctx.sessionId, prefix);
  const candidates: CompletionCandidate[] = [];

  for (const cmd of commands) {
    if (prefix && !cmd.toLowerCase().startsWith(prefix)) continue;
    const replacement = buildReplacementRange(token, ctx.cursor);
    candidates.push({
      id: `history:${cmd}`,
      label: cmd,
      insertText: cmd,
      description: cmd.startsWith("#") ? "AI 历史" : "历史命令",
      source: "history",
      priority: "default",
      replacement,
    });
    if (candidates.length >= 20) break;
  }

  return candidates;
}
