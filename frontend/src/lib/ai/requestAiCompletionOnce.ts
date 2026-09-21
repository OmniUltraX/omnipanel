import {
  firstCliSelectionId,
  resolveBackendFromSelection,
  type ResolvedBackend,
} from "./inferenceBackend";
import { canUseAiBackend } from "../isTauriRuntime";
import { useAiModelsStore } from "../../stores/aiModelsStore";
import { resolveTerminalModelSelectionId } from "../terminalScenarioModels";

export const AI_COMPLETION_ONCE_TIMEOUT_MS = 15_000;
export const AI_COMPLETION_ONCE_RETRY_DELAY_MS = 3_000;
export const AI_COMPLETION_ONCE_MAX_RETRIES = 1;

export type AiCompletionOnceResult =
  | { ok: true; content: string }
  | { ok: false; reason: "no-provider" | "request-failed" | "empty-response" };

function resolveOneShotBackend(): ResolvedBackend | null {
  const providers = useAiModelsStore.getState().providers;
  const preferred = resolveTerminalModelSelectionId(providers);
  if (preferred) {
    const backend = resolveBackendFromSelection(providers, preferred);
    if (backend) return backend;
  }
  return resolveBackendFromSelection(providers, firstCliSelectionId());
}

/** 剥离推理模型嵌入在 content 里的 <think>...</think> 思考链。 */
function stripThinkTags(text: string): string {
  // 贪心匹配整段 <think>...</think>（含未闭合的半截 fence 也清掉）
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
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
   * CLI 后端会跳过工具注入 / preamble / RAG / Skills / 多轮循环，
   * prompt_text 直接用 system + user 拼接，让模型根据 prompt 直接输出文本。
   * 仅在需要让 oneshot 请求也走完整工具链时设为 false。
   */
  pureText?: boolean;
}

/** CLI：走内部 ai_chat_stream（toolsMode=none），聚合正文。 */
async function requestViaInternalBackend(
  backend: ResolvedBackend,
  options: RequestAiCompletionOnceOptions,
): Promise<AiCompletionOnceResult> {
  if (!canUseAiBackend()) return { ok: false, reason: "no-provider" };

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
        // CLI 后端只有 userText 通道，且后端会注入 CLIENT_TOOLS_PREAMBLE +
        // master 工具清单。简单拼接 system + user 保持与历史可用版本一致的结构，
        // 元描述 / 复述任务的防御由 system prompt 加强 + isMetaRestatement 兜底过滤处理。
        userText: `${options.system}\n\n${options.user}`,
        backendId: backend.backendId,
        context: {},
        toolsMode: "none",
        httpProvider: null,
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

/**
 * 一次性非流式 AI 补全（会话命名、历史摘要等共用）。
 *
 * 一律走 `runInternalAiChat`（pureText）+ CLI 智能体，与 Dock 对话同路。
 * 禁止新开前端 fetch：那是第四条推理路径（与编排 / Agent Router / OmniMCP 并列）。
 */
export async function requestAiCompletionOnce(
  options: RequestAiCompletionOnceOptions,
): Promise<AiCompletionOnceResult> {
  const backend = resolveOneShotBackend();
  if (backend && canUseAiBackend()) {
    return requestViaInternalBackend(backend, options);
  }

  return { ok: false, reason: "no-provider" };
}
