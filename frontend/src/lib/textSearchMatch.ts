import { match as matchPinyin } from "pinyin-pro";

/** 收集 query 在 text 中的字面匹配字符下标（大小写不敏感）。 */
function collectLiteralMatchIndices(text: string, query: string, from = 0): number[] {
  const needle = query.trim();
  if (!needle) {
    return [];
  }
  const textLower = text.toLowerCase();
  const needleLower = needle.toLowerCase();
  const indices: number[] = [];
  let start = from;
  let idx = textLower.indexOf(needleLower, start);
  while (idx >= 0) {
    for (let i = idx; i < idx + needle.length; i += 1) {
      indices.push(i);
    }
    start = idx + needle.length;
    idx = textLower.indexOf(needleLower, start);
  }
  return indices;
}

function findLiteralMatchFrom(
  text: string,
  token: string,
  from: number,
): { indices: number[]; end: number } | null {
  const needle = token.trim();
  if (!needle) {
    return { indices: [], end: from };
  }
  const textLower = text.toLowerCase();
  const needleLower = needle.toLowerCase();
  const idx = textLower.indexOf(needleLower, from);
  if (idx < 0) {
    return null;
  }
  const indices: number[] = [];
  for (let i = idx; i < idx + needle.length; i += 1) {
    indices.push(i);
  }
  return { indices, end: idx + needle.length };
}

/** 子序列匹配：query 各字符按顺序出现在 text 中（跳过分隔符不影响匹配）。 */
function findSubsequenceMatchFrom(
  text: string,
  token: string,
  from: number,
): { indices: number[]; end: number } | null {
  const needle = token.trim().toLowerCase();
  if (!needle) {
    return { indices: [], end: from };
  }
  const indices: number[] = [];
  let qi = 0;
  for (let i = from; i < text.length && qi < needle.length; i += 1) {
    if (text[i].toLowerCase() === needle[qi]) {
      indices.push(i);
      qi += 1;
    }
  }
  if (qi < needle.length) {
    return null;
  }
  return { indices, end: indices[indices.length - 1] + 1 };
}

function collectSeparatorAwareSubsequenceIndices(text: string, query: string): number[] {
  return findSubsequenceMatchFrom(text, query, 0)?.indices ?? [];
}

function collectOrderedTokenMatchIndices(text: string, tokens: string[]): number[] {
  const indices: number[] = [];
  let from = 0;
  for (const token of tokens) {
    const literal = findLiteralMatchFrom(text, token, from);
    if (literal) {
      indices.push(...literal.indices);
      from = literal.end;
      continue;
    }
    const subsequence = findSubsequenceMatchFrom(text, token, from);
    if (!subsequence) {
      return [];
    }
    indices.push(...subsequence.indices);
    from = subsequence.end;
  }
  return indices;
}

/** 中文全拼 / 首字母 / 混合拼音匹配（pinyin-pro）。 */
function collectPinyinMatchIndices(text: string, query: string): number[] {
  const needle = query.trim();
  if (!needle || !/[\u4e00-\u9fff]/.test(text)) {
    return [];
  }
  try {
    const result = matchPinyin(text, needle, { continuous: true });
    return result ?? [];
  } catch {
    return [];
  }
}

/**
 * 判断 query 是否匹配 text：支持原文子串、空格分词、分隔符跳过的子序列、中文拼音。
 */
export function textSearchMatches(query: string, text: string): boolean {
  const needle = query.trim();
  if (!needle) {
    return true;
  }
  if (!text) {
    return false;
  }
  return getTextSearchMatchIndices(text, needle).length > 0;
}

/**
 * 返回 text 中应高亮的字符下标（去重、升序）。
 * 用于 ScopedSearch 与 ScopedSearchText。
 */
export function getTextSearchMatchIndices(text: string, query: string): number[] {
  const needle = query.trim();
  if (!needle || !text) {
    return [];
  }

  const merged = new Set<number>();
  for (const index of collectLiteralMatchIndices(text, needle)) {
    merged.add(index);
  }
  if (merged.size > 0) {
    return [...merged].sort((a, b) => a - b);
  }

  for (const index of collectPinyinMatchIndices(text, needle)) {
    merged.add(index);
  }
  if (merged.size > 0) {
    return [...merged].sort((a, b) => a - b);
  }

  const tokens = needle.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    for (const index of collectOrderedTokenMatchIndices(text, tokens)) {
      merged.add(index);
    }
    return [...merged].sort((a, b) => a - b);
  }

  for (const index of collectSeparatorAwareSubsequenceIndices(text, needle)) {
    merged.add(index);
  }
  return [...merged].sort((a, b) => a - b);
}

/** 按匹配下标将 text 拆成 React / DOM 可用的片段。 */
export function splitTextByMatchIndices(
  text: string,
  indices: number[],
): Array<{ text: string; matched: boolean }> {
  if (indices.length === 0) {
    return [{ text, matched: false }];
  }

  const indexSet = new Set(indices);
  const parts: Array<{ text: string; matched: boolean }> = [];
  let buffer = "";
  let bufferMatched = indexSet.has(0);

  for (let i = 0; i < text.length; i += 1) {
    const matched = indexSet.has(i);
    if (i > 0 && matched !== bufferMatched) {
      parts.push({ text: buffer, matched: bufferMatched });
      buffer = "";
      bufferMatched = matched;
    }
    buffer += text[i];
  }

  if (buffer) {
    parts.push({ text: buffer, matched: bufferMatched });
  }

  return parts;
}
