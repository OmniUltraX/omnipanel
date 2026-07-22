import type { AiThreadItem, TerminalBlock } from "../../stores/blocksStore";
import { getResolvedAiThread } from "./aiThreadBridge";

function partsSignature(parts: { type: string; text?: string; id?: string; status?: string; result?: string; plan?: { id: string; status: string; steps: unknown[]; updatedAt: number } }[] | undefined): string {
  if (!parts || parts.length === 0) return "";
  return parts.map((p) => {
    if (p.type === "text" || p.type === "reasoning") return `${p.type}:${p.text?.length ?? 0}`;
    if (p.type === "plan" && p.plan) return `plan:${p.plan.id}:${p.plan.status}:${p.plan.steps.length}:${p.plan.updatedAt}`;
    return `tc:${p.id}:${p.status}:${p.result?.length ?? 0}`;
  }).join(",");
}

export function buildAiThreadItemSignature(item: AiThreadItem): string {
  if (item.kind === "message") {
    return `m:${item.id}:${item.role}:${item.content.length}:${item.reasoning?.length ?? 0}:${partsSignature(item.parts)}`;
  }
  return `t:${item.id}:${item.status}:${item.result?.length ?? 0}`;
}

export function buildAiThreadSignature(thread: AiThreadItem[]): string {
  return thread.map(buildAiThreadItemSignature).join("|");
}

export function buildBlockThreadSignature(block: TerminalBlock): string {
  return buildAiThreadSignature(getResolvedAiThread(block));
}
