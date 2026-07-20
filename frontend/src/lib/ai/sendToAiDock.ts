import { useAiStore } from "../../stores/aiStore";
import { submitAiPrompt } from "./submitAiPrompt";

export interface SendToAiOptions {
  /** 额外上下文芯片 */
  contextChips?: { type: string; label: string }[];
  /** 强制新会话 */
  newConversation?: boolean;
  /** 打开抽屉（默认 true） */
  openDrawer?: boolean;
}

/**
 * 各模块「发给 AI」统一入口：写入当前 Dock 会话（非终端内联）。
 */
export async function sendToAiDock(
  prompt: string,
  options?: SendToAiOptions,
): Promise<void> {
  const text = prompt.trim();
  if (!text) return;
  if (options?.openDrawer !== false) {
    useAiStore.getState().openDrawer();
  }
  await submitAiPrompt(text, {
    newConversation: options?.newConversation,
    contextChips: options?.contextChips,
  });
}

export function buildExplainPrompt(kind: string, payload: string): string {
  return `请根据以下${kind}给出分析与可执行建议：\n\n\`\`\`\n${payload.slice(0, 8000)}\n\`\`\``;
}
