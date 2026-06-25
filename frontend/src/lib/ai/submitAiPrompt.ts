export interface InlineTerminalAiTarget {
  sessionId: string;
  blockId: string;
  /** 在同一张 AI 卡片内继续追问 */
  continueThread?: boolean;
  /** 当前 assistant 轮次 id（流式写入） */
  assistantTurnId?: string;
}

export interface SubmitAiPromptOptions {
  /** 新建会话（侧栏 AI 等场景） */
  newConversation?: boolean;
  contextChips?: { type: string; label: string }[];
  /** 终端 Command Bar `#` / `/agent` 默认走内联 Block 流；侧栏用于长对话 */
  inline?: InlineTerminalAiTarget;
}

type SubmitAiPromptHandler = (
  prompt: string,
  options?: SubmitAiPromptOptions,
) => Promise<void>;

let submitHandler: SubmitAiPromptHandler | null = null;

export function registerAiPromptSubmit(handler: SubmitAiPromptHandler): () => void {
  submitHandler = handler;
  return () => {
    if (submitHandler === handler) submitHandler = null;
  };
}

export async function submitAiPrompt(
  prompt: string,
  options?: SubmitAiPromptOptions,
): Promise<void> {
  const text = prompt.trim();
  if (!text) return;
  if (submitHandler) {
    await submitHandler(text, options);
    return;
  }
  const { useAiStore } = await import("../../stores/aiStore");
  const store = useAiStore.getState();
  let convId = options?.newConversation ? null : store.activeConversationId;
  if (!convId) convId = store.createConversation();
  if (options?.contextChips) {
    for (const chip of options.contextChips) {
      store.addContext(convId, chip);
    }
  }
  store.addMessage(convId, { role: "user", content: text });
}
