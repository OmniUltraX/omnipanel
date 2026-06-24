import { commands } from "../../ipc/bindings";
import {
  parseModelSelectionId,
  resolveModelSelection,
  type AiModelProvider,
} from "../../stores/aiModelsStore";
import {
  clampKnowledgeChunkOverlap,
  clampKnowledgeChunkSize,
  type SettingsState,
} from "../../stores/settingsStore";

export async function vectorizeKnowledgeEntry(
  entryId: string,
  modelSelectionId: string,
  providers: AiModelProvider[],
  knowledgeSettings: Pick<
    SettingsState,
    "knowledgeChunkSize" | "knowledgeChunkOverlap"
  >,
): Promise<{ ok: true; chunkCount: number } | { ok: false; error: string }> {
  const resolved = resolveModelSelection(providers, modelSelectionId);
  if (!resolved) {
    return { ok: false, error: "未找到可用的 embedding 模型，请先在设置中配置 AI 模型" };
  }
  const parsed = parseModelSelectionId(modelSelectionId);
  if (!parsed) {
    return { ok: false, error: "模型选择无效" };
  }
  if (resolved.apiStandard === "anthropic") {
    return { ok: false, error: "Anthropic 模型暂不支持 embedding，请选用 OpenAI 兼容模型" };
  }

  const chunkSize = clampKnowledgeChunkSize(knowledgeSettings.knowledgeChunkSize);
  const chunkOverlap = clampKnowledgeChunkOverlap(
    knowledgeSettings.knowledgeChunkOverlap,
    chunkSize,
  );

  const res = await commands.knowledgeVectorize({
    entryId,
    provider: {
      providerId: parsed.providerId,
      modelName: resolved.name,
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      apiStandard: resolved.apiStandard,
    },
    chunkSize,
    chunkOverlap,
  });

  if (res.status === "ok") {
    return { ok: true, chunkCount: res.data.chunkCount };
  }
  return { ok: false, error: res.error.message };
}

export const KNOWLEDGE_VECTORIZED_EVENT = "omnipanel:knowledge-vectorized";

export function dispatchKnowledgeVectorized(entryId: string) {
  window.dispatchEvent(
    new CustomEvent(KNOWLEDGE_VECTORIZED_EVENT, { detail: { entryId } }),
  );
}

export async function loadKnowledgeVectorStatus(entryId: string) {
  const res = await commands.knowledgeVectorStatus(entryId);
  if (res.status === "ok") {
    return res.data;
  }
  throw new Error(res.error.message);
}
