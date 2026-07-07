import type { SqlCompletionContext } from "../sqlEditor/parser/context";

/** 将字符串字面量替换为等长占位，便于在保留偏移的同时做子句分析。 */
export function stripSqlStringLiterals(text: string): string {
  return text
    .replace(/'(?:[^'\\]|\\.)*'/g, (match) => "'".padEnd(match.length, " "))
    .replace(/"(?:[^"\\]|\\.)*"/g, (match) => '"'.padEnd(match.length, " "));
}

function currentStatementBefore(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const start = before.lastIndexOf(";") + 1;
  return before.slice(start);
}

/** 光标是否位于未闭合的单/双引号字符串内。 */
export function isCursorInSqlString(text: string, offset: number): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < offset; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && (inSingle || inDouble)) {
      escaped = true;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
    }
  }
  return inSingle || inDouble;
}

/** 当前行光标前的 SQL 标识符前缀；字符串内返回空串，避免误把字面量当前缀过滤。 */
export function currentSqlWordPrefix(text: string, offset: number): string {
  if (isCursorInSqlString(text, offset)) {
    return "";
  }
  const before = text.slice(0, offset);
  const line = before.split("\n").pop() ?? "";
  return line.match(/(\w+)$/)?.[1] ?? "";
}

/** 语句尾部（去除字符串字面量后），用于判断 = / WHERE / OR 等补全意图。 */
export function sqlTailOutsideStrings(before: string): string {
  return stripSqlStringLiterals(before).trimEnd();
}

export type SqlCompletionIntent = "columns" | "values" | "mixed";

/** 根据光标位置与 Clause 上下文推断应优先补全列名还是值/函数。 */
export function resolveCompletionIntent(
  text: string,
  offset: number,
  context: SqlCompletionContext,
): SqlCompletionIntent {
  if (isCursorInSqlString(text, offset)) {
    return "mixed";
  }

  const tail = sqlTailOutsideStrings(currentStatementBefore(text, offset));

  if (/=\s*$/i.test(tail)) {
    return "values";
  }

  if (context === "update_set") {
    if (/\bSET\s*$/i.test(tail) || /,\s*$/i.test(tail)) {
      return "columns";
    }
    return "columns";
  }

  if (context === "where_clause" && /\b(?:WHERE|AND|OR)\s*$/i.test(tail)) {
    return "columns";
  }

  if (context === "select_list" || context === "group_by" || context === "order_by") {
    return "mixed";
  }

  if (context === "where_clause") {
    return "mixed";
  }

  return "mixed";
}
