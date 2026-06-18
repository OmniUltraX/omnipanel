import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import { commands } from "../../../ipc/bindings";

export interface AgentMcpConnection {
  serviceId: string;
  serviceName: string;
  builtin: boolean;
  toolCount: number;
}

export interface AgentMcpToolsBundle {
  tools: DynamicStructuredTool[];
  connections: AgentMcpConnection[];
  cacheKey: string;
}

function makeToolLangName(serviceId: string, toolName: string): string {
  const sid = serviceId.replace(/[^a-zA-Z0-9_]/g, "_");
  return `mcp_${sid}_${toolName}`.slice(0, 64);
}

/** 加载所有运行中 MCP 服务的工具，供 LangChain 智能体使用 */
export async function loadAgentMcpTools(): Promise<AgentMcpToolsBundle> {
  const listResult = await commands.mcpListServices();
  if (listResult.status !== "ok") {
    return { tools: [], connections: [], cacheKey: "" };
  }

  const running = listResult.data.filter((s) => s.status === "running");
  const tools: DynamicStructuredTool[] = [];
  const connections: AgentMcpConnection[] = [];

  for (const service of running) {
    const toolsResult = await commands.mcpListServiceTools(service.id);
    if (toolsResult.status !== "ok") {
      connections.push({
        serviceId: service.id,
        serviceName: service.name,
        builtin: service.builtin,
        toolCount: 0,
      });
      continue;
    }

    const toolNames: string[] = [];
    for (const tool of toolsResult.data) {
      toolNames.push(tool.name);
      const langName = makeToolLangName(service.id, tool.name);
      const serviceId = service.id;
      const originalName = tool.name;

      tools.push(
        new DynamicStructuredTool({
          name: langName,
          description: `[${service.name}] ${tool.description ?? tool.name}`,
          schema: z
            .record(z.string(), z.unknown())
            .describe("MCP 工具参数（键值对象）"),
          func: async (input) => {
            const result = await commands.mcpCallTool(
              serviceId,
              originalName,
              JSON.stringify(input ?? {}),
            );
            if (result.status !== "ok") {
              throw new Error(result.error ?? "MCP 工具调用失败");
            }
            if (result.data.isError) {
              throw new Error(result.data.content || "MCP 工具返回错误");
            }
            return result.data.content;
          },
        }),
      );
    }

    connections.push({
      serviceId: service.id,
      serviceName: service.name,
      builtin: service.builtin,
      toolCount: toolNames.length,
    });
  }

  const cacheKey = connections
    .map((c) => `${c.serviceId}:${c.toolCount}`)
    .join("|");

  return { tools, connections, cacheKey };
}
