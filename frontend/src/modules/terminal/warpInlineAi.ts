import { submitAiPrompt } from "../../lib/ai/submitAiPrompt";
import { createBlockId, useBlocksStore } from "../../stores/blocksStore";
import { useTerminalUiStore } from "./terminalUiStore";
import { buildNaturalLanguagePrompt } from "./warpExperience";

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

/** 在终端 Block 流内发起自然语言 AI（Warp 式，不打开侧栏） */
export async function submitInlineNaturalLanguage(
  sessionId: string,
  query: string,
  cwd = "",
): Promise<string> {
  const blockId = beginAiBlock(sessionId, query, cwd);
  const prompt = buildNaturalLanguagePrompt(query, cwd);

  await submitAiPrompt(prompt, {
    inline: { sessionId, blockId },
  });

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
  await submitAiPrompt(prompt, {
    inline: { sessionId, blockId, continueThread: true },
  });
}
