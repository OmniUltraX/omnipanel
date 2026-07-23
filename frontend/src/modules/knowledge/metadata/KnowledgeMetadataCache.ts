import type { KnowledgeEntry } from "../../../ipc/bindings";
import { isKnowledgeFolder } from "../knowledgeTree";
import { parseWikilinks, type ParsedWikilink } from "./wikilink";

export type LinkMention = {
  sourceId: string;
  sourceTitle: string;
  link: ParsedWikilink;
  snippet: string;
};

export type KnowledgeMetadataSnapshot = {
  /** 标题小写 → 文档 id（同名取最新更新） */
  titleToId: Map<string, string>;
  idToTitle: Map<string, string>;
  /** entryId → 出链 */
  outgoing: Map<string, ParsedWikilink[]>;
  /** entryId → 链到该文档的提及 */
  backlinks: Map<string, LinkMention[]>;
  /** entryId → 未链接提及（正文含标题但非 wikilink） */
  unlinkedMentions: Map<string, LinkMention[]>;
};

function snippetAround(content: string, index: number, radius = 48): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(content.length, index + radius);
  let s = content.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = `…${s}`;
  if (end < content.length) s = `${s}…`;
  return s;
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

export function buildKnowledgeMetadata(entries: KnowledgeEntry[]): KnowledgeMetadataSnapshot {
  const documents = entries.filter((e) => !isKnowledgeFolder(e));
  const titleToId = new Map<string, string>();
  const idToTitle = new Map<string, string>();

  for (const entry of documents) {
    idToTitle.set(entry.id, entry.title);
    const key = normalizeTitle(entry.title);
    if (!key) continue;
    const existing = titleToId.get(key);
    if (!existing) {
      titleToId.set(key, entry.id);
      continue;
    }
    const prev = documents.find((d) => d.id === existing);
    if (!prev || (entry.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) {
      titleToId.set(key, entry.id);
    }
  }

  const outgoing = new Map<string, ParsedWikilink[]>();
  const backlinks = new Map<string, LinkMention[]>();

  for (const entry of documents) {
    const links = parseWikilinks(entry.content ?? "");
    outgoing.set(entry.id, links);
    for (const link of links) {
      const targetId = titleToId.get(normalizeTitle(link.targetTitle));
      if (!targetId || targetId === entry.id) continue;
      const list = backlinks.get(targetId) ?? [];
      list.push({
        sourceId: entry.id,
        sourceTitle: entry.title,
        link,
        snippet: snippetAround(entry.content ?? "", link.index),
      });
      backlinks.set(targetId, list);
    }
  }

  const unlinkedMentions = new Map<string, LinkMention[]>();
  for (const target of documents) {
    const title = target.title.trim();
    if (title.length < 2) continue;
    const titleKey = normalizeTitle(title);
    const linkedSources = new Set((backlinks.get(target.id) ?? []).map((m) => m.sourceId));
    const mentions: LinkMention[] = [];

    for (const source of documents) {
      if (source.id === target.id) continue;
      if (linkedSources.has(source.id)) continue;
      const content = source.content ?? "";
      const idx = content.toLowerCase().indexOf(titleKey);
      if (idx < 0) continue;
      // 跳过已在 wikilink 内的匹配
      const links = outgoing.get(source.id) ?? [];
      const inLink = links.some(
        (l) => idx >= l.index && idx < l.index + l.raw.length,
      );
      if (inLink) continue;
      mentions.push({
        sourceId: source.id,
        sourceTitle: source.title,
        link: {
          raw: title,
          targetTitle: title,
          index: idx,
        },
        snippet: snippetAround(content, idx),
      });
    }
    if (mentions.length > 0) {
      unlinkedMentions.set(target.id, mentions);
    }
  }

  return { titleToId, idToTitle, outgoing, backlinks, unlinkedMentions };
}

export function resolveTitleToId(
  snapshot: KnowledgeMetadataSnapshot,
  title: string,
): string | null {
  return snapshot.titleToId.get(normalizeTitle(title)) ?? null;
}
