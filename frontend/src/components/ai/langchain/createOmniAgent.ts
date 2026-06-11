import { createAgent } from "langchain";

import type { ApiStandard } from "../../../stores/aiModelsStore";

export interface OmniModelConfig {
  apiStandard: ApiStandard;
  name: string;
  baseUrl: string;
  apiKey: string;
}

export const OMNI_SYSTEM_PROMPT = [
  "你是 OmniPanel 内置 AI 助手，帮助用户理解代码、命令、SQL、Docker 与排障流程。",
  "回答使用 Markdown；涉及高风险操作时仅给出建议，不要假设已执行。",
].join("\n");

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

function buildCacheKey(config: OmniModelConfig): string {
  return `${config.apiStandard}:${config.baseUrl}:${config.name}`;
}

/** 创建（或复用缓存）LangChain ReAct 智能体（纯对话，无工具） */
export async function getOmniAgent(config: OmniModelConfig): Promise<OmniAgent> {
  const key = buildCacheKey(config);
  if (cachedAgent?.key === key) {
    return cachedAgent.agent;
  }

  const agent = createAgent({
    model: await getOmniChatModel(config),
    tools: [],
    prompt: OMNI_SYSTEM_PROMPT,
  });

  cachedAgent = { key, agent };
  return agent;
}

/** 创建（或复用缓存）Chat 模型实例 */
export async function getOmniChatModel(config: OmniModelConfig): Promise<OmniChatModel> {
  const key = buildCacheKey(config);
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
