import { commands, type LocalRuntimeProbeResult } from "../ipc/bindings";
import { syncEmbeddingProviderToBackend } from "./syncEmbeddingProvider";
import {
  buildModelSelectionId,
  useAiModelsStore,
} from "../stores/aiModelsStore";
import { useSettingsStore } from "../stores/settingsStore";
import { DEFAULT_KNOWLEDGE_EMBEDDING_OLLAMA_MODEL } from "./knowledgeEmbeddingModel";

export const LOCAL_OLLAMA_PROVIDER_ID = "local-ollama";
export const LOCAL_LMSTUDIO_PROVIDER_ID = "local-lmstudio";

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 将运行中的 Ollama 关联到 AI Provider + Embedding。 */
export async function linkOllamaToAiConfig(
  probe?: LocalRuntimeProbeResult | null,
): Promise<{ ok: true; modelCount: number } | { ok: false; error: string }> {
  const data =
    probe ??
    (await commands.localRuntimeProbe().then((r) =>
      r.status === "ok" ? r.data : null,
    ));
  if (!data) {
    return { ok: false, error: "probe_failed" };
  }
  if (data.ollama.status !== "running") {
    return { ok: false, error: "not_running" };
  }

  const modelNames = data.ollama.models.map((m) => m.name);
  useAiModelsStore.getState().upsertProviderById(LOCAL_OLLAMA_PROVIDER_ID, {
    providerName: "Ollama",
    apiStandard: "openai",
    baseUrl: data.ollama.openaiBaseUrl,
    apiKey: "",
    modelNames,
    manualModelNames: [],
    disabledModelNames: [],
  });

  const embedName =
    modelNames.find((n) => n.toLowerCase().includes("embed")) ??
    DEFAULT_KNOWLEDGE_EMBEDDING_OLLAMA_MODEL.modelName;

  useSettingsStore.getState().setKnowledgeSettings({
    knowledgeEmbeddingModelMode: "ollama",
    knowledgeEmbeddingOllamaModel: {
      modelName: embedName,
      baseUrl: data.ollama.endpoint,
    },
  });
  await syncEmbeddingProviderToBackend();

  // 若场景默认模型为空，选第一个非 embed 聊天模型
  const chatModel =
    modelNames.find((n) => !n.toLowerCase().includes("embed")) ?? modelNames[0];
  if (chatModel) {
    const selectionId = buildModelSelectionId(LOCAL_OLLAMA_PROVIDER_ID, chatModel);
    const settings = useSettingsStore.getState();
    const patch: Parameters<typeof settings.setAiScenarioSettings>[0] = {};
    if (!settings.aiScenarioAssistantModelSelectionId) {
      patch.aiScenarioAssistantModelSelectionId = selectionId;
    }
    if (!settings.aiScenarioFormFillModelSelectionId) {
      patch.aiScenarioFormFillModelSelectionId = selectionId;
    }
    if (Object.keys(patch).length > 0) {
      settings.setAiScenarioSettings(patch);
    }
  }

  return { ok: true, modelCount: modelNames.length };
}

/** 将 LM Studio 关联为 Provider（不改 Embedding）。 */
export async function linkLmStudioToAiConfig(
  probe?: LocalRuntimeProbeResult | null,
): Promise<{ ok: true; modelCount: number } | { ok: false; error: string }> {
  const data =
    probe ??
    (await commands.localRuntimeProbe().then((r) =>
      r.status === "ok" ? r.data : null,
    ));
  if (!data?.lmStudio.reachable) {
    return { ok: false, error: "not_reachable" };
  }
  const modelNames = data.lmStudio.models;
  useAiModelsStore.getState().upsertProviderById(LOCAL_LMSTUDIO_PROVIDER_ID, {
    providerName: "LM Studio",
    apiStandard: "openai",
    baseUrl: data.lmStudio.endpoint,
    apiKey: "",
    modelNames,
    manualModelNames: [],
    disabledModelNames: [],
  });
  return { ok: true, modelCount: modelNames.length };
}

/** 关联自定义 OpenAI 兼容本地端点。 */
export function linkCustomLocalEndpoint(
  providerId: string,
  providerName: string,
  baseUrl: string,
  modelNames: string[],
): void {
  useAiModelsStore.getState().upsertProviderById(providerId, {
    providerName,
    apiStandard: "openai",
    baseUrl,
    apiKey: "",
    modelNames,
    manualModelNames: [],
    disabledModelNames: [],
  });
}
