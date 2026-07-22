import { useMemo } from "react";
import { useKnowledgeStore } from "../../../stores/knowledgeStore";
import {
  buildKnowledgeMetadata,
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
