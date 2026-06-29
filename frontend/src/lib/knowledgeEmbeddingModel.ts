import type { EmbeddingProviderConfig } from "../ipc/bindings";
import {
  isValidBaseUrl,
  listModelSelections,
  parseModelSelectionId,
  resolveModelSelection,
  type AiModelProvider,
} from "../stores/aiModelsStore";

export type KnowledgeEmbeddingModelMode = "configured" | "ollama";

export interface KnowledgeEmbeddingOllamaModel {
  modelName: string;
  baseUrl: string;
}

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";
export const KNOWLEDGE_EMBEDDING_OLLAMA_PROVIDER_ID = "ollama";

export const DEFAULT_KNOWLEDGE_EMBEDDING_OLLAMA_MODEL: KnowledgeEmbeddingOllamaModel = {
  modelName: "nomic-embed-text",
  baseUrl: OLLAMA_DEFAULT_BASE_URL,
};

export type KnowledgeEmbeddingSettingsSlice = {
  knowledgeEmbeddingModelMode: KnowledgeEmbeddingModelMode;
  knowledgeEmbeddingModelSelectionId: string | null;
  knowledgeEmbeddingOllamaModel: KnowledgeEmbeddingOllamaModel;
};

export function normalizeOllamaBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return OLLAMA_DEFAULT_BASE_URL;
  }
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function ollamaTagsUrl(baseUrl: string): string {
  const root = normalizeOllamaBaseUrl(baseUrl).replace(/\/v1$/, "");
  return `${root}/api/tags`;
}

export async function fetchOllamaModelNames(baseUrl: string): Promise<string[]> {
  try {
    const resp = await fetch(ollamaTagsUrl(baseUrl), {
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) {
      return [];
    }
    const data = (await resp.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((item) => item.name.replace(/:latest$/, ""));
  } catch {
    return [];
  }
}

export function isKnowledgeEmbeddingOllamaBaseUrlReady(baseUrl: string): boolean {
  return isValidBaseUrl(normalizeOllamaBaseUrl(baseUrl));
}

export function isKnowledgeEmbeddingOllamaModelReady(
  ollama: KnowledgeEmbeddingOllamaModel,
): boolean {
  return ollama.modelName.trim().length > 0 && isKnowledgeEmbeddingOllamaBaseUrlReady(ollama.baseUrl);
}

export function resolveConfiguredEmbeddingSelectionId(
  providers: AiModelProvider[],
  selectionId: string | null,
): string | null {
  const options = listModelSelections(providers);
  if (options.length === 0) {
    return null;
  }
  if (selectionId && options.some((item) => item.id === selectionId)) {
    return selectionId;
  }
  return options[0]!.id;
}

export function resolveKnowledgeEmbeddingProvider(
  providers: AiModelProvider[],
  settings: KnowledgeEmbeddingSettingsSlice,
): EmbeddingProviderConfig | null {
  if (settings.knowledgeEmbeddingModelMode === "ollama") {
    const ollama = settings.knowledgeEmbeddingOllamaModel;
    if (!isKnowledgeEmbeddingOllamaModelReady(ollama)) {
      return null;
    }
    return {
      providerId: KNOWLEDGE_EMBEDDING_OLLAMA_PROVIDER_ID,
      modelName: ollama.modelName.trim(),
      baseUrl: normalizeOllamaBaseUrl(ollama.baseUrl),
      apiKey: "",
      apiStandard: "openai",
    };
  }

  const selectionId = resolveConfiguredEmbeddingSelectionId(
    providers,
    settings.knowledgeEmbeddingModelSelectionId,
  );
  if (!selectionId) {
    return null;
  }
  const resolved = resolveModelSelection(providers, selectionId);
  if (!resolved) {
    return null;
  }
  if (resolved.apiStandard === "anthropic") {
    return null;
  }
  const parsed = parseModelSelectionId(selectionId);
  if (!parsed) {
    return null;
  }
  return {
    providerId: parsed.providerId,
    modelName: resolved.name,
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    apiStandard: resolved.apiStandard,
  };
}

/** @deprecated 旧版自定义 embedding 配置，仅用于持久化迁移 */
export interface LegacyKnowledgeEmbeddingCustomModel {
  modelName: string;
  baseUrl: string;
  apiKey?: string;
}

export function migrateLegacyEmbeddingSettings(
  state: Record<string, unknown> | undefined,
): Partial<KnowledgeEmbeddingSettingsSlice> | null {
  if (!state) {
    return null;
  }
  const mode = state.knowledgeEmbeddingModelMode;
  if (mode !== "custom") {
    return null;
  }
  const legacy = state.knowledgeEmbeddingCustomModel as LegacyKnowledgeEmbeddingCustomModel | undefined;
  return {
    knowledgeEmbeddingModelMode: "ollama",
    knowledgeEmbeddingOllamaModel: {
      modelName: legacy?.modelName?.trim() || DEFAULT_KNOWLEDGE_EMBEDDING_OLLAMA_MODEL.modelName,
      baseUrl: legacy?.baseUrl?.trim() || DEFAULT_KNOWLEDGE_EMBEDDING_OLLAMA_MODEL.baseUrl,
    },
  };
}
