import type { McpServer } from "@agentclientprotocol/sdk";

/** 模块 Agent 定义：提示词与 MCP 由模块提供，模型等从公共配置读取。 */
export type ModuleAgentDefinition = {
  moduleKey: string;
  systemPrompt: string;
  mcpServers: McpServer[];
};
