export interface SqlSubqueryRange {
  /** 括号内 SELECT / WITH 的起点 */
  from: number;
  /** 对应右括号之前 */
  to: number;
  sql: string;
}

function isIdentChar(ch: string | undefined): boolean {
  return ch != null && /[A-Za-z0-9_]/.test(ch);
}

function keywordAt(text: string, i: number, word: string): boolean {
  if (i < 0 || i + word.length > text.length) return false;
  if (text.slice(i, i + word.length).toLowerCase() !== word) return false;
  if (isIdentChar(text[i - 1]) || isIdentChar(text[i + word.length])) return false;
  return true;
}

function skipSpaceAndComments(text: string, i: number, end: number): number {
  while (i < end) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (text.startsWith("--", i)) {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? end : nl + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? end : close + 2;
      continue;
    }
    break;
  }
  return i;
}

/** 括号内以 SELECT / WITH 开头的子查询，不含函数调用和值列表。 */
export function findSqlSubqueries(text: string): SqlSubqueryRange[] {
  const found: SqlSubqueryRange[] = [];
  const parenStack: number[] = [];
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === "-" && next === "-") {
        lineComment = true;
        i += 1;
        continue;
      }
      if (ch === "/" && next === "*") {
        blockComment = true;
        i += 1;
        continue;
      }
    }
    if (ch === "'" && !inDouble && !inBacktick) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "`" && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
      continue;
    }
    if (inSingle || inDouble || inBacktick) continue;
    if (ch === "(") {
      parenStack.push(i);
      continue;
    }
    if (ch !== ")" || parenStack.length === 0) continue;
    const open = parenStack.pop();
    if (open == null) continue;
    const keyword = skipSpaceAndComments(text, open + 1, i);
    if (!keywordAt(text, keyword, "select") && !keywordAt(text, keyword, "with")) continue;
    let end = i;
    while (end > keyword && /\s/.test(text[end - 1] ?? "")) end -= 1;
    if (end <= keyword) continue;
    found.push({ from: keyword, to: end, sql: text.slice(keyword, end).trim() });
  }
  return found;
}

export function smallestSubqueryAt(text: string, head: number): SqlSubqueryRange | null {
  let best: SqlSubqueryRange | null = null;
  for (const query of findSqlSubqueries(text)) {
    if (head < query.from || head > query.to) continue;
    if (!best || query.to - query.from < best.to - best.from) best = query;
  }
  return best;
}
