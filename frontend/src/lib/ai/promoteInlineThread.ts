import type { AiMessage } from "../../stores/aiStore";
import { useAiStore } from "../../stores/aiStore";
import {
  getResolvedAiThread,
} from "../../modules/terminal/aiThreadBridge";
import { useBlocksStore } from "../../stores/blocksStore";
import { isAiThreadMessage, isAiThreadToolCall } from "../../stores/blocksStore";

/** 将终端内联 aiThread 提升为 Dock assistant-ui 会话。 */
export function promoteTerminalInlineToDock(args: {
  sessionId: string;
  blockId: string;
  targetConversationId?: string | null;
}): string | null {
  const block = useBlocksStore.getState().findBlockById(args.blockId);
  if (!block) return null;
  const thread = getResolvedAiThread(block);
  const messages: AiMessage[] = [];
  for (const item of thread) {
    if (isAiThreadMessage(item)) {
      messages.push({
        id: item.id,
        role: item.role === "assistant" ? "assistant" : "user",
        content: item.content,
        reasoningContent: item.reasoning,
        timestamp: item.timestamp ?? Date.now(),
      });
    } else if (isAiThreadToolCall(item)) {
      // 工具调用挂到最近一条 assistant 消息上
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      if (lastAssistant) {
        lastAssistant.toolCalls = [
          ...(lastAssistant.toolCalls ?? []),
          {
            id: item.id,
            name: item.toolName,
            arguments: item.args ?? "",
            result: item.result,
            status:
              item.status === "completed"
                ? "completed"
                : item.status === "failed"
                  ? "failed"
                  : "running",
          },
        ];
      }
    }
  }

  const title =
    block.title?.trim() ||
    messages.find((m) => m.role === "user")?.content.slice(0, 40) ||
    "终端 AI 会话";

  const convId = useAiStore.getState().promoteInlineThread({
    title,
    messages,
    terminalSessionId: args.sessionId,
    sourceBlockId: args.blockId,
    targetConversationId: args.targetConversationId,
  });
  useAiStore.getState().openDrawer();
  return convId;
}
