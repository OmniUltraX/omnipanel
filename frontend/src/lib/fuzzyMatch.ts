/** 子序列模糊匹配：query 各字符按顺序出现在 text 中即视为匹配 */
export function fuzzyMatch(query: string, text: string): boolean {
  return fuzzyScore(query, text) > 0;
}

/**
 * 模糊匹配得分（越高越靠前）。
 * - 连续匹配加分
 * - 词首 / 标签起始位置加分
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  let score = 0;
  let qi = 0;
  let streak = 0;
  let lastMatch = -2;

  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) {
      streak = 0;
      continue;
    }
    score += 1;
    if (i === 0 || t[i - 1] === " " || t[i - 1] === "/" || t[i - 1] === "-") {
      score += 4;
    }
    if (i === lastMatch + 1) {
      streak += 1;
      score += streak * 2;
    } else {
      streak = 0;
    }
    lastMatch = i;
    qi += 1;
  }

  return qi === q.length ? score : 0;
}

export function rankByFuzzy<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
): T[] {
  const q = query.trim();
  if (!q) return items;
  return items
    .map((item) => ({ item, score: fuzzyScore(q, getText(item)) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.item);
}
