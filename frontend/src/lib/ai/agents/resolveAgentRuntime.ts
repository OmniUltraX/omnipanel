import type { ModuleKey } from "../../paths";
import { agentIdForModule, getAgentDefinition, isAgentId } from "./registry";
import type { AgentId, AgentRuntimeConfig, AgentToolsMode } from "./types";

/** AI 助手页始终绑定 plan Agent。 */
export const ASSISTANT_PAGE_AGENT_ID: AgentId = "plan";

function toolsModeFromPolicy(
  tools: ReturnType<typeof getAgentDefinition>["tools"],
): AgentToolsMode {
  if (tools.kind === "none") return "none";
  if (tools.kind === "allowlist") {
    return {
      directInject: {
        moduleFilter: tools.moduleFilter ?? null,
        toolAllowlist: tools.toolNames,
      },
    };
  }
  return {
    directInject: { moduleFilter: tools.moduleFilter },
  };
}

export function buildAgentRuntimeConfig(agentId: AgentId): AgentRuntimeConfig {
  const def = getAgentDefinition(agentId);
  return {
    agentId,
    toolsMode: toolsModeFromPolicy(def.tools),
    allowSkills: def.allowSkills,
    allowRag: def.allowRag,
    systemRole: def.systemRole,
  };
}

/**
 * 解析本次请求应使用的 Agent。
 * - 助手页：强制 plan
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
  // 历史会话可能仍标记为 chat
  if (options.conversationAgentId === "chat") {
    return "plan";
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
