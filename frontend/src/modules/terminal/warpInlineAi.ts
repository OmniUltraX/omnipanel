import { submitAiPrompt } from "../../lib/ai/submitAiPrompt";
import { cancelAiGeneration } from "../../lib/ai/cancelAiGeneration";
import { commands } from "../../ipc/bindings";
import { createBlockId, isAiThreadMessage, isAiThreadToolCall, useBlocksStore } from "../../stores/blocksStore";
import { useTerminalUiStore } from "./terminalUiStore";
import { buildNaturalLanguagePrompt } from "./warpExperience";
import { cancelPendingInlineTools } from "./inlineToolBridge";
import { getResolvedAiThread, pushAssistantErrorMessage } from "./aiThreadBridge";

function beginAiBlock(sessionId: string, query: string, cwd: string): string {
  const blockId = createBlockId();
  const userTurnId = createBlockId();

  useBlocksStore.getState().addBlock(sessionId, {
    id: blockId,
    sessionId,
    kind: "ai",
    title: query,
    command: `# ${query}`,
    output: "",
    aiThread: [
      {
        kind: "message",
        id: userTurnId,
        role: "user",
        content: query,
        timestamp: Date.now(),
      },
    ],
    exitCode: null,
    startLine: -1,
    endLine: -1,
    marker: null,
    cwd,
    timestamp: Date.now(),
    status: "running",
  });

  useTerminalUiStore.getState().setExpandedAiBlock(sessionId, blockId);
  return blockId;
}

const INLINE_AI_STOPPED = "已手动停止";

/** 强制停止卡住的终端内联 AI 卡片 */
export function cancelInlineAiBlock(sessionId: string, blockId: string): void {
  // 内联卡片会话按 blockId 派生（见 AiRuntimeProvider.inlineConversationId）
  void commands.aiChatCancel(`term-${blockId}`).catch(() => {});
  cancelAiGeneration();
  cancelPendingInlineTools(blockId);

  const block = useBlocksStore.getState().findBlockById(blockId);
  if (block) {
    for (const item of getResolvedAiThread(block)) {
      if (
        isAiThreadToolCall(item) &&
        (item.status === "pending" || item.status === "running")
      ) {
        useBlocksStore.getState().updateAiThreadItem(blockId, item.id, {
          status: "rejected",
          result: INLINE_AI_STOPPED,
        });
      }
    }
  }

  const forceStopStuckBlock = () => {
    const block = useBlocksStore.getState().findBlockById(blockId);
    if (!block || block.status !== "running") return;

    const thread = getResolvedAiThread(block);
    const hasAssistantContent = thread.some(
      (item) =>
        isAiThreadMessage(item) &&
        item.role === "assistant" &&
        Boolean(item.content.trim() || item.reasoning?.trim()),
    );
    if (!hasAssistantContent) {
      pushAssistantErrorMessage(blockId, INLINE_AI_STOPPED);
    }

    useBlocksStore.getState().updateBlock(blockId, {
      status: "failed",
      exitCode: 130,
    });
    useTerminalUiStore.getState().setExpandedAiBlock(sessionId, blockId);
  };

  window.setTimeout(forceStopStuckBlock, 120);
}

/** 在终端 Block 流内发起自然语言 AI（Warp 式，不打开侧栏） */
export async function submitInlineNaturalLanguage(
  sessionId: string,
  query: string,
  cwd = "",
): Promise<string> {
  const blockId = beginAiBlock(sessionId, query, cwd);
  const prompt = buildNaturalLanguagePrompt(query, cwd);

  try {
    await submitAiPrompt(prompt, {
      inline: { sessionId, blockId },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushAssistantErrorMessage(blockId, message || "AI 请求失败");
    useBlocksStore.getState().updateBlock(blockId, { status: "failed", exitCode: 1 });
  }

  return blockId;
}

/** 在已展开的 AI 卡片内继续追问 */
export async function submitInlineFollowUp(
  sessionId: string,
  blockId: string,
  query: string,
  cwd = "",
): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) return;

  useBlocksStore.getState().pushAiThreadItem(blockId, {
    kind: "message",
    role: "user",
    content: trimmed,
  });
  useBlocksStore.getState().updateBlock(blockId, {
    status: "running",
  });
  useTerminalUiStore.getState().setExpandedAiBlock(sessionId, blockId);

  const prompt = buildNaturalLanguagePrompt(trimmed, cwd);
  try {
    await submitAiPrompt(prompt, {
      inline: { sessionId, blockId, continueThread: true },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushAssistantErrorMessage(blockId, message || "AI 请求失败");
    useBlocksStore.getState().updateBlock(blockId, { status: "failed", exitCode: 1 });
  }
}
