import { linter, type Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { splitSqlStatements } from "../../sqlIntel/sqlLex";
import type { DatabaseSchema } from "../../types";
import { Catalog } from "../catalog";
import { formatParseError } from "../parser/ast";
import { extractTableRefSpans } from "../parser/analyzer";

const KEYWORD_TYPO_SUGGESTIONS: Record<string, string> = {
  FORM: "FROM",
  FORMED: "FROM",
  WERE: "WHERE",
  WHRE: "WHERE",
  SELCT: "SELECT",
  SLECT: "SELECT",
  INSER: "INSERT",
  UDPATE: "UPDATE",
  DELTE: "DELETE",
  GROP: "GROUP",
  OREDER: "ORDER",
  JION: "JOIN",
};

function scanKeywordTypos(text: string, baseOffset: number): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const re = /\b([A-Z]{3,})\b/g;
  for (const match of text.matchAll(re)) {
    const word = match[1];
    const suggestion = KEYWORD_TYPO_SUGGESTIONS[word];
    if (!suggestion) continue;
    const from = baseOffset + (match.index ?? 0);
    diagnostics.push({
      from,
      to: from + word.length,
      severity: "error",
      message: `未知关键字 ${word}，是否应为 ${suggestion}？`,
    });
  }
  return diagnostics;
}

function scanMissingTables(
  catalog: Catalog,
  statement: string,
  baseOffset: number,
  dbType?: string,
): Diagnostic[] {
  if (!catalog.hasTables()) return [];

  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const span of extractTableRefSpans(statement, baseOffset, dbType)) {
    const rangeKey = `${span.from}:${span.to}`;
    if (seen.has(rangeKey)) continue;
    seen.add(rangeKey);
    if (catalog.findTable(span.tableName, span.schemaName)) continue;
    const display = span.schemaName ? `${span.schemaName}.${span.tableName}` : span.tableName;
    diagnostics.push({
      from: span.from,
      to: span.to,
      severity: "error",
      message: `表「${display}」不存在`,
    });
  }
  return diagnostics;
}

/** SQL 语法 Lint：Parser 错误 + 常见关键字拼写 + 表存在性。 */
export function createSqlLinter(
  getDbType?: () => string | undefined,
  getSchemas?: () => DatabaseSchema[],
) {
  return linter((view: EditorView) => {
    const doc = view.state.doc.toString();
    const dbType = getDbType?.();
    const catalog = Catalog.fromSchemas(getSchemas?.() ?? []);

    const diagnostics: Diagnostic[] = [];
    const statements = splitSqlStatements(doc);
    const parts = statements.length > 0 ? statements : [{ sql: doc.trim(), from: 0, to: doc.length, hadTrailingSemicolon: false }];

    for (const part of parts) {
      const statement = doc.slice(part.from, part.to).trim();
      if (!statement) continue;
      const leading = doc.slice(part.from, part.to).indexOf(statement);
      const baseOffset = part.from + Math.max(leading, 0);

      diagnostics.push(...scanKeywordTypos(statement, baseOffset));
      diagnostics.push(...scanMissingTables(catalog, statement, baseOffset, dbType));

      const parseError = formatParseError(statement, dbType);
      if (parseError) {
        diagnostics.push({
          from: baseOffset,
          to: Math.min(baseOffset + statement.length, doc.length),
          severity: "warning",
          message: parseError,
        });
      }
    }

    return diagnostics;
  });
}
