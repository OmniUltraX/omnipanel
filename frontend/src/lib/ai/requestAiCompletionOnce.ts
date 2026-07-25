import { withOptionalBearerAuth, fetchWithNetworkHint } from "../fetchHeaders";
import {
  firstModelSelectionId,
  resolveModelSelection,
  useAiModelsStore,
} from "../../stores/aiModelsStore";
import { resolveTerminalModelSelectionId } from "../terminalScenarioModels";
import {
  isCliBackendId,
  isAcpBackendId,
  resolveBackendFromSelection,
  type ResolvedBackend,
} from "./inferenceBackend";
import { isTauriRuntime } from "../isTauriRuntime";

export const AI_COMPLETION_ONCE_TIMEOUT_MS = 15_000;
export const AI_COMPLETION_ONCE_RETRY_DELAY_MS = 3_000;
export const AI_COMPLETION_ONCE_MAX_RETRIES = 1;

export type AiCompletionOnceResult =
  | { ok: true; content: string }
  | { ok: false; reason: "no-provider" | "request-failed" | "empty-response" };

interface AiModelConfig {
  baseUrl: string;
  apiKey: string;
  name: string;
}

/** 将 selectionId 解析为 HTTP 直连配置（跳过 CLI/ACP）。 */
function resolveHttpConfigFromSelection(selectionId: string | null): AiModelConfig | null {
  if (!selectionId || isCliBackendId(selectionId) || isAcpBackendId(selectionId)) {
    return null;
  }
  // http:{provider}::{model} → {provider}::{model}
  const normalized = selectionId.startsWith("http:")
    ? selectionId.slice("http:".length)
    : selectionId;
  const providers = useAiModelsStore.getState().providers;
  const resolved = resolveModelSelection(providers, normalized);
  if (!resolved) return null;
  return {
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    name: resolved.name,
  };
}

/**
 * 优先终端场景模型（HTTP 时），否则第一个可用 HTTP 模型。
 * CLI/ACP 场景不在这里返回，由内部后端路径兜底。
 */
function resolveHttpAiModelConfig(): AiModelConfig | null {
  const providers = useAiModelsStore.getState().providers;
  if (providers.length === 0) return null;

  const preferred = resolveTerminalModelSelectionId(providers);
  const fromPreferred = resolveHttpConfigFromSelection(preferred);
  if (fromPreferred) return fromPreferred;

  return resolveHttpConfigFromSelection(firstModelSelectionId(providers));
}

function resolveOneShotBackend(): ResolvedBackend | null {
  const providers = useAiModelsStore.getState().providers;
  const preferred = resolveTerminalModelSelectionId(providers);
  if (preferred) {
    const backend = resolveBackendFromSelection(providers, preferred);
    if (backend) return backend;
  }
  const first = firstModelSelectionId(providers);
  if (!first) return null;
  return resolveBackendFromSelection(providers, first);
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, "");
  return clean.includes("/v1")
    ? `${clean}/chat/completions`
    : `${clean}/v1/chat/completions`;
}

/** 剥离推理模型嵌入在 content 里的 <think>...</think> 思考链。 */
function stripThinkTags(text: string): string {
  // 贪心匹配整段 <think>...</think>（含未闭合的半截 fence 也清掉）
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}

/**
 * 解析 OpenAI 兼容响应的 message 文本。
 *
 * @param fallbackToReasoning 默认 false。
 *   - false：只取 `content`，剥离 `<think>` 后为空就返回空（让调用方触发重试/失败）。
 *     适用于 oneshot 纯文本补全（会话命名、历史摘要等）——reasoning_content 是
 *     模型内部思考链（如「用户现在需要给终端会话生成标题...」），不是最终答案。
 *   - true：content 为空时回退 reasoning_content / reasoning（兼容旧的多轮对话行为）。
 */
function extractMessageText(
  data: unknown,
  fallbackToReasoning = false,
): string {
  const message = (data as { choices?: Array<{ message?: Record<string, unknown> }> })
    ?.choices?.[0]?.message;
  if (!message) return "";

  if (typeof message.content === "string") {
    const cleaned = stripThinkTags(message.content);
    if (cleaned) return cleaned;
  }

  if (!fallbackToReasoning) return "";

  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
    return message.reasoning_content.trim();
  }
  if (typeof message.reasoning === "string" && message.reasoning.trim()) {
    return message.reasoning.trim();
  }
  return "";
}

export interface RequestAiCompletionOnceOptions {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  /**
   * 纯文本补全模式（默认 true）。
   * CLI/ACP 后端会跳过工具注入 / preamble / RAG / Skills / 多轮循环，
   * prompt_text 直接用 system + user 拼接，让模型根据 prompt 直接输出文本。
   * 仅在需要让 oneshot 请求也走完整工具链时设为 false。
   */
  pureText?: boolean;
}

async function requestViaHttp(
  config: AiModelConfig,
  options: RequestAiCompletionOnceOptions,
): Promise<AiCompletionOnceResult> {
  const url = buildChatCompletionsUrl(config.baseUrl);
  const timeoutMs = options.timeoutMs ?? AI_COMPLETION_ONCE_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? AI_COMPLETION_ONCE_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? AI_COMPLETION_ONCE_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, retryDelayMs));
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    if (options.signal) {
      options.signal.addEventListener("abort", () => controller.abort());
    }

    try {
      // pureText（默认 true）：oneshot 纯文本补全场景，禁用推理模型的思考链。
      // - 响应解析不再回退 reasoning_content（那是内部思考，不是最终答案）
      // - 请求体注入业界通用的「关闭思考」参数，被支持的模型会直接输出答案；
      //   不支持的模型会忽略这些字段，无副作用。
      const isPureText = options.pureText ?? true;
      const response = await fetchWithNetworkHint(url, {
        method: "POST",
        headers: withOptionalBearerAuth(
          { "Content-Type": "application/json" },
          config.apiKey,
        ),
        body: JSON.stringify({
          model: config.name,
          messages: [
            { role: "system", content: options.system },
            { role: "user", content: options.user },
          ],
          temperature: options.temperature ?? 0.3,
          max_tokens: options.maxTokens ?? 512,
          ...(isPureText
            ? {
                // DeepSeek / Qwen / GLM 等推理模型通用开关
                enable_thinking: false,
                // OpenAI o-series / 部分第三方网关
                reasoning_effort: "none",
                chat_template_kwargs: { enable_thinking: false },
              }
            : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) continue;

      const data = await response.json();
      // pureText 时不回退 reasoning_content：模型若只输出思考链没出最终答案，
      // 视为空响应触发重试，避免把「用户现在需要给终端会话生成标题...」当成标题。
      const content = extractMessageText(data, !isPureText);
      if (!content) continue;

      return { ok: true, content };
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        return { ok: false, reason: "request-failed" };
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: false, reason: "request-failed" };
}

/** CLI / ACP：走内部 ai_chat_stream（toolsMode=none），聚合正文。 */
async function requestViaInternalBackend(
  backend: ResolvedBackend,
  options: RequestAiCompletionOnceOptions,
): Promise<AiCompletionOnceResult> {
  if (!isTauriRuntime()) return { ok: false, reason: "no-provider" };

  const { runInternalAiChat } = await import("./orchestrator");
  const timeoutMs = options.timeoutMs ?? AI_COMPLETION_ONCE_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    options.signal.addEventListener("abort", () => controller.abort());
  }

  let content = "";
  let reasoning = "";
  let sawError = false;

  try {
    await runInternalAiChat({
      request: {
        conversationId: `ai-once-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        // CLI/ACP 后端只有 userText 通道，且后端会注入 CLIENT_TOOLS_PREAMBLE +
        // master 工具清单。简单拼接 system + user 保持与历史可用版本一致的结构，
        // 元描述 / 复述任务的防御由 system prompt 加强 + isMetaRestatement 兜底过滤处理。
        userText: `${options.system}\n\n${options.user}`,
        backendId: backend.backendId,
        context: {},
        toolsMode: "none",
        httpProvider: backend.kind === "http" ? backend.httpProvider : null,
        // oneshot 纯文本补全：跳过工具注入 / preamble / 多轮循环
        pureText: options.pureText ?? true,
      },
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "content_delta") content += event.text;
        if (event.type === "reasoning_delta") reasoning += event.text;
        if (event.type === "error") sawError = true;
      },
    });
  } catch {
    return { ok: false, reason: "request-failed" };
  } finally {
    clearTimeout(timeout);
  }

  if (sawError) return { ok: false, reason: "request-failed" };
  const isPureText = options.pureText ?? true;
  const cleanedContent = stripThinkTags(content);
  // pureText 时不回退 reasoning：reasoning 是模型内部思考链
  // （如「用户现在需要给终端会话生成标题...」），不是最终答案
  const text = cleanedContent || (isPureText ? "" : reasoning.trim());
  if (!text) return { ok: false, reason: "empty-response" };
  return { ok: true, content: text };
}

/** 一次性非流式 AI 补全（会话命名、历史摘要等共用） */
export async function requestAiCompletionOnce(
  options: RequestAiCompletionOnceOptions,
): Promise<AiCompletionOnceResult> {
  const httpConfig = resolveHttpAiModelConfig();
  if (httpConfig) {
    return requestViaHttp(httpConfig, options);
  }

  // 无 HTTP 模型时：CLI / ACP 兜底（终端场景若配置了 CLI 仍可命名）
  const backend = resolveOneShotBackend();
  if (!backend) return { ok: false, reason: "no-provider" };
  if (backend.kind === "http") {
    return requestViaHttp(
      {
        baseUrl: backend.httpProvider.baseUrl,
        apiKey: backend.httpProvider.apiKey,
        name: backend.backendId.includes("::")
          ? backend.backendId.slice(backend.backendId.lastIndexOf("::") + 2)
          : backend.httpProvider.providerId,
      },
      options,
    );
  }

  return requestViaInternalBackend(backend, options);
}
