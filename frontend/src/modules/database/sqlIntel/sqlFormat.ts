import { format as formatWithSqlFormatter, type FormatOptionsWithLanguage } from "sql-formatter";
import { splitSqlStatements } from "./sqlLex";
import { resolveSqlDialect } from "./sqlDialect";

const MAJOR_CLAUSES = [
  "UNION ALL",
  "UNION",
  "INSERT INTO",
  "DELETE FROM",
  "UPDATE",
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP BY",
  "ORDER BY",
  "HAVING",
  "LIMIT",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "JOIN",
  "SET",
  "VALUES",
  "ON",
] as const;

const CLAUSE_REGEX = MAJOR_CLAUSES.slice()
  .sort((a, b) => b.length - a.length)
  .map((clause) => clause.replace(/\s+/g, "\\s+"))
  .join("|");

const COMPACT_KEYWORDS = [...MAJOR_CLAUSES, "AND", "OR"]
  .slice()
  .sort((a, b) => b.length - a.length);

export type SqlFormatStyle = "pretty" | "compact";

function protectLiterals(sql: string): { text: string; restore: (value: string) => string } {
  const preserved: string[] = [];
  const placeholder = (value: string) => {
    const index = preserved.length;
    preserved.push(value);
    return `__SQL_FMT_${index}__`;
  };

  let text = sql;
  text = text.replace(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g, placeholder);
  text = text.replace(/--[^\n]*/g, placeholder);
  text = text.replace(/\/\*[\s\S]*?\*\//g, placeholder);

  return {
    text,
    restore: (value: string) =>
      value.replace(/__SQL_FMT_(\d+)__/g, (_, index) => preserved[Number(index)] ?? ""),
  };
}

/** 正则降级格式化（单条语句）。 */
export function formatSingleStatementLegacy(raw: string): string {
  const { text, restore } = protectLiterals(raw);
  let formatted = text.replace(/\s+/g, " ").trim();
  if (!formatted) {
    return "";
  }

  for (const clause of MAJOR_CLAUSES.slice().sort((a, b) => b.length - a.length)) {
    const pattern = clause.replace(/\s+/g, "\\s+");
    formatted = formatted.replace(
      new RegExp(`\\b(${pattern})\\b`, "gi"),
      (_match, keyword: string) => `\n${keyword.toUpperCase()}`,
    );
  }

  formatted = formatted
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const clauseMatch = line.match(new RegExp(`^(${CLAUSE_REGEX})\\b`, "i"));
      if (!clauseMatch) {
        return line;
      }
      const clause = clauseMatch[1];
      const rest = line.slice(clause.length).trimStart();
      return rest ? `${clause.toUpperCase()} ${rest}` : clause.toUpperCase();
    })
    .join("\n");

  return restore(formatted);
}

function edgeNewlines(value: string): { leading: string; trailing: string } {
  return {
    leading: value.match(/^[\r\n]*/)?.[0] ?? "",
    trailing: value.match(/[\r\n]*$/)?.[0] ?? "",
  };
}

/** 格式化只改语句本体，语句前后的空行留在原处。 */
function keepEdgeNewlines(original: string, formatted: string): string {
  if (!original.trim() || !formatted.trim()) {
    return original;
  }
  const { leading, trailing } = edgeNewlines(original);
  return `${leading}${formatted.trim()}${trailing}`;
}

function matchCompactKeyword(text: string, index: number): string | null {
  if (index > 0 && /[A-Za-z0-9_]/.test(text[index - 1] ?? "")) {
    return null;
  }
  const rest = text.slice(index);
  for (const keyword of COMPACT_KEYWORDS) {
    if (rest.length < keyword.length) continue;
    if (rest.slice(0, keyword.length).toUpperCase() !== keyword) continue;
    const after = rest[keyword.length];
    if (after && /[A-Za-z0-9_]/.test(after)) continue;
    return keyword;
  }
  return null;
}

const BLOCK_OPEN_KEYWORDS = new Set([
  "SELECT",
  "INSERT INTO",
  "UPDATE",
  "DELETE FROM",
  "WITH",
  "VALUES",
]);

function skipSpaces(text: string, index: number): number {
  let i = index;
  while (text[i] === " ") i += 1;
  return i;
}

/** 括号后紧跟查询子句时，按代码块缩进，而不是参数列表。 */
function opensSqlBlock(text: string, indexAfterParen: number): boolean {
  const keyword = matchCompactKeyword(text, skipSpaces(text, indexAfterParen));
  return keyword != null && BLOCK_OPEN_KEYWORDS.has(keyword);
}

function compactIndent(blockDepth: number): string {
  return "  ".repeat(Math.max(0, blockDepth));
}

/**
 * 简单格式化：主要关键字换行，字段列表留在同一行。
 * 子查询括号单独成块并缩进；顶层 AND / OR 比所在子句多缩进一层。
 */
export function formatStatementCompact(raw: string): string {
  const { text, restore } = protectLiterals(raw);
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) {
    return "";
  }

  let parenDepth = 0;
  let blockDepth = 0;
  const blockParens: boolean[] = [];
  let atLineStart = true;
  let out = "";

  const breakLine = (indent: string) => {
    if (!atLineStart) out += "\n";
    out += indent;
    atLineStart = false;
  };

  for (let i = 0; i < flat.length; i += 1) {
    const ch = flat[i] ?? "";
    if (ch === "(") {
      const isBlock = opensSqlBlock(flat, i + 1);
      parenDepth += 1;
      blockParens.push(isBlock);
      if (isBlock) {
        if (out.endsWith(" ")) out = out.slice(0, -1);
        if (out.length > 0 && !out.endsWith("\n")) out += " ";
        out += "(";
        blockDepth += 1;
        out += "\n";
        atLineStart = true;
      } else {
        out += "(";
        atLineStart = false;
      }
      continue;
    }
    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      const isBlock = blockParens.pop() ?? false;
      if (isBlock) {
        blockDepth = Math.max(0, blockDepth - 1);
        breakLine(compactIndent(blockDepth));
        out += ")";
      } else {
        out += ")";
        atLineStart = false;
      }
      continue;
    }

    const keyword = matchCompactKeyword(flat, i);
    const isAndOr = keyword === "AND" || keyword === "OR";
    const breakHere = keyword != null && (!isAndOr || parenDepth === 0);
    if (keyword && breakHere) {
      const indent = compactIndent(isAndOr ? blockDepth + 1 : blockDepth);
      breakLine(indent);
      out += keyword;
      i += keyword.length - 1;
      continue;
    }

    if (ch === " " && atLineStart) continue;
    out += ch;
    if (ch !== " ") atLineStart = false;
  }

  const formatted = out
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join("\n");
  return restore(formatted);
}

function formatStatementWithEngine(sql: string, dbType?: string | null): string {
  const trimmed = sql.trim();
  if (!trimmed) {
    return "";
  }

  const { formatterLanguage } = resolveSqlDialect(dbType);
  const { text, restore } = protectLiterals(trimmed);

  try {
    const options: FormatOptionsWithLanguage = {
      language: formatterLanguage,
      tabWidth: 2,
      keywordCase: "upper",
    };
    return restore(formatWithSqlFormatter(text, options));
  } catch {
    return formatSingleStatementLegacy(trimmed);
  }
}

/** 格式化单条 SQL。`compact` 只按关键字换行，不把字段拆成一行一个。 */
export function formatStatement(
  sql: string,
  dbType?: string | null,
  style: SqlFormatStyle = "pretty",
): string {
  if (style === "compact") {
    return formatStatementCompact(sql);
  }
  return formatStatementWithEngine(sql, dbType);
}

/** 格式化 SQL 文本（多条语句以 ; 分隔）。 */
export function formatSql(
  input: string,
  dbType?: string | null,
  style: SqlFormatStyle = "pretty",
): string {
  const normalized = input.replace(/\r\n/g, "\n");
  const endedWithSemicolon = normalized.trimEnd().endsWith(";");
  const parts = splitSqlStatements(normalized);
  if (parts.length === 0) {
    return normalized.trim();
  }

  const formattedParts = parts.map((part) => formatStatement(part.sql, dbType, style));
  const joined = formattedParts.join(";\n\n");
  const body =
    parts.length === 1 && !parts[0].hadTrailingSemicolon && !endedWithSemicolon
      ? joined
      : `${joined};`;
  return keepEdgeNewlines(normalized, body);
}

/**
 * 格式化文档片段并映射光标：在 [rangeFrom, rangeTo) 内格式化，返回新文本与光标位置。
 */
export function formatSqlRange(
  doc: string,
  rangeFrom: number,
  rangeTo: number,
  cursor: number,
  dbType?: string | null,
  style: SqlFormatStyle = "pretty",
): { text: string; cursor: number } {
  const before = doc.slice(0, rangeFrom);
  const target = doc.slice(rangeFrom, rangeTo);
  const after = doc.slice(rangeTo);
  const relativeCursor = Math.max(0, Math.min(cursor - rangeFrom, target.length));
  const ratio = target.length > 0 ? relativeCursor / target.length : 0;

  const formatted = keepEdgeNewlines(target, formatStatement(target, dbType, style));
  if (formatted === target) {
    return { text: doc, cursor };
  }

  const newDoc = before + formatted + after;
  const newCursor = before.length + Math.round(formatted.length * ratio);
  return { text: newDoc, cursor: Math.min(newCursor, newDoc.length) };
}

export { splitSqlStatements } from "./sqlLex";
