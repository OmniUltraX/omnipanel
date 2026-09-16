import { useMemo } from "react";
import { useKnowledgeStore } from "../../../stores/knowledgeStore";
import {
  buildKnowledgeMetadata,
  computeUnlinkedMentionsFor,
  resolveTitleToId,
  type KnowledgeMetadataSnapshot,
} from "./KnowledgeMetadataCache";

export function useKnowledgeMetadata(): KnowledgeMetadataSnapshot {
  const entries = useKnowledgeStore((s) => s.entries);
  return useMemo(() => buildKnowledgeMetadata(entries), [entries]);
}

export function useResolveKnowledgeTitle(): (title: string) => string | null {
  const meta = useKnowledgeMetadata();
  return (title: string) => resolveTitleToId(meta, title);
}

/** 打开文档的未链接提及（懒算，避免全量 O(n²) 卡首屏）。 */
export function useUnlinkedMentions(entryId: string | null) {
  const entries = useKnowledgeStore((s) => s.entries);
  const meta = useKnowledgeMetadata();
  return useMemo(() => {
    if (!entryId) return [];
    return computeUnlinkedMentionsFor(entries, meta, entryId);
  }, [entries, meta, entryId]);
}
