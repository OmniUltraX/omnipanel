import type { AiThreadItem, TerminalBlock } from "../../stores/blocksStore";
import { getResolvedAiThread } from "./aiThreadBridge";

export function buildAiThreadItemSignature(item: AiThreadItem): string {
  if (item.kind === "message") {
    return `m:${item.id}:${item.role}:${item.content.length}:${item.reasoning?.length ?? 0}`;
  }
  return `t:${item.id}:${item.status}:${item.result?.length ?? 0}`;
}

export function buildAiThreadSignature(thread: AiThreadItem[]): string {
  return thread.map(buildAiThreadItemSignature).join("|");
}

export function buildBlockThreadSignature(block: TerminalBlock): string {
  return buildAiThreadSignature(getResolvedAiThread(block));
}
