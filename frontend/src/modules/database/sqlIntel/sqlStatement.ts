import { findStatementRangeAtOffset, splitSqlStatements, type SqlStatementPart } from "./sqlLex";

export { findStatementRangeAtOffset, splitSqlStatements, type SqlStatementPart };

/** 从 offset 所在位置提取单条 SQL（trim 后）。 */
export function extractStatementAtOffset(sql: string, offset: number): string {
  const { from, to } = findStatementRangeAtOffset(sql, offset);
  const statement = sql.slice(from, to).trim();
  return statement;
}

/** 在 offset 处提取语句；无分句时回退为全文 trim。 */
export function sqlAtOffset(sql: string, offset: number): string {
  const statement = extractStatementAtOffset(sql, offset);
  return statement || sql.trim();
}

/** Ctrl+Enter：有选区时执行选中文本，否则执行光标所在语句。 */
export function resolveSqlToRun(
  text: string,
  selection: { from: number; to: number; head: number },
): string {
  const { from, to, head } = selection;
  if (from !== to) {
    const selected = text.slice(from, to).trim();
    if (selected) return selected;
  }
  return sqlAtOffset(text, head);
}

/** 将行列转为字符串 offset。 */
export function positionToOffset(text: string, lineNumber: number, column: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lineNumber - 1; i += 1) {
    offset += (lines[i]?.length ?? 0) + 1;
  }
  return offset + column - 1;
}

/** 当前焦点是否在 SQL 编辑器内。 */
export function isSqlEditorFocused(): boolean {
  const el = document.activeElement;
  return !!el?.closest(".sql-codemirror-editor");
}

/** @deprecated 使用 isSqlEditorFocused */
export const isSqlMonacoEditorFocused = isSqlEditorFocused;
