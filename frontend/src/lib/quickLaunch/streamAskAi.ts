/**
 * 快捷启动「询问 AI」：仅在启动窗内 HTTP 流式补全。
 * 不走 ai_chat_stream / 会话体系，避免牵动主窗 AI 抽屉。
 */
import { streamModelChat, type ModelConfig } from "../../components/ai/assistant-ui/chatModel";
import { resolveScenarioModelSelectionId } from "../aiScenarioModels";
import {
  isAcpBackendId,
  isCliBackendId,
  resolveBackendFromSelection,
} from "../ai/inferenceBackend";
import { canUseAiBackend } from "../isTauriRuntime";
import {
  initAiModelsStore,
  resolveModelSelection,
  resolveProviderApiKey,
  useAiModelsStore,
} from "../../stores/aiModelsStore";
import { useSettingsStore } from "../../stores/settingsStore";

const SYSTEM_PROMPT =
  "你是 OmniPanel 快捷助手。用简洁、可执行的方式回答用户问题；需要时给出步骤或命令，避免冗长开场。";

export type StreamQuickLauncherAskAiResult =
  | { ok: true; content: string }
  | { ok: false; reason: "no-provider" | "request-failed" | "aborted"; message?: string };

export interface StreamQuickLauncherAskAiOptions {
  prompt: string;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

async function resolveHttpModelConfig(): Promise<ModelConfig | null> {
  const providers = useAiModelsStore.getState().providers;
  if (providers.length === 0) return null;

  const selectionId = resolveScenarioModelSelectionId(
    providers,
    useSettingsStore.getState().aiScenarioAssistantModelSelectionId,
  );
  if (!selectionId) return null;
  if (isCliBackendId(selectionId) || isAcpBackendId(selectionId)) return null;

  const backend = resolveBackendFromSelection(providers, selectionId);
  if (!backend || backend.kind !== "http") return null;

  const provider = providers.find((p) => p.id === backend.httpProvider.providerId);
  if (!provider) return null;

  const resolved = resolveModelSelection(providers, selectionId);
  if (!resolved) return null;

  const apiKey = (await resolveProviderApiKey(provider)).trim() || resolved.apiKey.trim();
  // 无明文 key 时仍可走 streamPostViaTauri：后端会按 URL 代理；部分提供商需 key。
  return {
    apiStandard: resolved.apiStandard,
    name: resolved.name,
    baseUrl: resolved.baseUrl,
    apiKey,
  };
}

/**
 * 页内流式询问：优先 HTTP `streamModelChat`，与主窗会话完全隔离。
 */
export async function streamQuickLauncherAskAi(
  options: StreamQuickLauncherAskAiOptions,
): Promise<StreamQuickLauncherAskAiResult> {
  const prompt = options.prompt.trim();
  if (!prompt) {
    return { ok: false, reason: "request-failed", message: "empty prompt" };
  }
  if (!canUseAiBackend()) {
    return { ok: false, reason: "no-provider", message: "AI backend unavailable" };
  }

  await initAiModelsStore();
  if (options.signal?.aborted) {
    return { ok: false, reason: "aborted" };
  }

  const config = await resolveHttpModelConfig();
  if (!config) {
    return {
      ok: false,
      reason: "no-provider",
      message: "需要已配置的 HTTP 模型（CLI/ACP 暂不支持快捷启动页内问答）",
    };
  }

  let content = "";
  try {
    for await (const chunk of streamModelChat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      config,
      [],
      { signal: options.signal },
    )) {
      if (options.signal?.aborted) {
        return { ok: false, reason: "aborted" };
      }
      if (chunk.type === "text" && chunk.delta) {
        content += chunk.delta;
        options.onDelta?.(content);
      }
    }
  } catch (e) {
    if (options.signal?.aborted || (e as Error)?.name === "AbortError") {
      return { ok: false, reason: "aborted" };
    }
    return {
      ok: false,
      reason: "request-failed",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  if (options.signal?.aborted) {
    return { ok: false, reason: "aborted" };
  }
  const trimmed = content.trim();
  if (!trimmed) {
    return { ok: false, reason: "request-failed", message: "empty-response" };
  }
  return { ok: true, content: trimmed };
}
