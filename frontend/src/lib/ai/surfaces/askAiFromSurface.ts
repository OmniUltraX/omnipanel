/**
 * AI 表面层统一提交：首页 / 模块「问 AI」等入口。
 * 一律走 sendToAiDock → submitAiPrompt，禁止旁路聊天 IPC。
 */
import type { ModuleKey } from "../../paths";
import { agentIdForModule, ASSISTANT_PAGE_AGENT_ID } from "../agents";
import { sendToAiDock, type SendToAiOptions } from "../sendToAiDock";
import { useAiStore } from "../../../stores/aiStore";

export type AiSurfaceKind = "dashboard" | "module";

export interface AskAiFromSurfaceOptions {
  prompt: string;
  surface: AiSurfaceKind;
  /** surface=module 时必填 */
  moduleKey?: ModuleKey | null;
  newConversation?: boolean;
  contextChips?: SendToAiOptions["contextChips"];
  openDrawer?: boolean;
}

/**
 * 从表面层发起 AI 对话。
 * - dashboard：默认新会话 + run Agent
 * - module：绑定 module Agent，默认新会话
 */
export async function askAiFromSurface(
  options: AskAiFromSurfaceOptions,
): Promise<void> {
  const prompt = options.prompt.trim();
  if (!prompt) return;

  const newConversation = options.newConversation ?? true;
  const agentId =
    options.surface === "module"
      ? agentIdForModule(options.moduleKey)
      : ASSISTANT_PAGE_AGENT_ID;

  const store = useAiStore.getState();
  if (options.openDrawer !== false) {
    store.openDrawer();
  }

  let conversationId: string;
  if (newConversation) {
    conversationId = store.createConversation(undefined, undefined, { agentId });
  } else {
    conversationId = store.activeConversationId ?? store.createConversation(undefined, undefined, { agentId });
    store.setConversationAgentId(conversationId, agentId);
  }

  // createConversation 已切 active；再确保 agent 一致（空白会话复用路径）
  store.setConversationAgentId(conversationId, agentId);

  await sendToAiDock(prompt, {
    newConversation: false, // 会话已在上面建好
    contextChips: options.contextChips,
    openDrawer: options.openDrawer,
  });
}

/** 模块「问 AI」默认引导句（调用方可用 i18n 覆盖） */
export function defaultModuleAskPrompt(moduleKey: ModuleKey): string {
  return `请基于当前「${moduleKey}」模块上下文，帮我分析现场并给出可执行建议。如需多步操作，先用 plan 列出步骤；可并行的检查用子会话。`;
}
