import { EditorView, Decoration, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { DatabaseSchema } from "../../types";
import { Catalog, type Column, type ResolvedTable } from "../catalog";
import { splitSqlStatements } from "../../sqlIntel/sqlLex";
import {
  analyzeStatement,
  resolveTableByAlias,
  type StatementAnalysis,
} from "../parser/analyzer";

const tableMark = Decoration.mark({ class: "cm-sqlSemanticTable" });
const aliasMark = Decoration.mark({ class: "cm-sqlSemanticAlias" });
const columnMark = Decoration.mark({ class: "cm-sqlSemanticColumn" });
const databaseMark = Decoration.mark({ class: "cm-sqlSemanticDatabase" });

const SQL_RESERVED_WORDS = new Set([
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS", "NULL",
  "AS", "ON", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS",
  "FULL", "GROUP", "BY", "HAVING", "ORDER", "ASC", "DESC",
  "LIMIT", "OFFSET", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
  "DELETE", "CREATE", "TABLE", "DROP", "ALTER", "ADD", "COLUMN",
  "INDEX", "VIEW", "IF", "EXISTS", "PRIMARY", "KEY", "FOREIGN",
  "REFERENCES", "CONSTRAINT", "UNIQUE", "CHECK", "DEFAULT",
  "CASE", "WHEN", "THEN", "ELSE", "END", "BEGIN", "COMMIT",
  "ROLLBACK", "TRANSACTION", "LOCK", "UNLOCK", "TABLES",
  "GRANT", "REVOKE", "UNION", "ALL", "DISTINCT", "TOP",
  "LIKE", "BETWEEN", "EXISTS", "ANY", "SOME", "TRUE", "FALSE",
  "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "CAST",
  "ROW_NUMBER", "RANK", "DENSE_RANK", "OVER", "PARTITION",
  "WITH", "RECURSIVE", "EXPLAIN", "ANALYZE", "SHOW", "USE",
  "DESCRIBE", "CASCADE", "RESTRICT", "SERIALIZABLE", "COMMITTED",
  "READ", "WRITE", "REPEATABLE", "SNAPSHOT", "ISOLATION", "LEVEL",
  "MATERIALIZED", "TEMP", "TEMPORARY", "SCHEMA", "DATABASE",
  "TRUNCATE", "REPLACE", "MERGE", "DO", "RETURNING", "CONFLICT",
  "EXCEPT", "INTERSECT", "LATERAL", "USING", "NATURAL",
]);

export type SqlSemanticKind = "table" | "alias" | "column" | "database";

interface IdentifierToken {
  word: string;
  from: number;
  to: number;
  qualifier: string | null;
  qualifierFrom: number | null;
  qualifierTo: number | null;
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

function isEscaped(sql: string, i: number): boolean {
  let slashes = 0;
  for (let j = i - 1; j >= 0 && sql[j] === "\\"; j -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
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

function inLiteral(flags: LexFlags): boolean {
  return flags.inSingle || flags.inDouble || flags.inBacktick || flags.lineComment || flags.blockComment;
}

function isReservedWord(word: string): boolean {
  return SQL_RESERVED_WORDS.has(word.toUpperCase());
}

function qualifierBefore(
  sql: string,
  identFrom: number,
): { word: string; from: number; to: number } | null {
  let i = identFrom - 1;
  while (i >= 0 && /\s/.test(sql[i])) {
    i -= 1;
  }
  if (i < 0 || sql[i] !== ".") {
    return null;
  }
  i -= 1;
  while (i >= 0 && /\s/.test(sql[i])) {
    i -= 1;
  }

  const ident = readIdentifierAtEnd(sql, i + 1);
  if (!ident) {
    return null;
  }
  return ident;
}

function readIdentifierAtEnd(
  sql: string,
  endExclusive: number,
): { word: string; from: number; to: number } | null {
  let i = endExclusive - 1;
  if (i < 0) return null;

  if (sql[i] === "`" || sql[i] === '"') {
    const quote = sql[i];
    const close = i;
    i -= 1;
    while (i >= 0 && sql[i] !== quote) {
      i -= 1;
    }
    if (i < 0) return null;
    return { word: sql.slice(i + 1, close), from: i + 1, to: close };
  }

  if (!/[\w$]/.test(sql[i])) {
    return null;
  }
  const to = i + 1;
  while (i >= 0 && /[\w$]/.test(sql[i])) {
    i -= 1;
  }
  const from = i + 1;
  if (!/[A-Za-z_$]/.test(sql[from])) {
    return null;
  }
  return { word: sql.slice(from, to), from, to };
}

/**
 * 读取标识符。
 * - wordFrom/wordTo：用于装饰的标识符本体（不含引号）
 * - next：继续扫描的位置（含闭合引号之后）
 */
function readIdentifier(
  sql: string,
  start: number,
): { word: string; wordFrom: number; wordTo: number; next: number } | null {
  const ch = sql[start];
  if (!ch) return null;

  if (ch === "`" || ch === '"') {
    const quote = ch;
    let i = start + 1;
    while (i < sql.length && sql[i] !== quote) {
      i += 1;
    }
    if (i >= sql.length) {
      return null;
    }
    return {
      word: sql.slice(start + 1, i),
      wordFrom: start + 1,
      wordTo: i,
      // 关键：跳过闭合引号，避免后续 stepLex 把该引号当成「进入字面量」
      next: i + 1,
    };
  }

  if (!/[A-Za-z_$]/.test(ch)) {
    return null;
  }
  let i = start + 1;
  while (i < sql.length && /[\w$]/.test(sql[i])) {
    i += 1;
  }
  return { word: sql.slice(start, i), wordFrom: start, wordTo: i, next: i };
}

function* iterateIdentifiers(sql: string, baseOffset: number): Generator<IdentifierToken> {
  const flags = createLexFlags();
  let i = 0;

  while (i < sql.length) {
    if (!inLiteral(flags)) {
      const ident = readIdentifier(sql, i);
      if (ident) {
        const qualifier = qualifierBefore(sql, ident.wordFrom);
        yield {
          word: ident.word,
          from: baseOffset + ident.wordFrom,
          to: baseOffset + ident.wordTo,
          qualifier: qualifier?.word ?? null,
          qualifierFrom: qualifier ? baseOffset + qualifier.from : null,
          qualifierTo: qualifier ? baseOffset + qualifier.to : null,
        };
        i = ident.next;
        continue;
      }
    }
    i = stepLex(sql, i, flags) + 1;
  }
}

function resolveColumnInStatement(
  catalog: Catalog,
  analysis: StatementAnalysis,
  word: string,
): { resolved: ResolvedTable; column: Column } | null {
  for (const ref of analysis.tables) {
    const resolved = catalog.findTable(ref.tableName, ref.schemaName);
    if (!resolved) continue;
    const column = resolved.table.columns.find((col) => col.name.toLowerCase() === word.toLowerCase());
    if (column) {
      return { resolved, column };
    }
  }
  return null;
}

function resolveColumnByCatalog(
  catalog: Catalog,
  word: string,
): { resolved: ResolvedTable; column: Column } | null {
  const matches: { resolved: ResolvedTable; column: Column }[] = [];
  for (const database of catalog.databases) {
    for (const table of database.tables) {
      const column = table.columns.find((col) => col.name.toLowerCase() === word.toLowerCase());
      if (!column) continue;
      matches.push({
        resolved: {
          database,
          table,
          qualifiedTable: `${database.name}.${table.name}`,
        },
        column,
      });
    }
  }
  if (matches.length !== 1) return null;
  return matches[0] ?? null;
}

function isDistinctAlias(ref: { tableName: string; alias?: string }, word: string): boolean {
  if (!ref.alias) return false;
  return (
    ref.alias.toLowerCase() === word.toLowerCase() &&
    ref.alias.toLowerCase() !== ref.tableName.toLowerCase()
  );
}

/** 基于 Catalog 与语句分析，判定标识符语义类别。 */
export function classifySemanticIdentifier(
  catalog: Catalog,
  analysis: StatementAnalysis | null,
  word: string,
  qualifier: string | null,
): SqlSemanticKind | null {
  if (!word || isReservedWord(word)) {
    return null;
  }

  if (qualifier) {
    const qualifiedTable = catalog.findTable(word, qualifier);
    if (qualifiedTable && qualifiedTable.table.name.toLowerCase() === word.toLowerCase()) {
      return "table";
    }

    if (analysis) {
      const aliasTable = resolveTableByAlias(catalog, analysis, qualifier);
      const column = aliasTable?.table.columns.find((col) => col.name.toLowerCase() === word.toLowerCase());
      if (column && aliasTable) {
        return "column";
      }
      if (analysis.aliasMap.has(qualifier.toLowerCase())) {
        return "column";
      }
    }

    const schemaColumn = catalog.findColumn(qualifier, word);
    if (schemaColumn) {
      const resolved = catalog.findTable(qualifier);
      if (resolved) {
        return "column";
      }
    }

    if (catalog.findDatabase(qualifier) && catalog.findTable(word, qualifier)) {
      return "table";
    }

    return null;
  }

  if (analysis) {
    const tableRef = analysis.aliasMap.get(word.toLowerCase());
    if (tableRef) {
      return isDistinctAlias(tableRef, word) ? "alias" : "table";
    }

    if (resolveColumnInStatement(catalog, analysis, word)) {
      return "column";
    }
  }

  if (catalog.findDatabase(word)) {
    return "database";
  }

  if (catalog.findTable(word)) {
    return "table";
  }

  if (resolveColumnByCatalog(catalog, word)) {
    return "column";
  }

  return null;
}

function markForKind(kind: SqlSemanticKind) {
  switch (kind) {
    case "table":
      return tableMark;
    case "alias":
      return aliasMark;
    case "column":
      return columnMark;
    case "database":
      return databaseMark;
  }
}

function classifyQualifierToken(
  catalog: Catalog,
  analysis: StatementAnalysis | null,
  qualifier: string,
): SqlSemanticKind | null {
  if (!qualifier || isReservedWord(qualifier)) {
    return null;
  }

  if (analysis) {
    const tableRef = analysis.aliasMap.get(qualifier.toLowerCase());
    if (tableRef) {
      return isDistinctAlias(tableRef, qualifier) ? "alias" : "table";
    }
  }

  if (catalog.findDatabase(qualifier)) {
    return "database";
  }

  if (catalog.findTable(qualifier)) {
    return "table";
  }

  return null;
}

function buildSemanticRanges(
  doc: string,
  vpFrom: number,
  vpTo: number,
  schemas: DatabaseSchema[],
  dbType?: string,
): { from: number; to: number; kind: SqlSemanticKind }[] {
  const catalog = Catalog.fromSchemas(schemas);
  const ranges: { from: number; to: number; kind: SqlSemanticKind }[] = [];
  const decorated = new Set<string>();

  const pushRange = (from: number, to: number, kind: SqlSemanticKind) => {
    if (from >= to) return;
    const key = `${from}:${to}`;
    if (decorated.has(key)) return;
    decorated.add(key);
    ranges.push({ from, to, kind });
  };

  for (const part of splitSqlStatements(doc)) {
    if (part.to <= vpFrom || part.from >= vpTo) {
      continue;
    }

    const statement = part.sql;
    let analysis: StatementAnalysis | null = null;
    try {
      analysis = analyzeStatement(statement, dbType);
    } catch {
      analysis = null;
    }

    for (const token of iterateIdentifiers(statement, part.from)) {
      if (token.to <= vpFrom || token.from >= vpTo) {
        continue;
      }

      if (token.qualifier && token.qualifierFrom != null && token.qualifierTo != null) {
        const qualifierKind = classifyQualifierToken(catalog, analysis, token.qualifier);
        if (qualifierKind) {
          pushRange(token.qualifierFrom, token.qualifierTo, qualifierKind);
        }
      }

      const kind = classifySemanticIdentifier(catalog, analysis, token.word, token.qualifier);
      if (kind) {
        pushRange(token.from, token.to, kind);
      }
    }
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return ranges;
}

function buildSemanticDecorations(
  view: EditorView,
  schemas: DatabaseSchema[],
  dbType?: string,
) {
  const { from: vpFrom, to: vpTo } = view.viewport;
  const ranges = buildSemanticRanges(
    view.state.doc.toString(),
    vpFrom,
    vpTo,
    schemas,
    dbType,
  ).map(({ from, to, kind }) => markForKind(kind).range(from, to));

  if (ranges.length === 0) return Decoration.none;
  try {
    return Decoration.set(ranges, true);
  } catch {
    return Decoration.none;
  }
}

/** @internal 测试用：收集语义高亮区间。 */
export function collectSemanticRangesForTest(
  doc: string,
  schemas: DatabaseSchema[],
  dbType?: string,
) {
  return buildSemanticRanges(doc, 0, doc.length, schemas, dbType);
}

/** @internal 测试用：导出标识符扫描。 */
export function collectIdentifiersForTest(sql: string) {
  return [...iterateIdentifiers(sql, 0)];
}

/** 基于 Catalog 的语义高亮（表 / 别名 / 列 / 库名）。 */
export function createSqlSemanticHighlight(
  getSchemas: () => DatabaseSchema[],
  getDbType?: () => string | undefined,
) {
  return ViewPlugin.fromClass(
    class {
      decorations;

      constructor(view: EditorView) {
        this.decorations = buildSemanticDecorations(view, getSchemas(), getDbType?.());
      }

      update(update: ViewUpdate) {
        // schemas 异步加载时未必伴随 doc/viewport 变化，每次 update 重建以保证及时上色
        this.decorations = buildSemanticDecorations(update.view, getSchemas(), getDbType?.());
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
