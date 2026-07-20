import {
  getAllModuleBuiltinToolInfos,
  parseModuleKeyFromToolName,
} from "./context/moduleBuiltinCatalog";
import type { BuiltinToolRegistration } from "./context/types";
import { TERMINAL_MODULE_TOOLS } from "../../modules/terminal/ai/mcpTools";
import { DATABASE_MODULE_TOOLS } from "../../modules/database/ai/mcpTools";
import { DOCKER_MODULE_TOOLS } from "../../modules/docker/ai/mcpTools";
import { FILES_MODULE_TOOLS } from "../../modules/files/ai/mcpTools";
import { KNOWLEDGE_MODULE_TOOLS } from "../../modules/knowledge/ai/mcpTools";
import { SSH_MODULE_TOOLS } from "../../modules/server/ssh/ai/mcpTools";

type ToolHandler = BuiltinToolRegistration["handler"];

const TOOL_HANDLERS = new Map<string, ToolHandler>();

export const TERMINAL_BUILTIN_TOOL_NAME = "omni_terminal_run_terminal_command";

function registerHandlers(tools: BuiltinToolRegistration[]): void {
  for (const tool of tools) {
    TOOL_HANDLERS.set(tool.name, tool.handler);
  }
}

/**
 * 启动时注册各模块内置工具 handler（UiDelegated 工具执行表）。
 *
 * 统一通道架构下，所有 UiDelegated 工具由后端挂起、前端 `dispatchPendingTool`
 * 分派执行：终端走内联审批 dock，其余模块走这里注册的 handler。
 */
export function registerToolHandlers(): void {
  TOOL_HANDLERS.clear();
  registerHandlers(TERMINAL_MODULE_TOOLS);
  registerHandlers(DATABASE_MODULE_TOOLS);
  registerHandlers(DOCKER_MODULE_TOOLS);
  registerHandlers(FILES_MODULE_TOOLS);
  registerHandlers(KNOWLEDGE_MODULE_TOOLS);
  registerHandlers(SSH_MODULE_TOOLS);
}

export function getToolHandler(toolName: string): ToolHandler | undefined {
  return TOOL_HANDLERS.get(toolName);
}

export function listRegisteredToolNames(): string[] {
  return [...TOOL_HANDLERS.keys()];
}

/** 供设置页展示：合并 catalog 与已注册 handler。 */
export function listToolHostCatalog() {
  return getAllModuleBuiltinToolInfos().map((info) => ({
    ...info,
    hasHandler: TOOL_HANDLERS.has(info.name),
    moduleKey: parseModuleKeyFromToolName(info.name),
  }));
}
