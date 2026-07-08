import type { ModuleKey } from "../../paths";

export type ModuleContextScope = `module:${ModuleKey}`;
export type WorkspaceContextScope = `workspace:${string}`;
export type AiContextScope = ModuleContextScope | WorkspaceContextScope;

/** 模块 / 工作区注册的内置工具 */
export interface BuiltinToolRegistration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}
