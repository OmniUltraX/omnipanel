import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { publishModuleStatusLog } from "../../lib/moduleStatusLog";

export type KnowledgeVectorizeProgress = {
  entryId: string;
  title: string;
  phase: "chunking" | "embedding" | "saving" | string;
  chunkTotal: number;
  batchIndex: number;
  batchTotal: number;
  chunksDone: number;
};

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

function progressMessage(t: TranslateFn, payload: KnowledgeVectorizeProgress): string | null {
  const title = payload.title || payload.entryId;
  switch (payload.phase) {
    case "chunking":
      return t("knowledge.vectorize.progressChunking", {
        title,
        count: payload.chunkTotal,
      });
    case "embedding":
      return t("knowledge.vectorize.progressEmbedding", {
        title,
        done: payload.chunksDone,
        total: payload.chunkTotal,
        batch: payload.batchIndex,
        batches: payload.batchTotal,
      });
    case "saving":
      return t("knowledge.vectorize.progressSaving", { title });
    default:
      return null;
  }
}

/** 订阅后端向量化进度，写入知识库模块状态栏。在 KnowledgePanel 挂载时注册一次。 */
export function initKnowledgeVectorizeProgressListener(t: TranslateFn): Promise<UnlistenFn> {
  return listen<KnowledgeVectorizeProgress>("knowledge-vectorize-progress", (event) => {
    const message = progressMessage(t, event.payload);
    if (!message) return;
    publishModuleStatusLog("knowledge", message, "progress");
  });
}
