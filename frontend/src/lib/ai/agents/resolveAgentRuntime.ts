import type { ModuleKey } from "../../paths";
import { agentIdForModule, getAgentDefinition, isAgentId } from "./registry";
import type { AgentId, AgentRuntimeConfig } from "./types";

/** AI 助手页始终绑定 chat Agent（无工具）。 */
export const ASSISTANT_PAGE_AGENT_ID: AgentId = "chat";

export function buildAgentRuntimeConfig(agentId: AgentId): AgentRuntimeConfig {
  const def = getAgentDefinition(agentId);
  if (def.tools.kind === "none") {
    return {
      agentId,
      toolsMode: "none",
      allowSkills: def.allowSkills,
      allowRag: def.allowRag,
      systemRole: def.systemRole,
    };
  }
  return {
    agentId,
    toolsMode: {
      directInject: { moduleFilter: def.tools.moduleFilter },
    },
    allowSkills: def.allowSkills,
    allowRag: def.allowRag,
    systemRole: def.systemRole,
  };
}

/**
 * 解析本次请求应使用的 Agent。
 * - 助手页 / 显式 chat：强制 chat（无工具）
 * - 内联/模块场景：按 moduleKey 绑定独立模块 Agent
 * - 会话已绑定 agentId 时优先使用（保证会话内一致性）
 */
export function resolveAgentId(options: {
  /** 是否来自 AI 助手主界面（非终端内联） */
  assistantPage?: boolean;
  conversationAgentId?: string | null;
  moduleKey?: ModuleKey | null;
}): AgentId {
  if (options.assistantPage) {
    return ASSISTANT_PAGE_AGENT_ID;
  }
  if (isAgentId(options.conversationAgentId)) {
    return options.conversationAgentId;
  }
  return agentIdForModule(options.moduleKey ?? null);
}

export function resolveAgentRuntime(options: {
  assistantPage?: boolean;
  conversationAgentId?: string | null;
  moduleKey?: ModuleKey | null;
}): AgentRuntimeConfig {
  return buildAgentRuntimeConfig(resolveAgentId(options));
}
