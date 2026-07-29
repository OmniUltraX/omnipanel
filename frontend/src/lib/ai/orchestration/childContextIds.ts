/**
 * 子会话上下文标识继承规则（纯函数，无 store 依赖）。
 */
import type { ModuleKey } from "../../paths";
import { isAgentId } from "../agents";

/** 需要注入 moduleContextAppend 的模块 Agent（terminal 走 terminal 通道） */
const MODULE_APPEND_AGENT_IDS = new Set<string>([
  "database",
  "docker",
  "files",
  "knowledge",
  "protocol",
  "workflow",
  "tasks",
  "server",
]);

export interface ChildContextIdInput {
  parentWorkspaceId: string | null;
  childWorkspaceId: string | null;
  childTerminalSessionId: string | null;
  childAgentId: string | null | undefined;
  spawnResourceId: string | null | undefined;
  parentResourceId: string | null | undefined;
  parentEnvTag: string | null | undefined;
}

export interface ChildContextIds {
  workspaceId: string | null;
  terminalSessionId: string | null;
  resourceId: string | null;
  envTag: string | null;
  /** 非 terminal 模块时用于拉取 live module append */
  moduleKeyForAppend: ModuleKey | null;
}

/** 决定子会话应继承的标识字段 */
export function resolveChildContextIds(input: ChildContextIdInput): ChildContextIds {
  const workspaceId = input.childWorkspaceId ?? input.parentWorkspaceId ?? null;
  const terminalSessionId = input.childTerminalSessionId ?? null;
  const resourceId = input.spawnResourceId ?? input.parentResourceId ?? null;
  const envTag = input.parentEnvTag ?? null;

  let moduleKeyForAppend: ModuleKey | null = null;
  const agentId = input.childAgentId;
  if (agentId && MODULE_APPEND_AGENT_IDS.has(agentId) && isAgentId(agentId)) {
    moduleKeyForAppend = agentId as ModuleKey;
  }

  return { workspaceId, terminalSessionId, resourceId, envTag, moduleKeyForAppend };
}
