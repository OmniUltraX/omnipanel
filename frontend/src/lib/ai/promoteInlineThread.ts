import { normalizeAiMessage, useAiStore } from "../../stores/aiStore";
import {
  aiThreadToAiMessages,
  getResolvedAiThread,
} from "../../modules/terminal/aiThreadBridge";
import { useBlocksStore } from "../../stores/blocksStore";

/** 将终端内联 aiThread 提升为 Dock assistant-ui 会话。 */
export function promoteTerminalInlineToDock(args: {
  sessionId: string;
  blockId: string;
  targetConversationId?: string | null;
}): string | null {
  const block = useBlocksStore.getState().findBlockById(args.blockId);
  if (!block) return null;
  const thread = getResolvedAiThread(block);
  // 保序 parts：不再把后续 tool 压扁挂到 lastAssistant 后再经旧 bridge 打乱
  const messages = aiThreadToAiMessages(thread).map((m) => normalizeAiMessage(m));

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
