import { textSearchMatches } from "./textSearchMatch";

/** 侧栏树节点是否匹配搜索词（支持拼音、分词与子序列）。 */
export function sidebarTreeSearchMatches(
  query: string,
  ...texts: (string | null | undefined)[]
): boolean {
  const q = query.trim();
  if (!q) {
    return true;
  }
  return texts.some((text) => text && textSearchMatches(q, text));
}

export function hasSidebarTreeSearch(query: string): boolean {
  return query.trim().length > 0;
}
