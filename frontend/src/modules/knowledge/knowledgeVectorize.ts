import { commands } from "../../ipc/bindings";
import type {
  EmbeddingProviderConfig,
  KnowledgeChunkListResult,
  KnowledgeDeleteChunksResult,
  KnowledgeRecallHit,
} from "../../ipc/bindings";
import { listen } from "@tauri-apps/api/event";
import {
  clampKnowledgeChunkOverlap,
  clampKnowledgeChunkSize,
} from "../../stores/settingsStore";
import type { BackgroundTaskInfo } from "../../stores/backgroundTaskStore";

type KnowledgeVectorizeSettings = {
  knowledgeChunkSize: number;
  knowledgeChunkOverlap: number;
};

export async function vectorizeKnowledgeEntry(
  entryId: string,
  provider: EmbeddingProviderConfig,
  knowledgeSettings: KnowledgeVectorizeSettings,
): Promise<{ ok: true; chunkCount: number } | { ok: false; error: string }> {
  if (provider.apiStandard.toLowerCase() === "anthropic") {
    return { ok: false, error: "Anthropic 模型暂不支持 embedding，请选用 OpenAI 兼容模型" };
  }
  if (!provider.modelName.trim()) {
    return { ok: false, error: "未配置 Embedding 模型名称" };
  }
  if (!provider.baseUrl.trim()) {
    return { ok: false, error: "未配置 Embedding API Base URL" };
  }

  const chunkSize = clampKnowledgeChunkSize(knowledgeSettings.knowledgeChunkSize);
  const chunkOverlap = clampKnowledgeChunkOverlap(
    knowledgeSettings.knowledgeChunkOverlap,
    chunkSize,
  );

  const res = await commands.knowledgeVectorize({
    entryId,
    provider: {
      providerId: provider.providerId,
      modelName: provider.modelName.trim(),
      baseUrl: provider.baseUrl.trim(),
      apiKey: provider.apiKey.trim(),
      apiStandard: provider.apiStandard,
    },
    chunkSize,
    chunkOverlap,
  });

  if (res.status === "ok") {
    return { ok: true, chunkCount: res.data.chunkCount ?? 0 };
  }
  return { ok: false, error: res.error.message };
}

const vectorizingEntryIds = new Set<string>();
const entryIdByVectorizeTaskId = new Map<string, string>();
const vectorizeStateListeners = new Set<() => void>();
let knowledgeBgTaskInitialized = false;

function notifyVectorizeStateChange() {
  for (const listener of vectorizeStateListeners) {
    listener();
  }
}

export function subscribeKnowledgeVectorizeState(listener: () => void): () => void {
  vectorizeStateListeners.add(listener);
  return () => {
    vectorizeStateListeners.delete(listener);
  };
}

export function isKnowledgeEntryVectorizing(entryId: string): boolean {
  return vectorizingEntryIds.has(entryId);
}

function markKnowledgeVectorizing(entryId: string, taskId: string) {
  vectorizingEntryIds.add(entryId);
  entryIdByVectorizeTaskId.set(taskId, entryId);
  notifyVectorizeStateChange();
}

function unmarkKnowledgeVectorizingByTaskId(taskId: string) {
  const entryId = entryIdByVectorizeTaskId.get(taskId);
  if (entryId) {
    vectorizingEntryIds.delete(entryId);
    entryIdByVectorizeTaskId.delete(taskId);
    notifyVectorizeStateChange();
  }
}

export interface BgTaskKnowledgeEvent {
  taskId: string;
  eventType: string;
  entryId: string;
  chunkCount?: number | null;
  error?: string | null;
}

/** 订阅知识库后台任务完成事件，在 initBackgroundTasks 中调用一次。 */
export function initKnowledgeVectorizeBackgroundTasks() {
  if (knowledgeBgTaskInitialized) return;
  knowledgeBgTaskInitialized = true;

  const unsubs: Array<() => void> = [];

  listen<BgTaskKnowledgeEvent>("bg-task-knowledge-event", (event) => {
    const payload = event.payload;
    unmarkKnowledgeVectorizingByTaskId(payload.taskId);
    if (payload.eventType === "vectorize_done") {
      dispatchKnowledgeVectorized(payload.entryId);
    }
  })
    .then((fn) => unsubs.push(fn))
    .catch(() => {});

  listen<BackgroundTaskInfo>("bg-task-update", (event) => {
    const task = event.payload;
    if (task.kind !== "knowledgeVectorize") return;
    if (
      task.status === "completed" ||
      task.status === "failed" ||
      task.status === "cancelled"
    ) {
      unmarkKnowledgeVectorizingByTaskId(task.id);
    }
  })
    .then((fn) => unsubs.push(fn))
    .catch(() => {});

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      for (const fn of unsubs) fn();
    });
  }
}

export async function submitKnowledgeVectorize(
  entryId: string,
  provider: EmbeddingProviderConfig,
  knowledgeSettings: KnowledgeVectorizeSettings,
): Promise<string> {
  if (provider.apiStandard.toLowerCase() === "anthropic") {
    throw new Error("Anthropic 模型暂不支持 embedding，请选用 OpenAI 兼容模型");
  }
  if (!provider.modelName.trim()) {
    throw new Error("未配置 Embedding 模型名称");
  }
  if (!provider.baseUrl.trim()) {
    throw new Error("未配置 Embedding API Base URL");
  }
  if (isKnowledgeEntryVectorizing(entryId)) {
    throw new Error("该文档正在向量化中，请稍候");
  }

  const chunkSize = clampKnowledgeChunkSize(knowledgeSettings.knowledgeChunkSize);
  const chunkOverlap = clampKnowledgeChunkOverlap(
    knowledgeSettings.knowledgeChunkOverlap,
    chunkSize,
  );

  const res = await commands.bgTaskSubmitKnowledgeVectorize({
    entryId,
    provider: {
      providerId: provider.providerId,
      modelName: provider.modelName.trim(),
      baseUrl: provider.baseUrl.trim(),
      apiKey: provider.apiKey.trim(),
      apiStandard: provider.apiStandard,
    },
    chunkSize,
    chunkOverlap,
  });

  if (res.status === "ok") {
    markKnowledgeVectorizing(entryId, res.data);
    return res.data;
  }
  throw new Error(res.error.message);
}

export const KNOWLEDGE_VECTORIZED_EVENT = "omnipanel:knowledge-vectorized";
export const KNOWLEDGE_CHUNKS_CHANGED_EVENT = "omnipanel:knowledge-chunks-changed";

export function dispatchKnowledgeVectorized(entryId: string) {
  window.dispatchEvent(
    new CustomEvent(KNOWLEDGE_VECTORIZED_EVENT, { detail: { entryId } }),
  );
}

export function dispatchKnowledgeChunksChanged(entryId: string) {
  window.dispatchEvent(
    new CustomEvent(KNOWLEDGE_CHUNKS_CHANGED_EVENT, { detail: { entryId } }),
  );
}

export async function loadKnowledgeVectorStatus(entryId: string) {
  const res = await commands.knowledgeVectorStatus(entryId);
  if (res.status === "ok") {
    return res.data;
  }
  throw new Error(res.error.message);
}

export type KnowledgeChunkPreview = {
  id: string;
  entryId: string;
  chunkIndex: number;
  content: string;
  createdAt: number;
};

export const KNOWLEDGE_CHUNK_PAGE_SIZE = 12;

export const KNOWLEDGE_RECALL_DEFAULT_TOP_K = 5;
export const KNOWLEDGE_RECALL_DEFAULT_MIN_SCORE_PERCENT = 50;
export const KNOWLEDGE_RECALL_TOP_K_MIN = 1;
export const KNOWLEDGE_RECALL_TOP_K_MAX = 100;

export type KnowledgeRecallOptions = {
  topK?: number;
  /** 余弦相似度下限，0–1 */
  minScore?: number;
};

export async function loadKnowledgeChunks(
  entryId: string,
  offset: number,
  limit = KNOWLEDGE_CHUNK_PAGE_SIZE,
): Promise<KnowledgeChunkListResult> {
  const safeOffset = Math.max(0, offset);
  const res = await commands.knowledgeListChunks(entryId, safeOffset, limit);
  if (res.status === "ok") {
    return res.data;
  }
  throw new Error(res.error.message);
}

export async function deleteKnowledgeChunks(
  entryId: string,
  chunkIds: string[],
): Promise<KnowledgeDeleteChunksResult> {
  if (chunkIds.length === 0) {
    return { entryId, deleted: 0, remaining: 0 };
  }
  const res = await commands.knowledgeDeleteChunks(entryId, chunkIds);
  if (res.status === "ok") {
    dispatchKnowledgeChunksChanged(entryId);
    return res.data;
  }
  throw new Error(res.error.message);
}

export async function recallKnowledgeEntry(
  entryId: string,
  query: string,
  provider: EmbeddingProviderConfig,
  options?: KnowledgeRecallOptions,
): Promise<KnowledgeRecallHit[]> {
  const topK = Math.min(
    KNOWLEDGE_RECALL_TOP_K_MAX,
    Math.max(KNOWLEDGE_RECALL_TOP_K_MIN, options?.topK ?? KNOWLEDGE_RECALL_DEFAULT_TOP_K),
  );
  const minScore = Math.min(
    1,
    Math.max(0, options?.minScore ?? KNOWLEDGE_RECALL_DEFAULT_MIN_SCORE_PERCENT / 100),
  );
  const res = await commands.knowledgeRecallTest({
    entryId,
    query,
    provider: {
      providerId: provider.providerId,
      modelName: provider.modelName.trim(),
      baseUrl: provider.baseUrl.trim(),
      apiKey: provider.apiKey.trim(),
      apiStandard: provider.apiStandard,
    },
    topK,
    minScore,
  });
  if (res.status === "ok") {
    return res.data;
  }
  throw new Error(res.error.message);
}
