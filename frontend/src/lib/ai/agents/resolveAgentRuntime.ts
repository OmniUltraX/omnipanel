import type { ModuleKey } from "../../paths";
import { agentIdForModule, getAgentDefinition, isAgentId } from "./registry";
import type { AgentId, AgentRuntimeConfig, AgentToolsMode } from "./types";

/** AI 助手页默认 Agent（Agent / Run 模式）。 */
export const ASSISTANT_PAGE_AGENT_ID: AgentId = "run";

/** 助手页可选模式：Plan（规划）/ Run（执行，UI 称 Agent）。 */
export const ASSISTANT_PAGE_AGENT_IDS = ["run", "plan"] as const satisfies readonly AgentId[];

export type AssistantPageAgentId = (typeof ASSISTANT_PAGE_AGENT_IDS)[number];

export function isAssistantPageAgentId(
  value: string | null | undefined,
): value is AssistantPageAgentId {
  return value === "plan" || value === "run";
}

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
 * - 助手页：仅允许 plan / run（由会话 agentId 切换，默认 run）
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
    if (isAssistantPageAgentId(options.conversationAgentId)) {
      return options.conversationAgentId;
    }
    // 历史 chat / 其它模块 id 在助手页一律回落默认 Agent 模式
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
