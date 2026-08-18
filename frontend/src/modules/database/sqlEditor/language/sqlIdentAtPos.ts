/** SQL 标识符命中（Hover / Ctrl+点击跳转共用）。 */

export function stripQuotes(name: string): string {
  return name.replace(/^[`"]|[`"]$/g, "");
}

export function identifierAtPos(
  line: string,
  offsetInLine: number,
): { word: string; from: number; to: number } | null {
  const re = /[`"]?[\w$]+[`"]?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;
    if (offsetInLine >= start && offsetInLine <= end) {
      const word = stripQuotes(raw);
      return { word, from: start, to: end };
    }
  }
  return null;
}

export function qualifierBeforePos(line: string, identFrom: number): string | null {
  const prefix = line.slice(0, identFrom);
  const match = prefix.match(/([`"]?[\w$]+[`"]?)\.\s*$/);
  if (!match) return null;
  return stripQuotes(match[1]);
}

export function isPosInLineComment(lineText: string, offsetInLine: number): boolean {
  const before = lineText.slice(0, Math.max(0, offsetInLine));
  const commentStart = before.indexOf("--");
  if (commentStart < 0) {
    return false;
  }
  const beforeComment = before.slice(0, commentStart);
  const singleQuotes = (beforeComment.match(/'/g) ?? []).length;
  return singleQuotes % 2 === 0;
}
