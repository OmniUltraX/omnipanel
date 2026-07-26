import type { ModuleKey } from "../../paths";

/**
 * 逻辑 Agent 标识。
 * - `chat`：AI 助手页专用，纯对话、不注入任何工具（为后续多智能体协作的入口 Agent）
 * - 其余与模块一一对应，各自独立工具域
 */
export type AgentId =
  | "chat"
  | Extract<
      ModuleKey,
      | "terminal" // 含原 SSH（已并入终端模块）
      | "database"
      | "docker"
      | "files"
      | "knowledge"
      | "protocol"
      | "workflow"
      | "tasks"
      | "server"
    >;

/** 工具策略：chat 永不注入工具；模块 Agent 按 moduleFilter 注入 */
export type AgentToolsPolicy =
  | { kind: "none" }
  | { kind: "module"; moduleFilter: string };

export interface AgentDefinition {
  id: AgentId;
  /** i18n key，如 ai.agents.chat */
  labelKey: string;
  /** 简短职责说明 i18n key */
  descriptionKey: string;
  tools: AgentToolsPolicy;
  /** 是否允许 Skills 正文注入 */
  allowSkills: boolean;
  /** 是否允许知识库 RAG 注入 */
  allowRag: boolean;
  /**
   * 追加到 system prompt 的 Agent 身份说明（中文固定文案，后续可 i18n）。
   * 为多智能体协作预留：调度器可据此识别角色。
   */
  systemRole: string;
}

export type AgentRuntimeConfig = {
  agentId: AgentId;
  toolsMode: "none" | { directInject: { moduleFilter: string } };
  allowSkills: boolean;
  allowRag: boolean;
  systemRole: string;
};
