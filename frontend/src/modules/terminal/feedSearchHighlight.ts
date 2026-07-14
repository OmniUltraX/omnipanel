export function substringHighlightIndices(text: string, query: string): ReadonlySet<number> {
  const needle = query.trim().toLowerCase();
  if (!needle) return new Set();

  const lower = text.toLowerCase();
  const indices = new Set<number>();
  let start = 0;

  while (start < lower.length) {
    const index = lower.indexOf(needle, start);
    if (index < 0) break;
    for (let i = index; i < index + needle.length; i += 1) {
      indices.add(i);
    }
    start = index + needle.length;
  }

  return indices;
}
