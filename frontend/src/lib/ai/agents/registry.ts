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
  chat: {
    id: "chat",
    labelKey: "ai.agents.chat.label",
    descriptionKey: "ai.agents.chat.description",
    tools: { kind: "none" },
    allowSkills: true,
    allowRag: true,
    systemRole:
      "你是 OmniPanel 的「聊天助手」Agent。你只负责对话、解释与建议，不能调用任何工具或执行操作。若用户需要操作终端（含 SSH）/数据库/Docker 等，请说明应切换到对应模块 Agent。",
  },
  terminal: moduleAgent(
    "terminal",
    "ai.agents.terminal.label",
    "ai.agents.terminal.description",
    // 完整专业提示词由后端 ~/.omnipd/prompts/agents/terminal.md 注入；此处仅作回退摘要。
    "你是 OmniPanel 的「终端」运维 Agent（本地终端 + SSH）。主责：服务与健康检查、资源占用排查、环境安装与配置。先只读探测再变更，结论基于命令输出，高风险操作需确认；仅使用终端模块工具。",
  ),
  database: moduleAgent(
    "database",
    "ai.agents.database.label",
    "ai.agents.database.description",
    "你是 OmniPanel 的「数据库」Agent，专注连接、Schema 与 SQL；仅使用数据库相关工具。",
  ),
  docker: moduleAgent(
    "docker",
    "ai.agents.docker.label",
    "ai.agents.docker.description",
    "你是 OmniPanel 的「Docker」Agent，专注容器/镜像/Compose；仅使用 Docker 相关工具。",
  ),
  server: moduleAgent(
    "server",
    "ai.agents.server.label",
    "ai.agents.server.description",
    "你是 OmniPanel 的「服务器」Agent，专注主机运维与监控；仅使用服务器相关工具。",
  ),
  files: moduleAgent(
    "files",
    "ai.agents.files.label",
    "ai.agents.files.description",
    "你是 OmniPanel 的「文件」Agent，专注文件浏览与读写；仅使用文件相关工具。",
  ),
  knowledge: moduleAgent(
    "knowledge",
    "ai.agents.knowledge.label",
    "ai.agents.knowledge.description",
    "你是 OmniPanel 的「知识库」Agent，专注文档与检索；仅使用知识库相关工具。",
  ),
  protocol: moduleAgent(
    "protocol",
    "ai.agents.protocol.label",
    "ai.agents.protocol.description",
    "你是 OmniPanel 的「协议调试」Agent；仅使用协议相关工具。",
  ),
  workflow: moduleAgent(
    "workflow",
    "ai.agents.workflow.label",
    "ai.agents.workflow.description",
    "你是 OmniPanel 的「工作流」Agent；仅使用工作流相关工具。",
  ),
  tasks: moduleAgent(
    "tasks",
    "ai.agents.tasks.label",
    "ai.agents.tasks.description",
    "你是 OmniPanel 的「任务」Agent；仅使用任务相关工具。",
  ),
};

export const ALL_AGENT_IDS = Object.keys(AGENT_REGISTRY) as AgentId[];

export function getAgentDefinition(id: AgentId): AgentDefinition {
  return AGENT_REGISTRY[id];
}

export function isAgentId(value: string | null | undefined): value is AgentId {
  return Boolean(value && value in AGENT_REGISTRY);
}

/** 模块 → Agent；SSH 已并入终端；无对应 Agent 时回退 chat */
export function agentIdForModule(moduleKey: ModuleKey | null | undefined): AgentId {
  if (!moduleKey) return "chat";
  // 旧路由 / 资源类型仍可能出现 ssh
  if (moduleKey === "ssh") return "terminal";
  if (isAgentId(moduleKey)) return moduleKey;
  return "chat";
}
