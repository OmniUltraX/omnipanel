import { Parser } from "node-sql-parser";
import { parserDatabaseOption } from "./dialect";

const parser = new Parser();

export function safeParseStatement(sql: string, dbType?: string | null): unknown | null {
  const trimmed = sql.trim();
  if (!trimmed) return null;
  try {
    return parser.astify(trimmed, parserDatabaseOption(dbType));
  } catch {
    return null;
  }
}

export function safeParseStatements(sql: string, dbType?: string | null): unknown[] {
  const trimmed = sql.trim();
  if (!trimmed) return [];
  try {
    const ast = parser.astify(trimmed, parserDatabaseOption(dbType));
    return Array.isArray(ast) ? ast : [ast];
  } catch {
    return [];
  }
}

export function formatParseError(sql: string, dbType?: string | null): string | null {
  try {
    parser.astify(sql.trim(), parserDatabaseOption(dbType));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 提取光标所在语句文本（不含分隔分号）。 */
export function sliceStatementAtOffset(text: string, offset: number): string {
  const pos = Math.max(0, Math.min(offset, text.length));
  const stmtStart = text.lastIndexOf(";", pos - 1) + 1;
  const stmtEnd = text.indexOf(";", pos);
  return text.slice(stmtStart, stmtEnd >= 0 ? stmtEnd : text.length);
}

/** 光标在整段文本中所属语句内的字节偏移。 */
export function statementOffsetAtPos(text: string, offset: number): number {
  const pos = Math.max(0, Math.min(offset, text.length));
  const stmtStart = text.lastIndexOf(";", pos - 1) + 1;
  return pos - stmtStart;
}
