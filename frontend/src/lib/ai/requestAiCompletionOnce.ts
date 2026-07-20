import { withOptionalBearerAuth, fetchWithNetworkHint } from "../fetchHeaders";
import {
  firstModelSelectionId,
  resolveModelSelection,
  useAiModelsStore,
} from "../../stores/aiModelsStore";

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

function resolveAiModelConfig(): AiModelConfig | null {
  const providers = useAiModelsStore.getState().providers;
  if (providers.length === 0) return null;
  const selectionId = firstModelSelectionId(providers);
  if (!selectionId) return null;
  const resolved = resolveModelSelection(providers, selectionId);
  if (!resolved) return null;
  return {
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    name: resolved.name,
  };
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, "");
  return clean.includes("/v1")
    ? `${clean}/chat/completions`
    : `${clean}/v1/chat/completions`;
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

/** 一次性非流式 AI 补全（会话命名、历史摘要等共用） */
export async function requestAiCompletionOnce(
  options: RequestAiCompletionOnceOptions,
): Promise<AiCompletionOnceResult> {
  const config = resolveAiModelConfig();
  if (!config) return { ok: false, reason: "no-provider" };

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

      if (!response.ok) {
        continue;
      }

      const data = await response.json();
      const content: string | undefined = data?.choices?.[0]?.message?.content;
      if (!content?.trim()) {
        continue;
      }

      return { ok: true, content: content.trim() };
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
