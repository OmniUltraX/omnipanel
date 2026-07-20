import type { KnowledgeEntry } from "../../ipc/bindings";

export type KnowledgeNodeType = "folder" | "document";

export type KnowledgeTreeNode = {
  entry: KnowledgeEntry;
  children: KnowledgeTreeNode[];
};

export function isKnowledgeFolder(entry: Pick<KnowledgeEntry, "nodeType">): boolean {
  return entry.nodeType === "folder";
}

export type KnowledgeLibrarySection = "selfBuilt" | "imported";

export function isKnowledgeImported(entry: Pick<KnowledgeEntry, "source">): boolean {
  return entry.source.startsWith("import:");
}

export function knowledgeLibrarySectionForEntry(
  entry: Pick<KnowledgeEntry, "source">,
): KnowledgeLibrarySection {
  return isKnowledgeImported(entry) ? "imported" : "selfBuilt";
}

/** 按侧栏分区过滤条目；跨区父节点会被提升为根级展示。 */
export function filterEntriesForLibrarySection(
  entries: KnowledgeEntry[],
  section: KnowledgeLibrarySection,
): KnowledgeEntry[] {
  const inSection = (entry: KnowledgeEntry) =>
    section === "imported" ? isKnowledgeImported(entry) : !isKnowledgeImported(entry);
  const filtered = entries.filter(inSection);
  const allowedIds = new Set(filtered.map((entry) => entry.id));

  return filtered.map((entry) => {
    const parent = normalizeParentId(entry.parentId);
    if (!parent || allowedIds.has(parent)) {
      return entry;
    }
    return { ...entry, parentId: "" };
  });
}

export function normalizeParentId(parentId: string | null | undefined): string {
  return parentId?.trim() ?? "";
}

export function newKnowledgeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `kn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function nextSortOrder(entries: KnowledgeEntry[], parentId: string): number {
  const siblings = entries.filter((e) => normalizeParentId(e.parentId) === parentId);
  if (siblings.length === 0) return 0;
  return Math.max(...siblings.map((e) => e.sortOrder ?? 0)) + 1;
}

export function buildKnowledgeTree(entries: KnowledgeEntry[]): KnowledgeTreeNode[] {
  const byParent = new Map<string, KnowledgeEntry[]>();
  for (const entry of entries) {
    const parent = normalizeParentId(entry.parentId);
    const list = byParent.get(parent) ?? [];
    list.push(entry);
    byParent.set(parent, list);
  }

  const sortEntries = (list: KnowledgeEntry[]) =>
    [...list].sort((a, b) => {
      const order = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      if (order !== 0) return order;
      return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    });

  const build = (parentId: string): KnowledgeTreeNode[] =>
    sortEntries(byParent.get(parentId) ?? []).map((entry) => ({
      entry,
      children: isKnowledgeFolder(entry) ? build(entry.id) : [],
    }));

  return build("");
}

export function collectDescendantIds(entries: KnowledgeEntry[], rootId: string): string[] {
  const out: string[] = [];
  const walk = (parentId: string) => {
    for (const entry of entries) {
      if (normalizeParentId(entry.parentId) === parentId) {
        out.push(entry.id);
        if (isKnowledgeFolder(entry)) {
          walk(entry.id);
        }
      }
    }
  };
  walk(rootId);
  return out;
}

export function filterKnowledgeTree(
  nodes: KnowledgeTreeNode[],
  query: string,
): KnowledgeTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;

  const walk = (node: KnowledgeTreeNode): KnowledgeTreeNode | null => {
    const titleMatch = node.entry.title.toLowerCase().includes(q);
    const childMatches = node.children
      .map(walk)
      .filter((n): n is KnowledgeTreeNode => n != null);
    if (titleMatch || childMatches.length > 0) {
      return { entry: node.entry, children: childMatches.length > 0 ? childMatches : node.children };
    }
    return null;
  };

  return nodes.map(walk).filter((n): n is KnowledgeTreeNode => n != null);
}

export function createEmptyEntry(
  partial: Pick<KnowledgeEntry, "title" | "nodeType" | "parentId"> &
    Partial<KnowledgeEntry>,
): KnowledgeEntry {
  const now = Date.now();
  return {
    id: newKnowledgeId(),
    kind: "snippet",
    title: partial.title,
    content: partial.content ?? "",
    tags: partial.tags ?? [],
    riskLevel: partial.riskLevel ?? "safe",
    source: partial.source ?? "manual",
    envTag: partial.envTag ?? "dev",
    language: partial.language ?? "",
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
    parentId: normalizeParentId(partial.parentId),
    nodeType: partial.nodeType,
    sortOrder: partial.sortOrder ?? 0,
    resourceType: partial.resourceType ?? "",
    resourceId: partial.resourceId ?? "",
  };
}
