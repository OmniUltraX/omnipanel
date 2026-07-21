import type { CompletionCandidate, TerminalCompletionContext } from "../types";
import { listSessionCommandHistoryEntriesFast } from "../useSessionCommandHistory";
import { buildReplacementRange, parseCommandLineForCompletion } from "../parseCommandLine";
import { isPathCompletionInput } from "./pathProvider";

export function suggestHistory(ctx: TerminalCompletionContext): CompletionCandidate[] {
  // 路径补全场景（cd/ls/vim 等）由路径 provider 负责，避免 Tab 被历史命令刷屏
  if (isPathCompletionInput(ctx)) return [];

  const parsed = parseCommandLineForCompletion(ctx.input, ctx.cursor);
  const token = parsed.activeToken;
  if (!token || token.kind === "path" || token.kind === "resource") return [];

  const prefix = token.text.toLowerCase();
  const entries = listSessionCommandHistoryEntriesFast(ctx.sessionId, prefix);
  const candidates: CompletionCandidate[] = [];

  for (const entry of entries) {
    const replacement = buildReplacementRange(token, ctx.cursor);
    candidates.push({
      id: `history:${entry.kind}:${entry.text}:${entry.timestamp}`,
      label: entry.text,
      insertText: entry.text,
      description: entry.kind === "ai" ? "AI 历史" : "历史命令",
      source: entry.kind === "ai" ? "ai" : "history",
      historyKind: entry.kind,
      timestamp: entry.timestamp,
      priority: "default",
      replacement,
    });
    if (candidates.length >= 20) break;
  }

  return candidates;
}
