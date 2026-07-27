import type { ModuleKey } from "../../paths";

/**
 * 逻辑 Agent 标识。
 * - `plan`：AI 助手页 Plan 模式，主责制定执行计划；仅全局工具（含 `omni_create_todolist`）
 * - `run`：AI 助手页 Run 模式，可调用全部工具直接执行
 * - 其余与模块一一对应，各自独立工具域
 */
export type AgentId =
  | "plan"
  | "run"
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

/** 工具策略 */
export type AgentToolsPolicy =
  | { kind: "none" }
  | { kind: "module"; moduleFilter: string }
  /** 仅注入列出的工具 */
  | { kind: "allowlist"; toolNames: string[]; moduleFilter?: string };

export interface AgentDefinition {
  id: AgentId;
  /** i18n key，如 ai.agents.plan */
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

export type AgentToolsMode =
  | "none"
  | {
      directInject: {
        moduleFilter?: string | null;
        toolAllowlist?: string[] | null;
      };
    };

export type AgentRuntimeConfig = {
  agentId: AgentId;
  toolsMode: AgentToolsMode;
  allowSkills: boolean;
  allowRag: boolean;
  systemRole: string;
};
