import { invoke } from "@tauri-apps/api/core";

import type { BuiltinToolRegistration } from "../../../lib/ai/context";
import { requireString } from "../../../lib/ai/mcpToolArgs";
import { resolveKnowledgeEmbeddingProvider } from "../../../lib/knowledgeEmbeddingModel";
import { useAiModelsStore } from "../../../stores/aiModelsStore";
import { useSettingsStore } from "../../../stores/settingsStore";

interface KnowledgeQueryHit {
  entryId: string;
  title: string;
  chunkIndex: number;
  content: string;
  score: number;
}

async function queryDocument(args: Record<string, unknown>): Promise<string> {
  const key = requireString(args, "key");

  const settings = useSettingsStore.getState();
  const providers = useAiModelsStore.getState().providers;
  const provider = resolveKnowledgeEmbeddingProvider(providers, {
    knowledgeEmbeddingModelMode: settings.knowledgeEmbeddingModelMode,
    knowledgeEmbeddingModelSelectionId: settings.knowledgeEmbeddingModelSelectionId,
    knowledgeEmbeddingOllamaModel: settings.knowledgeEmbeddingOllamaModel,
  });

  if (!provider) {
    throw new Error("未配置 Embedding 模型，请在设置中配置向量模型后重试");
  }

  const hits = await invoke<KnowledgeQueryHit[]>("knowledge_query_document", {
    args: {
      provider: {
        providerId: provider.providerId,
        modelName: provider.modelName.trim(),
        baseUrl: provider.baseUrl.trim(),
        apiKey: provider.apiKey.trim(),
        apiStandard: provider.apiStandard,
      },
      key,
      topN: 5,
    },
  });

  if (hits.length === 0) {
    return JSON.stringify({ query: key, hits: [], message: "未找到相关文档" });
  }

  return JSON.stringify({ query: key, hits }, null, 2);
}

export const KNOWLEDGE_MODULE_TOOLS: BuiltinToolRegistration[] = [
  {
    name: "omni_knowledge_query_document",
    description:
      "使用向量匹配在知识库中语义检索文档片段。传入查询关键字，返回最相关的文本块及其来源文档标题和相似度分数。适合 RAG 场景。",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "语义查询关键字（自然语言描述或关键词）",
        },
      },
      required: ["key"],
    },
    handler: queryDocument,
  },
];
