import { commands, type EmbeddingProviderConfig } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";
import { useAiModelsStore } from "../stores/aiModelsStore";
import { useSettingsStore } from "../stores/settingsStore";
import { resolveKnowledgeEmbeddingProvider } from "./knowledgeEmbeddingModel";

/** 将当前设置中的 embedding 配置同步到后端，供 Skill MCP 向量化 / 混合召回使用。 */
export async function syncEmbeddingProviderToBackend(): Promise<EmbeddingProviderConfig | null> {
  const settings = useSettingsStore.getState();
  const providers = useAiModelsStore.getState().providers;
  const provider = resolveKnowledgeEmbeddingProvider(providers, {
    knowledgeEmbeddingModelMode: settings.knowledgeEmbeddingModelMode,
    knowledgeEmbeddingModelSelectionId: settings.knowledgeEmbeddingModelSelectionId,
    knowledgeEmbeddingOllamaModel: settings.knowledgeEmbeddingOllamaModel,
  });
  if (!provider) {
    return null;
  }
  try {
    await unwrapCommand(commands.embeddingProviderSync(provider));
    return provider;
  } catch {
    return null;
  }
}
