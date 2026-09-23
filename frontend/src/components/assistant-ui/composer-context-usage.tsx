"use client";

import { useMemo, type FC } from "react";
import { ContextDisplay } from "./context-display";
import {
  estimateTokenCount,
  resolveModelContextWindow,
} from "../../lib/ai/modelContextWindow";
import {
  isAgentSessionId,
  resolveActiveAgentAdapter,
} from "../../lib/ai/agentAdapters";
import { useAiStore } from "../../stores/aiStore";
import type { AiTokenUsage } from "../../stores/aiStore";
import type { ThreadTokenUsage } from "./context-display";

/** OpenCode `tokenTotal`：input + output + reasoning + cache.read + cache.write */
function openCodeContextTotal(usage: AiTokenUsage): number {
  if (usage.totalTokens && usage.totalTokens > 0) {
    return usage.totalTokens;
  }
  return (
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.reasoningTokens ?? 0) +
    (usage.cachedInputTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

function toThreadUsage(usage: AiTokenUsage, openCode: boolean): ThreadTokenUsage {
  const totalTokens = openCode
    ? openCodeContextTotal(usage)
    : usage.totalTokens ??
      usage.inputTokens + usage.outputTokens;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedInputTokens: usage.cachedInputTokens,
    totalTokens,
  };
}

/**
 * Composer 旁的上下文用量环。
 * - OpenCode 适配器：用 OpenCode 消息 tokens / model.limit.context（与官方 Session Context 一致）
 * - 内置编排：优先最近一轮 usage，否则按会话文本粗估
 */
export const ComposerContextUsage: FC = () => {
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const conversation = useAiStore((s) =>
    s.conversations.find((c) => c.id === s.activeConversationId),
  );

  const isOpenCode =
    resolveActiveAgentAdapter()?.id === "opencode" ||
    isAgentSessionId(activeConversationId);

  const lastOpenCodeUsage = useMemo(() => {
    if (!conversation) return null;
    for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
      const msg = conversation.messages[i];
      if (msg.role === "assistant" && msg.usage) {
        const total = openCodeContextTotal(msg.usage);
        if (total > 0 || msg.usage.inputTokens > 0 || msg.usage.outputTokens > 0) {
          return msg.usage;
        }
      }
    }
    return null;
  }, [conversation]);

  const modelContextWindow = useMemo(() => {
    if (isOpenCode && lastOpenCodeUsage?.contextLimit && lastOpenCodeUsage.contextLimit > 0) {
      return lastOpenCodeUsage.contextLimit;
    }
    return resolveModelContextWindow(conversation?.model);
  }, [isOpenCode, lastOpenCodeUsage?.contextLimit, conversation?.model]);

  const usage = useMemo(() => {
    if (!conversation) {
      return { totalTokens: 0 };
    }

    if (isOpenCode) {
      if (lastOpenCodeUsage) {
        return toThreadUsage(lastOpenCodeUsage, true);
      }
      // OpenCode：无官方 tokens 时不粗估（避免与真实上下文窗口偏差过大）
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
  }, [conversation, isOpenCode, lastOpenCodeUsage]);

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
