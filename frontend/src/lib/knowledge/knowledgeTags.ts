/** 规范化标签：去掉引号/方括号碎片、首尾空白与 #，拒绝空串与纯符号。 */
export function normalizeKnowledgeTag(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;

  // 单个 tag 里误塞了整个 JSON 数组时，由调用方 expand；这里只清碎片
  s = s.replace(/^#+/, "").trim();

  // 反复剥一层引号 / 括号碎片
  for (let i = 0; i < 4; i++) {
    const prev = s;
    if (
      (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
      (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
    ) {
      s = s.slice(1, -1).trim();
    }
    s = s.replace(/^[[\s,"']+/, "").replace(/[\s,"'\]]+$/, "").trim();
    if (s === prev) break;
  }

  s = s.replace(/^#+/, "").trim();
  if (!s) return null;

  // 残留 JSON 结构符
  if (/^[\[\]{},:]+$/.test(s)) return null;
  if (!/[\p{L}\p{N}]/u.test(s)) return null;

  return s;
}

/** 解析可能被错误拆分/双重编码的 tags 字段或 tag 列表。 */
export function normalizeKnowledgeTags(input: readonly string[] | string | null | undefined): string[] {
  if (input == null) return [];

  const collected: string[] = [];

  const pushOne = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    // 误把整个数组当成一个 tag
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const nested = JSON.parse(trimmed) as unknown;
        if (Array.isArray(nested)) {
          for (const item of nested) {
            if (typeof item === "string") pushOne(item);
          }
          return;
        }
      } catch {
        // fall through
      }
    }

    const normalized = normalizeKnowledgeTag(trimmed);
    if (normalized) collected.push(normalized);
  };

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") pushOne(item);
        }
        return uniquePreserveOrder(collected);
      }
      if (typeof parsed === "string") {
        return normalizeKnowledgeTags(parsed);
      }
    } catch {
      pushOne(trimmed);
    }
    return uniquePreserveOrder(collected);
  }

  for (const item of input) {
    pushOne(item);
  }
  return uniquePreserveOrder(collected);
}

function uniquePreserveOrder(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}
