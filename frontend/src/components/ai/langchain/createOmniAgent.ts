import { createAgent } from "langchain";
import type { DynamicStructuredTool } from "@langchain/core/tools";

import type { ApiStandard } from "../../../stores/aiModelsStore";

export interface OmniModelConfig {
  apiStandard: ApiStandard;
  name: string;
  baseUrl: string;
  apiKey: string;
}

export const OMNI_SYSTEM_PROMPT = `
你是OmniPanel的内置AI助手, OmniPanel是一个All in One的运维工具, 你可以帮助用户完成日常的运维工作.
以下为工作的标准底线，必须严格遵守：
+ 回答时语言要精炼, 有条理, 使用Markdown格式.
+ 对于上下文不充足的任务要先查询知识库或上网查阅资料, 如果还是不充分则向用户提问, 绝不能靠猜测给出答案.
+ 当已连接 MCP 工具时，优先使用工具获取准确信息，再组织回答.
`;

const MCP_SYSTEM_SUFFIX =
  "\n\n当前已接入 MCP（Model Context Protocol）工具，工具名以 mcp_ 开头。请在需要时主动调用。";

export type OmniAgent = ReturnType<typeof createAgent>;
export type OmniChatModel = Awaited<ReturnType<typeof createChatModel>>;

let cachedAgent: { key: string; agent: OmniAgent } | null = null;
let cachedModel: { key: string; model: OmniChatModel } | null = null;

export async function createChatModel(config: OmniModelConfig) {
  if (config.apiStandard === "anthropic") {
    const { ChatAnthropic } = await import("@langchain/anthropic");
    return new ChatAnthropic({
      model: config.name,
      apiKey: config.apiKey,
      anthropicApiUrl: config.baseUrl,
    });
  }
  const { ChatOpenAI } = await import("@langchain/openai");
  return new ChatOpenAI({
    model: config.name,
    apiKey: config.apiKey,
    configuration: { baseURL: config.baseUrl },
  });
}

function buildCacheKey(config: OmniModelConfig, mcpToolsKey: string): string {
  return `${config.apiStandard}:${config.baseUrl}:${config.name}|mcp:${mcpToolsKey}`;
}

/** 创建（或复用缓存）LangChain ReAct 智能体 */
export async function getOmniAgent(
  config: OmniModelConfig,
  tools: DynamicStructuredTool[] = [],
  mcpToolsKey = "",
): Promise<OmniAgent> {
  const key = buildCacheKey(config, mcpToolsKey);
  if (cachedAgent?.key === key) {
    return cachedAgent.agent;
  }

  const systemPrompt =
    tools.length > 0 ? OMNI_SYSTEM_PROMPT + MCP_SYSTEM_SUFFIX : OMNI_SYSTEM_PROMPT;

  const agent = createAgent({
    model: await getOmniChatModel(config),
    tools,
    systemPrompt,
  });

  cachedAgent = { key, agent };
  return agent;
}

/** 创建（或复用缓存）Chat 模型实例 */
export async function getOmniChatModel(config: OmniModelConfig): Promise<OmniChatModel> {
  const key = buildCacheKey(config, "");
  if (cachedModel?.key === key) {
    return cachedModel.model;
  }
  const model = await createChatModel(config);
  cachedModel = { key, model };
  return model;
}

export function resetOmniAgentCache(): void {
  cachedAgent = null;
  cachedModel = null;
}
