import type { ModuleKey } from "../../paths";
import type { AgentDefinition, AgentId } from "./types";

function moduleAgent(
  id: Extract<AgentId, ModuleKey>,
  labelKey: string,
  descriptionKey: string,
  systemRole: string,
): AgentDefinition {
  return {
    id,
    labelKey,
    descriptionKey,
    tools: { kind: "module", moduleFilter: id },
    allowSkills: true,
    allowRag: true,
    systemRole,
  };
}

/**
 * 内置 Agent 注册表（前期布局）。
 * 终端与 SSH 已合并为同一模块 Agent（`terminal`）。
 */
export const AGENT_REGISTRY: Record<AgentId, AgentDefinition> = {
  plan: {
    id: "plan",
    labelKey: "ai.agents.plan.label",
    descriptionKey: "ai.agents.plan.description",
    /** 全局工具（module_key=web）：待办 / Skill / Tag / Resource / Workspace / 联网搜索等 */
    tools: {
      kind: "module",
      moduleFilter: "web",
    },
    allowSkills: true,
    allowRag: true,
    // 完整提示词由后端 ~/.omnipd/prompts/agents/plan.md 注入；此处仅作回退摘要。
    systemRole: "OmniPanel 计划助手（plan）。完整角色见后端 agents/plan.md。",
  },
  run: {
    id: "run",
    labelKey: "ai.agents.run.label",
    descriptionKey: "ai.agents.run.description",
    /** master：不过滤，注入全部内置工具 + 外部 MCP */
    tools: {
      kind: "module",
      moduleFilter: "master",
    },
    allowSkills: true,
    allowRag: true,
    // 完整提示词由后端 ~/.omnipd/prompts/agents/run.md 注入；此处仅作回退摘要。
    systemRole: "OmniPanel 执行助手（run）。完整角色见后端 agents/run.md。",
  },
  terminal: moduleAgent(
    "terminal",
    "ai.agents.terminal.label",
    "ai.agents.terminal.description",
    "OmniPanel 终端 Agent。完整角色见后端 agents/terminal.md。",
  ),
  database: moduleAgent(
    "database",
    "ai.agents.database.label",
    "ai.agents.database.description",
    "OmniPanel 数据库 Agent。完整角色见后端 agents/database.md。",
  ),
  docker: moduleAgent(
    "docker",
    "ai.agents.docker.label",
    "ai.agents.docker.description",
    "OmniPanel Docker Agent。完整角色见后端 agents/docker.md。",
  ),
  server: moduleAgent(
    "server",
    "ai.agents.server.label",
    "ai.agents.server.description",
    "OmniPanel 服务器 Agent。完整角色见后端 agents/server.md。",
  ),
  files: moduleAgent(
    "files",
    "ai.agents.files.label",
    "ai.agents.files.description",
    "OmniPanel 文件 Agent。完整角色见后端 agents/files.md。",
  ),
  knowledge: moduleAgent(
    "knowledge",
    "ai.agents.knowledge.label",
    "ai.agents.knowledge.description",
    "OmniPanel 知识库 Agent。完整角色见后端 agents/knowledge.md。",
  ),
  protocol: moduleAgent(
    "protocol",
    "ai.agents.protocol.label",
    "ai.agents.protocol.description",
    "OmniPanel 协议 Agent。完整角色见后端 agents/protocol.md。",
  ),
  workflow: moduleAgent(
    "workflow",
    "ai.agents.workflow.label",
    "ai.agents.workflow.description",
    "OmniPanel 工作流 Agent。完整角色见后端 agents/workflow.md。",
  ),
  tasks: moduleAgent(
    "tasks",
    "ai.agents.tasks.label",
    "ai.agents.tasks.description",
    "OmniPanel 任务 Agent。完整角色见后端 agents/tasks.md。",
  ),
};

export const ALL_AGENT_IDS = Object.keys(AGENT_REGISTRY) as AgentId[];

export function getAgentDefinition(id: AgentId): AgentDefinition {
  return AGENT_REGISTRY[id];
}

export function isAgentId(value: string | null | undefined): value is AgentId {
  return Boolean(value && value in AGENT_REGISTRY);
}

/** 模块 → Agent；SSH 已并入终端；无对应 Agent 时回退 plan */
export function agentIdForModule(moduleKey: ModuleKey | null | undefined): AgentId {
  if (!moduleKey) return "plan";
  // 旧路由 / 资源类型仍可能出现 ssh
  if (moduleKey === "ssh") return "terminal";
  if (isAgentId(moduleKey)) return moduleKey;
  return "plan";
}
