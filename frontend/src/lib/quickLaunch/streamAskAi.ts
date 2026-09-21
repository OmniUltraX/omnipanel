/**
 * 快捷启动「询问 AI」：走 CLI 智能体 pureText 流式补全。
 * 使用临时 conversationId，与主窗 AI 抽屉会话隔离。
 */
import { resolveScenarioModelSelectionId } from "../aiScenarioModels";
import { resolveBackendFromSelection } from "../ai/inferenceBackend";
import { canUseAiBackend } from "../isTauriRuntime";
import { initAiModelsStore, useAiModelsStore } from "../../stores/aiModelsStore";
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

/**
 * 页内流式询问：CLI `runInternalAiChat`（pureText），与主窗会话隔离。
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

  const providers = useAiModelsStore.getState().providers;
  const selectionId = resolveScenarioModelSelectionId(
    providers,
    useSettingsStore.getState().aiScenarioAssistantModelSelectionId,
  );
  const backend = resolveBackendFromSelection(providers, selectionId);
  if (!backend) {
    return {
      ok: false,
      reason: "no-provider",
      message: "请先启用智能体",
    };
  }

  const { runInternalAiChat } = await import("../ai/orchestrator");
  let content = "";
  let sawError = false;
  let errorMessage: string | undefined;

  try {
    await runInternalAiChat({
      request: {
        conversationId: `ql-ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        userText: `${SYSTEM_PROMPT}\n\n${prompt}`,
        backendId: backend.backendId,
        context: {},
        toolsMode: "none",
        httpProvider: null,
        pureText: true,
      },
      signal: options.signal,
      onEvent: (event) => {
        if (event.type === "content_delta") {
          content += event.text;
          options.onDelta?.(content);
        }
        if (event.type === "error") {
          sawError = true;
          errorMessage = event.message;
        }
      },
    });
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
  if (sawError) {
    return {
      ok: false,
      reason: "request-failed",
      message: errorMessage ?? "request-failed",
    };
  }
  const trimmed = content.trim();
  if (!trimmed) {
    return { ok: false, reason: "request-failed", message: "empty-response" };
  }
  return { ok: true, content: trimmed };
}
