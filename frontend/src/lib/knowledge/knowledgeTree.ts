import type { KnowledgeEntry } from "../../ipc/bindings";

export type KnowledgeNodeType = "folder" | "document";

export type KnowledgeTreeNode = {
  entry: KnowledgeEntry;
  children: KnowledgeTreeNode[];
};

export function isKnowledgeFolder(entry: Pick<KnowledgeEntry, "nodeType">): boolean {
  return entry.nodeType === "folder";
}

export function normalizeParentId(parentId: string | null | undefined): string {
  return parentId?.trim() ?? "";
}

export function isKnowledgeImported(entry: Pick<KnowledgeEntry, "source">): boolean {
  return entry.source.startsWith("import:");
}

/** 思源镜像：markdown 文档，只读展示（本地 import:siyuan: 与 S3 import:siyuan-s3:）。 */
export function isSiyuanMirrorEntry(entry: Pick<KnowledgeEntry, "source">): boolean {
  return (
    entry.source.startsWith("import:siyuan:") || entry.source.startsWith("import:siyuan-s3:")
  );
}

/** Obsidian 镜像：markdown 文档，只读展示（默认 import:ks: 前缀）。 */
export function isObsidianMirrorEntry(entry: Pick<KnowledgeEntry, "source">): boolean {
  return entry.source.startsWith("import:ks:obsidian:");
}

/** PDF 导入：仅 `import:pdf:` 前缀（精确匹配，镜像源不再误入）。 */
export function isPdfImportEntry(entry: Pick<KnowledgeEntry, "source">): boolean {
  return entry.source.startsWith("import:pdf:");
}

/**
 * 镜像锁定：`import:` 来源一律只读闭环，唯 PDF 导入（用户自建行为）除外。
 * 未来新同步源默认锁定；锁定条目不可重命名/删除/移动。
 */
export function isMirrorLocked(entry: Pick<KnowledgeEntry, "source">): boolean {
  return isKnowledgeImported(entry) && !isPdfImportEntry(entry);
}

/** 只读镜像：与 isMirrorLocked 同义，文档面板预览分支用。 */
export function isReadonlyMirrorEntry(entry: Pick<KnowledgeEntry, "source">): boolean {
  return isMirrorLocked(entry);
}

/** 镜像来源命名空间：`import:siyuan:…` → `"siyuan"`；自建返回 null。 */
export function mirrorNamespaceOf(entry: Pick<KnowledgeEntry, "source">): string | null {
  if (!isKnowledgeImported(entry)) return null;
  const ns = entry.source.slice("import:".length).split(":")[0]?.trim() ?? "";
  return ns === "" ? null : ns;
}

/** 来源根：被导入的顶级文件夹（各同步源的根，统一树里打徽标）。 */
export function isMirrorSourceRoot(
  entry: Pick<KnowledgeEntry, "source" | "nodeType" | "parentId">,
): boolean {
  return (
    isKnowledgeFolder(entry) &&
    isKnowledgeImported(entry) &&
    normalizeParentId(entry.parentId) === ""
  );
}

/** 祖先链 id（选中 reveals 用；防环）。 */
export function expandAncestorIds(entries: KnowledgeEntry[], id: string): string[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let current = byId.get(id);
  while (current) {
    const parent = normalizeParentId(current.parentId);
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    out.push(parent);
    current = byId.get(parent);
  }
  return out;
}

/** 该条目是否在镜像子树内（含自身；手动误入镜像目录也算）。 */
export function isInsideMirrorSubtree(entryId: string, entries: KnowledgeEntry[]): boolean {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  let current: KnowledgeEntry | undefined = byId.get(entryId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (isMirrorLocked(current)) return true;
    current = byId.get(normalizeParentId(current.parentId));
  }
  return false;
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

  const build = (parentId: string, visiting: Set<string>): KnowledgeTreeNode[] =>
    sortEntries(byParent.get(parentId) ?? []).map((entry) => ({
      entry,
      // 防环：用户数据脏（A↔B 互指）时截断，避免无限递归爆栈。
      // 思源等镜像源允许文档下挂子文档，不再只给 folder 建 children。
      children: visiting.has(entry.id)
        ? []
        : (() => {
            visiting.add(entry.id);
            try {
              return build(entry.id, visiting);
            } finally {
              visiting.delete(entry.id);
            }
          })(),
    }));

  return build("", new Set());
}

export type FlattenedTreeRow = {
  node: KnowledgeTreeNode;
  depth: number;
};

/** 可见行扁平化（虚拟滚动用）：只展开 expandedIds 内的文件夹。 */
export function flattenVisibleTree(
  nodes: KnowledgeTreeNode[],
  expandedIds: readonly string[],
): FlattenedTreeRow[] {
  const expanded = new Set(expandedIds);
  const rows: FlattenedTreeRow[] = [];
  const walk = (list: KnowledgeTreeNode[], depth: number, visiting: Set<string>) => {
    for (const node of list) {
      rows.push({ node, depth });
      // 文档也可能有子项（思源子文档），有 children 且被展开就深入。
      if (node.children.length > 0 && expanded.has(node.entry.id)) {
        // 防环：同 buildKnowledgeTree。
        if (visiting.has(node.entry.id)) continue;
        visiting.add(node.entry.id);
        try {
          walk(node.children, depth + 1, visiting);
        } finally {
          visiting.delete(node.entry.id);
        }
      }
    }
  };
  walk(nodes, 0, new Set());
  return rows;
}

export function collectDescendantIds(entries: KnowledgeEntry[], rootId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string) => {
    for (const entry of entries) {
      if (normalizeParentId(entry.parentId) === parentId && !seen.has(entry.id)) {
        seen.add(entry.id);
        out.push(entry.id);
        walk(entry.id);
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
