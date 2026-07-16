import type { RedisKeyEntry } from "../api";
import type { RedisPrefixTreeNode } from "./redisPrefixTree";

export const REDIS_KEY_ROW_HEIGHT = 26;
/** 超过该扁平行数才启用虚拟滚动 */
export const REDIS_KEY_VIRTUALIZE_THRESHOLD = 200;

export type RedisKeyListRow =
  | {
      kind: "folder";
      key: string;
      segment: string;
      count: number;
      depth: number;
      expanded: boolean;
    }
  | {
      kind: "key";
      key: string;
      segment: string;
      depth: number;
      entry: RedisKeyEntry;
    };

/** 按展开状态把前缀树压平成虚拟列表行 */
export function flattenRedisPrefixTree(
  nodes: RedisPrefixTreeNode[],
  expandedFolderIds: Set<string>,
  depth = 0,
  out: RedisKeyListRow[] = [],
): RedisKeyListRow[] {
  for (const node of nodes) {
    if (node.kind === "folder") {
      const expanded = expandedFolderIds.has(node.id);
      out.push({
        kind: "folder",
        key: node.id,
        segment: node.segment,
        count: node.count,
        depth,
        expanded,
      });
      if (expanded) {
        flattenRedisPrefixTree(node.children, expandedFolderIds, depth + 1, out);
      }
    } else {
      out.push({
        kind: "key",
        key: node.id,
        segment: node.segment,
        depth,
        entry: node.entry,
      });
    }
  }
  return out;
}

/** 平铺视图：每条 key 一行 */
export function flattenRedisEntries(entries: RedisKeyEntry[]): RedisKeyListRow[] {
  return entries.map((entry) => ({
    kind: "key" as const,
    key: `key:${entry.key}`,
    segment: entry.key,
    depth: 0,
    entry,
  }));
}
