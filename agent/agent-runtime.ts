import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { MultiServerMCPClient, type Connection } from "@langchain/mcp-adapters";
import { createDeepAgent, type DeepAgent } from "deepagents";
import {
  applyAgentConfigToEnv,
  loadAgentConfigFile,
  resolveLangChainModelId,
  resolveMcpServersFromConfig,
} from "./config.js";

const agentRoot = path.dirname(fileURLToPath(import.meta.url));

export type SessionRuntime = {
  sessionId: string;
  cwd: string;
  graph: DeepAgent;
  mcpClient: MultiServerMCPClient | null;
};

function envVarsToRecord(env: Array<{ name: string; value: string }>): Record<string, string> {
  return Object.fromEntries(env.map((item) => [item.name, item.value]));
}

function headersToRecord(headers: Array<{ name: string; value: string }>): Record<string, string> {
  return Object.fromEntries(headers.map((item) => [item.name, item.value]));
}

/** Skills 目录：可用 OMNIAGENT_SKILLS_DIRS（PATH 分隔）覆盖。 */
export function resolveSkillsDirs(): string[] {
  const fromEnv = process.env.OMNIAGENT_SKILLS_DIRS;
  if (fromEnv?.trim()) {
    return fromEnv
      .split(path.delimiter)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [path.join(agentRoot, "skills")];
}

/** 将 ACP session/new 中的 MCP 配置转为 @langchain/mcp-adapters 连接。 */
export function acpMcpServersToConnections(servers: McpServer[]): Record<string, Connection> {
  const connections: Record<string, Connection> = {};

  for (const server of servers) {
    if ("command" in server && typeof server.command === "string") {
      connections[server.name] = {
        transport: "stdio",
        command: server.command,
        args: server.args ?? [],
        env: envVarsToRecord(server.env ?? []),
      };
      continue;
    }

    if ("type" in server && server.type === "http" && "url" in server) {
      connections[server.name] = {
        url: server.url,
        headers: headersToRecord(server.headers ?? []),
      };
      continue;
    }

    if ("type" in server && server.type === "sse" && "url" in server) {
      connections[server.name] = {
        url: server.url,
        headers: headersToRecord(server.headers ?? []),
        transport: "sse",
      };
    }
  }

  return connections;
}

export async function createSessionRuntime(
  sessionId: string,
  cwd: string,
): Promise<SessionRuntime> {
  const skills = resolveSkillsDirs();
  let mcpClient: MultiServerMCPClient | null = null;
  let mcpTools: DynamicStructuredTool[] = [];

  const mcpServers = resolveMcpServersFromConfig();
  const connections = acpMcpServersToConnections(mcpServers);
  if (Object.keys(connections).length > 0) {
    try {
      mcpClient = new MultiServerMCPClient(connections);
      mcpTools = await mcpClient.getTools();
    } catch (error) {
      console.error("[omniagent:runtime] MCP 工具加载失败，继续无 MCP 运行:", error);
      await mcpClient?.close().catch(() => {});
      mcpClient = null;
      mcpTools = [];
    }
  }

  const fileConfig = loadAgentConfigFile();
  if (!fileConfig) {
    throw new Error(
      "未找到 OmniPanel agent 配置。请在 OmniPanel「设置 → Agent」中配置模型与 API，并连接 Agent。",
    );
  }

  applyAgentConfigToEnv(fileConfig);
  const model = resolveLangChainModelId(fileConfig);

  const graph = createDeepAgent({
    model,
    tools: mcpTools,
    skills,
    checkpointer: new MemorySaver(),
    systemPrompt:
      process.env.OMNIAGENT_SYSTEM_PROMPT ??
      "你是 OmniPanel 本地编码助手。按需读取 Skills、调用 MCP 工具完成任务。回答简洁、可执行。",
  });

  return { sessionId, cwd, graph, mcpClient };
}

export async function disposeSessionRuntime(runtime: SessionRuntime): Promise<void> {
  if (runtime.mcpClient) {
    await runtime.mcpClient.close();
  }
}
