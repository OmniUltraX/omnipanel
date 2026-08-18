import type { DatabaseSchema } from "../../types";
import { Catalog, type ResolvedTable } from "../catalog";
import { sliceStatementAtOffset, statementOffsetAtPos } from "../parser/ast";
import { analyzeStatementAtOffset, type StatementAnalysis } from "../parser/analyzer";
import {
  identifierAtPos,
  isPosInLineComment,
  qualifierBeforePos,
} from "./sqlIdentAtPos";

export type SqlTableAtPos = {
  from: number;
  to: number;
  databaseName: string;
  tableName: string;
};

function lineBounds(doc: string, pos: number): { start: number; text: string } {
  const start = doc.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const end = doc.indexOf("\n", pos);
  return { start, text: doc.slice(start, end < 0 ? doc.length : end) };
}

function resolveTableRef(
  catalog: Catalog,
  analysis: StatementAnalysis | null,
  word: string,
  qualifier: string | null,
): ResolvedTable | null {
  if (qualifier) {
    const qualified = catalog.findTable(word, qualifier);
    if (qualified && qualified.table.name.toLowerCase() === word.toLowerCase()) {
      return qualified;
    }
    return null;
  }

  if (analysis) {
    const tableRef = analysis.aliasMap.get(word.toLowerCase());
    if (tableRef) {
      return catalog.findTable(tableRef.tableName, tableRef.schemaName);
    }
  }

  return catalog.findTable(word);
}

/** 文档偏移处若是表名或表别名，返回对应库表（列名不命中）。 */
export function resolveSqlTableAtPos(
  doc: string,
  pos: number,
  schemas: DatabaseSchema[],
  dbType?: string,
): SqlTableAtPos | null {
  if (pos < 0 || pos > doc.length || schemas.length === 0) {
    return null;
  }

  const line = lineBounds(doc, pos);
  const offsetInLine = pos - line.start;
  if (isPosInLineComment(line.text, offsetInLine)) {
    return null;
  }

  const ident = identifierAtPos(line.text, offsetInLine);
  if (!ident || !ident.word) {
    return null;
  }

  const catalog = Catalog.fromSchemas(schemas);
  const statement = sliceStatementAtOffset(doc, pos);
  const offsetInStatement = statementOffsetAtPos(doc, pos);
  let analysis: StatementAnalysis | null = null;
  try {
    analysis = analyzeStatementAtOffset(statement, offsetInStatement, dbType);
  } catch {
    analysis = null;
  }

  const qualifier = qualifierBeforePos(line.text, ident.from);
  const resolved = resolveTableRef(catalog, analysis, ident.word, qualifier);
  if (!resolved) {
    return null;
  }

  return {
    from: line.start + ident.from,
    to: line.start + ident.to,
    databaseName: resolved.database.name,
    tableName: resolved.table.name,
  };
}
