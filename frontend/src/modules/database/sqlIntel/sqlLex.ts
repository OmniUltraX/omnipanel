/** SQL 词法扫描：识别字符串、注释与语句分隔分号。 */

export interface SqlStatementPart {
  /** trim 后的语句文本 */
  sql: string;
  /** 文档中的 [from, to) 范围（trim 后语句在文档中的位置） */
  from: number;
  to: number;
  hadTrailingSemicolon: boolean;
}

function isEscaped(sql: string, i: number): boolean {
  let slashes = 0;
  for (let j = i - 1; j >= 0 && sql[j] === "\\"; j -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

interface LexFlags {
  inSingle: boolean;
  inDouble: boolean;
  inBacktick: boolean;
  lineComment: boolean;
  blockComment: boolean;
}

function createLexFlags(): LexFlags {
  return {
    inSingle: false,
    inDouble: false,
    inBacktick: false,
    lineComment: false,
    blockComment: false,
  };
}

function stepLex(sql: string, i: number, flags: LexFlags): number {
  const ch = sql[i];
  const next = sql[i + 1];

  if (flags.lineComment) {
    if (ch === "\n") {
      flags.lineComment = false;
    }
    return i;
  }

  if (flags.blockComment) {
    if (ch === "*" && next === "/") {
      flags.blockComment = false;
      return i + 1;
    }
    return i;
  }

  if (!flags.inSingle && !flags.inDouble && !flags.inBacktick) {
    if (ch === "-" && next === "-") {
      flags.lineComment = true;
      return i + 1;
    }
    if (ch === "/" && next === "*") {
      flags.blockComment = true;
      return i + 1;
    }
  }

  if (ch === "'" && !flags.inDouble && !flags.inBacktick && !isEscaped(sql, i)) {
    flags.inSingle = !flags.inSingle;
    return i;
  }
  if (ch === '"' && !flags.inSingle && !flags.inBacktick && !isEscaped(sql, i)) {
    flags.inDouble = !flags.inDouble;
    return i;
  }
  if (ch === "`" && !flags.inSingle && !flags.inDouble) {
    flags.inBacktick = !flags.inBacktick;
  }
  return i;
}

function isSemicolonDelimiter(sql: string, i: number, flags: LexFlags): boolean {
  return (
    sql[i] === ";" &&
    !flags.inSingle &&
    !flags.inDouble &&
    !flags.inBacktick &&
    !flags.lineComment &&
    !flags.blockComment
  );
}

/** 换行后另起一条语句的关键字。FROM / WHERE 这类子句不在里面。 */
const STATEMENT_STARTS = new Set([
  "SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "CREATE", "ALTER", "DROP",
  "TRUNCATE", "REPLACE", "MERGE", "CALL", "EXEC", "EXECUTE", "SHOW", "USE",
  "BEGIN", "COMMIT", "ROLLBACK", "GRANT", "REVOKE", "EXPLAIN", "DESC",
  "DESCRIBE", "DECLARE", "SET", "START",
]);

/** 这些词后面的 SELECT / WITH 仍是同一条语句。 */
const SELECT_JOINERS = new Set(["UNION", "INTERSECT", "EXCEPT", "ALL", "DISTINCT"]);

interface StatementCut {
  /** 当前语句在此结束：分号位置，或下一条语句关键字的起点 */
  at: number;
  semicolon: boolean;
}

function inLiteral(flags: LexFlags): boolean {
  return flags.inSingle || flags.inDouble || flags.inBacktick || flags.lineComment || flags.blockComment;
}

function wordAt(sql: string, i: number): { word: string; end: number } | null {
  const ch = sql[i];
  if (!ch || !/[A-Za-z_]/.test(ch)) return null;
  let end = i + 1;
  while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end])) end += 1;
  return { word: sql.slice(i, end).toUpperCase(), end };
}

/** 从换行之后跳过空白和注释，看下一行是不是一条新语句。 */
function peekLineStatementStart(sql: string, newlineIndex: number): { at: number; word: string } | null {
  let j = newlineIndex + 1;
  while (j < sql.length) {
    const ch = sql[j];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      j += 1;
      continue;
    }
    if (ch === "-" && sql[j + 1] === "-") {
      const nl = sql.indexOf("\n", j);
      if (nl < 0) return null;
      j = nl + 1;
      continue;
    }
    if (ch === "/" && sql[j + 1] === "*") {
      const end = sql.indexOf("*/", j + 2);
      if (end < 0) return null;
      j = end + 2;
      continue;
    }
    break;
  }
  const found = wordAt(sql, j);
  if (!found || !STATEMENT_STARTS.has(found.word)) return null;
  return { at: j, word: found.word };
}

function keepsStatement(
  head: string,
  keyword: string,
  prevWord: string,
  insertAwaitingQuery: boolean,
  withAwaitingMain: boolean,
): boolean {
  if (!head) return true;
  if ((keyword === "SELECT" || keyword === "WITH") && SELECT_JOINERS.has(prevWord)) return true;
  if (
    withAwaitingMain
    && (keyword === "SELECT" || keyword === "WITH" || keyword === "UPDATE" || keyword === "DELETE" || keyword === "INSERT" || keyword === "REPLACE")
  ) {
    return true;
  }
  if (insertAwaitingQuery && (keyword === "SELECT" || keyword === "WITH" || keyword === "VALUES" || keyword === "SET")) {
    return true;
  }
  if (keyword === "SET" && (head === "UPDATE" || head === "INSERT" || head === "REPLACE")) return true;
  return false;
}

/**
 * 语句边界。分号以外，括号深度为 0 时，换行后如果是一条新语句也切开。
 * INSERT … SELECT、WITH … SELECT、UNION SELECT 不算新语句。
 */
function findStatementCuts(sql: string): StatementCut[] {
  const cuts: StatementCut[] = [];
  const flags = createLexFlags();
  let depth = 0;
  let head = "";
  let prevWord = "";
  let insertAwaitingQuery = false;
  let withAwaitingMain = false;
  let valuesDepth: number | null = null;
  let wordUntil = -1;

  const resetHead = () => {
    head = "";
    prevWord = "";
    insertAwaitingQuery = false;
    withAwaitingMain = false;
    valuesDepth = null;
  };

  const noteWord = (word: string) => {
    if (!head) {
      head = word;
      if (word === "INSERT" || word === "REPLACE") insertAwaitingQuery = true;
      if (word === "WITH") withAwaitingMain = true;
    } else if (depth === 0) {
      if (
        withAwaitingMain
        && (word === "SELECT" || word === "UPDATE" || word === "DELETE" || word === "INSERT" || word === "REPLACE")
      ) {
        withAwaitingMain = false;
        if (word === "INSERT" || word === "REPLACE") insertAwaitingQuery = true;
      }
      if (word === "SELECT" && insertAwaitingQuery) insertAwaitingQuery = false;
      if (word === "VALUES" && insertAwaitingQuery) valuesDepth = depth;
    }
    prevWord = word;
  };

  for (let i = 0; i < sql.length; i += 1) {
    if (isSemicolonDelimiter(sql, i, flags)) {
      cuts.push({ at: i, semicolon: true });
      resetHead();
      wordUntil = i + 1;
    } else if (!inLiteral(flags) && sql[i] === "\n" && depth === 0) {
      const next = peekLineStatementStart(sql, i);
      if (next && !keepsStatement(head, next.word, prevWord, insertAwaitingQuery, withAwaitingMain)) {
        cuts.push({ at: next.at, semicolon: false });
        resetHead();
        wordUntil = next.at;
      }
    } else if (!inLiteral(flags) && i >= wordUntil) {
      if (sql[i] === "(") {
        depth += 1;
      } else if (sql[i] === ")" && depth > 0) {
        depth -= 1;
        if (valuesDepth != null && depth === valuesDepth) {
          insertAwaitingQuery = false;
          valuesDepth = null;
        }
      } else {
        const found = wordAt(sql, i);
        if (found) {
          noteWord(found.word);
          wordUntil = found.end;
        }
      }
    }
    i = stepLex(sql, i, flags);
  }
  return cuts;
}

/** 光标所在语句在文档中的 [from, to) 范围（含语句区段内空白，不含分隔分号）。 */
export function findStatementRangeAtOffset(
  sql: string,
  offset: number,
): { from: number; to: number } {
  const pos = Math.max(0, Math.min(offset, sql.length));

  const afterTerminator = findStatementRangeIfAfterTerminator(sql, pos);
  if (afterTerminator) {
    return afterTerminator;
  }

  const cuts = findStatementCuts(sql);
  let from = 0;
  for (const cut of cuts) {
    const nextFrom = cut.semicolon ? cut.at + 1 : cut.at;
    if (pos < nextFrom) return { from, to: cut.at };
    from = nextFrom;
  }
  return { from, to: sql.length };
}

/** 光标在语句结束分号之后、下一条语句内容之前时，仍归属前一条语句。 */
function findStatementRangeIfAfterTerminator(
  sql: string,
  pos: number,
): { from: number; to: number } | null {
  if (pos === 0) {
    return null;
  }

  let lastSemi = -1;
  const scanFlags = createLexFlags();
  for (let i = 0; i < pos; i += 1) {
    if (isSemicolonDelimiter(sql, i, scanFlags)) {
      lastSemi = i;
    }
    i = stepLex(sql, i, scanFlags);
  }

  if (lastSemi < 0) {
    return null;
  }

  const gapFlags = createLexFlags();
  for (let i = lastSemi + 1; i < pos; i += 1) {
    const ch = sql[i];
    if (ch !== " " && ch !== "\t" && ch !== "\r" && ch !== "\n") {
      return null;
    }
    i = stepLex(sql, i, gapFlags);
  }

  if (pos < sql.length) {
    const chAt = sql[pos];
    if (chAt !== " " && chAt !== "\t" && chAt !== "\r" && chAt !== "\n") {
      return null;
    }
  }

  let start = 0;
  const startFlags = createLexFlags();
  for (let i = 0; i < lastSemi; i += 1) {
    if (isSemicolonDelimiter(sql, i, startFlags)) {
      start = i + 1;
    }
    i = stepLex(sql, i, startFlags);
  }

  return { from: start, to: lastSemi };
}

/** 按分号切分多条 SQL；漏写分号时，换行后的新语句也切开。字符串与注释中的分号忽略。 */
export function splitSqlStatements(text: string): SqlStatementPart[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const parts: SqlStatementPart[] = [];
  let statementStart = 0;

  const push = (end: number, semicolon: boolean) => {
    const raw = normalized.slice(statementStart, end);
    const trimmed = raw.trim();
    if (trimmed) {
      const lead = raw.length - raw.trimStart().length;
      parts.push({
        sql: trimmed,
        from: statementStart + lead,
        to: statementStart + lead + trimmed.length,
        hadTrailingSemicolon: semicolon,
      });
    }
    statementStart = semicolon ? end + 1 : end;
  };

  for (const cut of findStatementCuts(normalized)) {
    push(cut.at, cut.semicolon);
  }

  const tail = normalized.slice(statementStart);
  const trimmedTail = tail.trim();
  if (trimmedTail) {
    const lead = tail.length - tail.trimStart().length;
    parts.push({
      sql: trimmedTail,
      from: statementStart + lead,
      to: statementStart + lead + trimmedTail.length,
      hadTrailingSemicolon: false,
    });
  }

  return parts;
}
