import type { RedisKeyEntry } from "../api";

const DEFAULT_DELIMITER = ":";

export type RedisPrefixTreeNode =
  | {
      kind: "folder";
      id: string;
      segment: string;
      count: number;
      children: RedisPrefixTreeNode[];
    }
  | {
      kind: "key";
      id: string;
      segment: string;
      entry: RedisKeyEntry;
    };

interface MutableFolder {
  kind: "folder";
  id: string;
  segment: string;
  count: number;
  children: Map<string, MutableNode>;
}

type MutableNode =
  | MutableFolder
  | {
      kind: "key";
      id: string;
      segment: string;
      entry: RedisKeyEntry;
    };

/** 将已加载 keys 按分隔符聚合为前缀树；count 为落入该前缀的 key 数。 */
export function buildRedisPrefixTree(
  entries: RedisKeyEntry[],
  delimiter = DEFAULT_DELIMITER,
): RedisPrefixTreeNode[] {
  const root: MutableFolder = {
    kind: "folder",
    id: "",
    segment: "",
    count: 0,
    children: new Map(),
  };

  for (const entry of entries) {
    const parts = entry.key.split(delimiter).filter((part) => part.length > 0);
    if (parts.length === 0) {
      continue;
    }
    let node = root;
    let path = "";
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i]!;
      const isLeaf = i === parts.length - 1;
      path = path ? `${path}${delimiter}${segment}` : segment;
      if (isLeaf) {
        node.children.set(`key:${entry.key}`, {
          kind: "key",
          id: `key:${entry.key}`,
          segment,
          entry,
        });
      } else {
        let child = node.children.get(`folder:${path}`);
        if (!child || child.kind !== "folder") {
          child = {
            kind: "folder",
            id: `folder:${path}`,
            segment,
            count: 0,
            children: new Map(),
          };
          node.children.set(`folder:${path}`, child);
        }
        child.count += 1;
        node = child;
      }
    }
    root.count += 1;
  }

  return freezeFolder(root).children;
}

function freezeFolder(folder: MutableFolder): RedisPrefixTreeNode & { kind: "folder" } {
  const children = [...folder.children.values()]
    .map((child) => (child.kind === "folder" ? freezeFolder(child) : child))
    .sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "folder" ? -1 : 1;
      }
      return a.segment.localeCompare(b.segment);
    });
  return {
    kind: "folder",
    id: folder.id,
    segment: folder.segment,
    count: folder.count,
    children,
  };
}

export function buildScanPattern(
  keyword: string,
  fuzzy: boolean,
): string {
  const trimmed = keyword.trim();
  if (!trimmed) {
    return "*";
  }
  if (trimmed.includes("*") || trimmed.includes("?")) {
    return trimmed;
  }
  return fuzzy ? `*${trimmed}*` : `${trimmed}*`;
}

export function filterEntriesBySearchScope(
  entries: RedisKeyEntry[],
  keyword: string,
  scope: "key" | "value" | "all",
  fuzzy: boolean,
): RedisKeyEntry[] {
  const trimmed = keyword.trim().toLowerCase();
  if (!trimmed) {
    return entries;
  }
  if (scope === "key") {
    // 键过滤已由 SCAN MATCH 完成
    return entries;
  }
  return entries.filter((entry) => {
    const keyHit = matchText(entry.key.toLowerCase(), trimmed, fuzzy);
    const valueHit = matchText(entry.value.toLowerCase(), trimmed, fuzzy);
    if (scope === "value") {
      return valueHit;
    }
    return keyHit || valueHit;
  });
}

function matchText(haystack: string, needle: string, fuzzy: boolean): boolean {
  if (!needle) {
    return true;
  }
  if (fuzzy) {
    return haystack.includes(needle);
  }
  return haystack.startsWith(needle);
}
