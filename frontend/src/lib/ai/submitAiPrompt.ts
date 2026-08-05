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
  /** 指定会话 id（助手端入站：投递到选中会话，勿新开） */
  conversationId?: string;
  contextChips?: { type: string; label: string }[];
  /** 终端 Command Bar `#` / `/agent` 默认走内联 Block 流；侧栏用于长对话 */
  inline?: InlineTerminalAiTarget;
}

/** 侧栏/助手入站：当前正在生成时不可抢占，由调用方排队重试 */
export class AiPromptBusyError extends Error {
  constructor(message = "AI is generating") {
    super(message);
    this.name = "AiPromptBusyError";
  }
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
  let convId =
    options?.conversationId?.trim() ||
    (options?.newConversation ? null : store.activeConversationId);
  if (convId) {
    const hit = store.conversations.find((c) => c.id === convId);
    if (hit) {
      store.setActiveConversation(convId);
    } else {
      // 未知 id（如助手本地 _mp）：仍新建，但尽量用该 id
      convId = store.ensureConversationId(convId);
    }
  } else {
    convId = store.createConversation();
  }
  if (options?.contextChips) {
    for (const chip of options.contextChips) {
      store.addContext(convId, chip);
    }
  }
  store.addMessage(convId, { role: "user", content: text });
}
