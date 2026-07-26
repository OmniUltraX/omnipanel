"use client";

import { useMemo, type FC } from "react";
import { ContextDisplay } from "./context-display";
import {
  estimateTokenCount,
  resolveModelContextWindow,
} from "../../lib/ai/modelContextWindow";
import { useAiStore } from "../../stores/aiStore";

/**
 * Composer 旁的上下文用量环：优先用最近一轮真实 usage.input，否则按会话文本粗估。
 */
export const ComposerContextUsage: FC = () => {
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const conversation = useAiStore((s) =>
    s.conversations.find((c) => c.id === s.activeConversationId),
  );

  const modelContextWindow = useMemo(
    () => resolveModelContextWindow(conversation?.model),
    [conversation?.model],
  );

  const usage = useMemo(() => {
    if (!conversation) {
      return { totalTokens: 0 };
    }

    let lastInput = 0;
    let lastOutput = 0;
    for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
      const msg = conversation.messages[i];
      if (msg.role === "assistant" && msg.usage) {
        lastInput = msg.usage.inputTokens;
        lastOutput = msg.usage.outputTokens;
        break;
      }
    }

    if (lastInput > 0 || lastOutput > 0) {
      return {
        inputTokens: lastInput,
        outputTokens: lastOutput,
        totalTokens: lastInput + lastOutput,
      };
    }

    let estimated = 0;
    for (const msg of conversation.messages) {
      estimated += estimateTokenCount(msg.content ?? "");
      if (msg.reasoningContent) {
        estimated += estimateTokenCount(msg.reasoningContent);
      }
    }
    return { totalTokens: estimated };
  }, [conversation]);

  if (!activeConversationId) return null;

  return (
    <ContextDisplay.Ring
      modelContextWindow={modelContextWindow}
      usage={usage}
      side="top"
      className="aui-composer-context-usage"
    />
  );
};
