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

/** 兼容 reasoning 模型：正文空时回退 reasoning_content。 */
function extractMessageText(data: unknown): string {
  const message = (data as { choices?: Array<{ message?: Record<string, unknown> }> })
    ?.choices?.[0]?.message;
  if (!message) return "";
  if (typeof message.content === "string" && message.content.trim()) {
    return message.content.trim();
  }
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
        }),
        signal: controller.signal,
      });

      if (!response.ok) continue;

      const data = await response.json();
      const content = extractMessageText(data);
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
        userText: `${options.system}\n\n${options.user}`,
        backendId: backend.backendId,
        context: {},
        toolsMode: "none",
        httpProvider: backend.kind === "http" ? backend.httpProvider : null,
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
  const text = content.trim() || reasoning.trim();
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
