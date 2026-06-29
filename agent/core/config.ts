import fs from "node:fs";
import path from "node:path";

import type { McpServer } from "@agentclientprotocol/sdk";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { initChatModel } from "langchain";

/** OmniPanel 写入的 agent 配置文件结构（app_data_dir/acp-agent-config.json）。 */
export type OmniAgentConfigFile = {
  version?: number;
  model: string;
  apiKey: string;
  baseUrl: string;
  apiStandard: "openai" | "anthropic";
  /** 为 true 时对 OpenAI 兼容 API 传递 enable_thinking（DashScope 等思考模型）。默认 true。 */
  enableThinking?: boolean;
  mcpServers?: McpServer[];
};

let cachedConfig: OmniAgentConfigFile | null | undefined;

function resolveConfigPath(): string | null {
  const fromEnv = process.env.OMNIAGENT_CONFIG?.trim();
  if (fromEnv) return fromEnv;
  return null;
}

/** 读取 OmniPanel 写入的配置文件；未设置 OMNIAGENT_CONFIG 时返回 null。 */
export function loadAgentConfigFile(forceReload = false): OmniAgentConfigFile | null {
  if (forceReload) {
    cachedConfig = undefined;
  }
  if (cachedConfig !== undefined) {
    return cachedConfig;
  }

  const configPath = resolveConfigPath();
  if (!configPath) {
    cachedConfig = null;
    return null;
  }

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as OmniAgentConfigFile;
    if (!parsed.model?.trim() || !parsed.apiKey?.trim() || !parsed.baseUrl?.trim()) {
      log("配置文件缺少 model/apiKey/baseUrl:", configPath);
      cachedConfig = null;
      return null;
    }
    const rawBaseUrl = parsed.baseUrl.trim().replace(/\/+$/, "");
    const baseUrl = rawBaseUrl;
    if (baseUrl !== rawBaseUrl) {
      log(
        "阿里云 MaaS 工作空间域名与 LangChain 不兼容，已改用 dashscope OpenAI 端点:",
        baseUrl,
      );
    }
    cachedConfig = {
      version: parsed.version ?? 1,
      model: parsed.model.trim(),
      apiKey: parsed.apiKey.trim(),
      baseUrl,
      apiStandard: parsed.apiStandard === "anthropic" ? "anthropic" : "openai",
      enableThinking: parsed.enableThinking !== false,
      mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [],
    };
    log(
      "已加载配置:",
      path.basename(configPath),
      cachedConfig.model,
      "mcp=",
      cachedConfig.mcpServers?.length ?? 0,
    );
    return cachedConfig;
  } catch (error) {
    log("读取配置失败:", configPath, error);
    cachedConfig = null;
    return null;
  }
}

/** 从配置文件读取 OmniPanel 同步的 MCP 服务列表。 */
export function resolveMcpServersFromConfig(): McpServer[] {
  const config = loadAgentConfigFile(true);
  return config?.mcpServers ?? [];
}

/** 将配置应用到进程环境变量，供 LangChain / DeepAgents 使用。 */
export function applyAgentConfigToEnv(config: OmniAgentConfigFile): void {
  if (config.apiStandard === "anthropic") {
    process.env.ANTHROPIC_API_KEY = config.apiKey;
    process.env.ANTHROPIC_BASE_URL = config.baseUrl;
    return;
  }

  process.env.OPENAI_API_KEY = config.apiKey;
  process.env.OPENAI_BASE_URL = config.baseUrl;
  process.env.OPENAI_API_BASE = config.baseUrl;
}

/** LangChain model 字符串，例如 openai:gpt-4o-mini */
export function resolveLangChainModelId(config: OmniAgentConfigFile): string {
  const provider = config.apiStandard === "anthropic" ? "anthropic" : "openai";
  return `${provider}:${config.model}`;
}

/** 根据 OmniPanel 配置创建 LangChain ChatModel（OpenAI 兼容协议显式传入 baseURL / apiKey）。 */
export async function createChatModelFromConfig(
  config: OmniAgentConfigFile,
): Promise<BaseChatModel> {
  const modelId = resolveLangChainModelId(config);

  if (config.apiStandard === "anthropic") {
    return initChatModel(modelId, {
      apiKey: config.apiKey,
      clientOptions: { baseURL: config.baseUrl },
    });
  }

  const openAiOptions: Record<string, unknown> = {
    apiKey: config.apiKey,
    configuration: { baseURL: config.baseUrl },
  };
  if (config.enableThinking !== false) {
    openAiOptions.modelKwargs = { enable_thinking: true };
  }
  return initChatModel(modelId, openAiOptions);
}

function log(...args: unknown[]): void {
  console.error("[omniagent:config]", ...args);
}
