const BASIC_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** 解码常见 HTML 实体（含数字实体）；无 DOM 依赖，便于单测。 */
function decodeHtmlEntities(raw: string): string {
  return raw.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, body: string) => {
    const key = body.toLowerCase();
    if (key in BASIC_ENTITIES) return BASIC_ENTITIES[key]!;
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    return full;
  });
}

/**
 * 将 HTML 片段压成纯文本（宝塔软件商店 `ps` 常带 `<span class="description-line">`）。
 * 不渲染 HTML，只剥离标签，避免 XSS。
 */
export function stripHtmlToPlainText(raw: string | null | undefined): string {
  if (raw == null) return "";
  const src = String(raw);
  if (!src.trim()) return "";
  const withBreaks = src
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n");
  const noTags = withBreaks.replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(noTags)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n+/g, " ")
    .trim();
}
