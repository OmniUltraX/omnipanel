import type { Catalog, ResolvedTable } from "../catalog";
import { safeParseStatement } from "./ast";

export interface TableRef {
  schemaName?: string;
  tableName: string;
  alias?: string;
}

export interface StatementAnalysis {
  tables: TableRef[];
  aliasMap: Map<string, TableRef>;
  primaryTable: TableRef | null;
}

type FromLike = {
  db?: string | null;
  table?: string | null;
  as?: string | null;
};

const TABLE_REF_STOP_WORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "ON",
  "AND",
  "OR",
  "AS",
  "IN",
  "NOT",
  "NULL",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "CROSS",
  "FULL",
  "NATURAL",
  "USING",
  "SET",
  "VALUES",
  "INTO",
  "UPDATE",
  "DELETE",
  "INSERT",
  "BY",
  "GROUP",
  "ORDER",
  "HAVING",
  "LIMIT",
  "UNION",
  "DISTINCT",
  "LATERAL",
  "TRUE",
  "FALSE",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "EXISTS",
  "BETWEEN",
  "LIKE",
  "IS",
]);

function stripIdentifierQuotes(name: string): string {
  return name.replace(/^[`"]|[`"]$/g, "");
}

function isStopWord(name: string): boolean {
  return TABLE_REF_STOP_WORDS.has(stripIdentifierQuotes(name).toUpperCase());
}

function refKey(ref: TableRef): string {
  return `${ref.schemaName ?? ""}:${ref.tableName}:${ref.alias ?? ""}`.toLowerCase();
}

function pushFromItem(target: TableRef[], item: unknown): void {
  if (!item || typeof item !== "object") return;
  const row = item as FromLike & { expr?: unknown; type?: string };
  if (row.expr && row.as) {
    return;
  }
  if (!row.table) return;
  const tableName = stripIdentifierQuotes(String(row.table));
  if (!tableName || isStopWord(tableName)) return;
  const aliasRaw = row.as ? stripIdentifierQuotes(String(row.as)) : undefined;
  const alias = aliasRaw && !isStopWord(aliasRaw) ? aliasRaw : undefined;
  target.push({
    schemaName: row.db ? stripIdentifierQuotes(String(row.db)) : undefined,
    tableName,
    alias,
  });
}

function collectFromList(from: unknown): TableRef[] {
  if (!from) return [];
  if (Array.isArray(from)) {
    const refs: TableRef[] = [];
    for (const item of from) {
      pushFromItem(refs, item);
    }
    return refs;
  }
  const refs: TableRef[] = [];
  pushFromItem(refs, from);
  return refs;
}

function buildAliasMap(refs: TableRef[]): Map<string, TableRef> {
  const map = new Map<string, TableRef>();
  for (const ref of refs) {
    if (ref.alias) {
      map.set(ref.alias.toLowerCase(), ref);
    }
    map.set(ref.tableName.toLowerCase(), ref);
  }
  return map;
}

function buildAnalysis(refs: TableRef[]): StatementAnalysis | null {
  if (refs.length === 0) return null;
  return {
    tables: refs,
    aliasMap: buildAliasMap(refs),
    primaryTable: refs[0] ?? null,
  };
}

function mergeTableRefs(primary: TableRef[], secondary: TableRef[]): TableRef[] {
  const map = new Map<string, TableRef>();
  for (const ref of [...primary, ...secondary]) {
    map.set(refKey(ref), ref);
  }
  return [...map.values()];
}

function parseQualifiedTableToken(token: string): { schemaName?: string; tableName: string } | null {
  const cleaned = stripIdentifierQuotes(token.trim());
  if (!cleaned || isStopWord(cleaned)) return null;
  const dot = cleaned.match(/^(`?[\w$]+`?)\.(`?[\w$]+`?)$/);
  if (dot) {
    const schemaName = stripIdentifierQuotes(dot[1]);
    const tableName = stripIdentifierQuotes(dot[2]);
    if (!tableName || isStopWord(tableName)) return null;
    return { schemaName: schemaName || undefined, tableName };
  }
  return { tableName: cleaned };
}

function pushRegexRef(
  target: TableRef[],
  seen: Set<string>,
  schemaName: string | undefined,
  tableName: string,
  alias: string | undefined,
): void {
  if (!tableName || isStopWord(tableName)) return;
  const aliasName = alias && !isStopWord(alias) ? alias : undefined;
  const ref: TableRef = { schemaName, tableName, alias: aliasName };
  const key = refKey(ref);
  if (seen.has(key)) return;
  seen.add(key);
  target.push(ref);
}

function parseTableAliasChunk(chunk: string, target: TableRef[], seen: Set<string>): void {
  const trimmed = chunk.trim();
  if (!trimmed) return;
  const withoutOn = trimmed.replace(/\s+\bON\b[\s\S]*$/i, "").trim();
  const match = withoutOn.match(
    /^((?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?)(?:\s+(?:AS\s+)?([`"]?[\w$]+[`"]?))?$/i,
  );
  if (!match) return;
  const parsed = parseQualifiedTableToken(match[1]);
  if (!parsed) return;
  const aliasRaw = match[2] ? stripIdentifierQuotes(match[2]) : undefined;
  pushRegexRef(target, seen, parsed.schemaName, parsed.tableName, aliasRaw);
}

function extractFromClauseSegment(sql: string): string {
  const fromMatch = sql.match(/\bFROM\b([\s\S]*)/i);
  if (!fromMatch) return "";
  let segment = fromMatch[1];
  const stop = segment.search(
    /\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|UNION|EXCEPT|INTERSECT)\b/i,
  );
  if (stop >= 0) {
    segment = segment.slice(0, stop);
  }
  return segment;
}

/** AST 解析失败或语句未写完时，从 FROM/JOIN/UPDATE 子句正则提取表与别名。 */
export function extractTableRefsFromRegex(sql: string): TableRef[] {
  const refs: TableRef[] = [];
  const seen = new Set<string>();

  const fromSegment = extractFromClauseSegment(sql);
  if (fromSegment) {
    const joinParts = fromSegment.split(/\b(?:,(?![^()]*\)))|\b(?:INNER|LEFT|RIGHT|FULL|CROSS|NATURAL)?\s*JOIN\b/i);
    for (const part of joinParts) {
      parseTableAliasChunk(part, refs, seen);
    }
  }

  const updateRe =
    /\bUPDATE\s+((?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?)(?:\s+(?:AS\s+)?([`"]?[\w$]+[`"]?))?(?=\s+SET\b)/gi;
  for (const match of sql.matchAll(updateRe)) {
    const parsed = parseQualifiedTableToken(match[1]);
    if (!parsed) continue;
    const aliasRaw = match[2] ? stripIdentifierQuotes(match[2]) : undefined;
    pushRegexRef(refs, seen, parsed.schemaName, parsed.tableName, aliasRaw);
  }

  const deleteRe =
    /\bDELETE\s+FROM\s+((?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?)(?:\s+(?:AS\s+)?([`"]?[\w$]+[`"]?))?/gi;
  for (const match of sql.matchAll(deleteRe)) {
    const parsed = parseQualifiedTableToken(match[1]);
    if (!parsed) continue;
    const aliasRaw = match[2] ? stripIdentifierQuotes(match[2]) : undefined;
    pushRegexRef(refs, seen, parsed.schemaName, parsed.tableName, aliasRaw);
  }

  return refs;
}

function analyzeAstNode(ast: unknown): StatementAnalysis | null {
  if (!ast || typeof ast !== "object") return null;
  const node = ast as { type?: string; from?: unknown; table?: unknown };
  let tables: TableRef[] = [];

  if (node.type === "select") {
    tables = collectFromList(node.from);
  } else if (node.type === "update" || node.type === "delete") {
    tables = collectFromList(node.table);
  } else if (node.type === "insert") {
    pushFromItem(tables, node.table);
  }

  return buildAnalysis(tables);
}

type SelectAst = {
  type?: string;
  from?: unknown;
  with?: WithItemAst[];
};

type WithItemAst = {
  name?: { value?: string };
  stmt?: { ast?: SelectAst };
};

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMatchingOpenParen(sql: string, closeIndex: number): number {
  let depth = 1;
  for (let i = closeIndex - 1; i >= 0; i--) {
    const ch = sql[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findMatchingCloseParen(sql: string, openIndex: number): number {
  let depth = 1;
  for (let i = openIndex + 1; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findSubqueryContentRangeContaining(
  sql: string,
  alias: string,
  offset: number,
): { start: number; end: number } | null {
  const aliasRe = new RegExp(`\\)\\s*(?:AS\\s+)?${escapeRegex(alias)}\\b`, "gi");
  let match: RegExpExecArray | null;
  while ((match = aliasRe.exec(sql))) {
    const closeParen = match.index;
    const openParen = findMatchingOpenParen(sql, closeParen);
    if (openParen < 0) continue;
    const start = openParen + 1;
    const end = closeParen;
    if (offset >= start && offset <= end) {
      return { start, end };
    }
  }
  return null;
}

function findCteBodyRangeContaining(
  sql: string,
  cteName: string,
  offset: number,
): { start: number; end: number } | null {
  const cteRe = new RegExp(`\\b${escapeRegex(cteName)}\\s+AS\\s*\\(`, "gi");
  let match: RegExpExecArray | null;
  while ((match = cteRe.exec(sql))) {
    const openParen = match.index + match[0].length - 1;
    const closeParen = findMatchingCloseParen(sql, openParen);
    if (closeParen < 0) continue;
    const start = openParen + 1;
    const end = closeParen;
    if (offset >= start && offset <= end) {
      return { start, end };
    }
  }
  return null;
}

/** 根据光标位置定位最内层 SELECT 作用域（嵌套子查询 / CTE）。 */
function findScopedSelectAst(select: SelectAst, sql: string, offset: number): SelectAst {
  const withItems = select.with;
  if (withItems) {
    for (const item of withItems) {
      const alias = item.name?.value ? stripIdentifierQuotes(String(item.name.value)) : null;
      const sub = item.stmt?.ast;
      if (!alias || sub?.type !== "select") continue;
      const range = findCteBodyRangeContaining(sql, alias, offset);
      if (range) {
        return findScopedSelectAst(sub, sql, offset);
      }
    }
  }

  const from = select.from;
  if (!from) return select;
  const items = Array.isArray(from) ? from : [from];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as { expr?: { ast?: SelectAst }; as?: string | null };
    const sub = row.expr?.ast;
    const alias = row.as ? stripIdentifierQuotes(String(row.as)) : null;
    if (sub?.type !== "select" || !alias) continue;
    const range = findSubqueryContentRangeContaining(sql, alias, offset);
    if (range) {
      return findScopedSelectAst(sub, sql, offset);
    }
  }
  return select;
}

/** 解析光标所在 SELECT 作用域内的表引用与别名（嵌套子查询优先）。 */
export function analyzeStatementAtOffset(
  sql: string,
  offset: number,
  dbType?: string | null,
): StatementAnalysis | null {
  const leading = sql.length - sql.trimStart().length;
  const trimmed = sql.trim();
  if (!trimmed) return null;

  const adjustedOffset = Math.max(0, Math.min(offset - leading, trimmed.length));

  const ast = safeParseStatement(trimmed, dbType);
  if (!ast || typeof ast !== "object") {
    return analyzeStatement(trimmed, dbType);
  }

  const root = (Array.isArray(ast) ? ast[0] : ast) as SelectAst;
  if (root.type !== "select") {
    return analyzeStatement(trimmed, dbType);
  }

  const scoped = findScopedSelectAst(root, trimmed, adjustedOffset);
  const scopedAnalysis = analyzeAstNode(scoped);
  if (scopedAnalysis && scopedAnalysis.tables.length > 0) {
    return scopedAnalysis;
  }

  return analyzeStatement(trimmed, dbType);
}

/** 解析单条 SQL 语句，提取表引用与别名映射（AST 优先，正则兜底/合并）。 */
export function analyzeStatement(sql: string, dbType?: string | null): StatementAnalysis | null {
  const trimmed = sql.trim();
  if (!trimmed) return null;

  const regexRefs = extractTableRefsFromRegex(trimmed);
  const ast = safeParseStatement(trimmed, dbType);
  const astAnalysis = ast
    ? analyzeAstNode(Array.isArray(ast) ? ast[0] : ast)
    : null;

  if (astAnalysis && astAnalysis.tables.length > 0) {
    const merged = mergeTableRefs(astAnalysis.tables, regexRefs);
    return buildAnalysis(merged);
  }

  return buildAnalysis(regexRefs);
}

export function resolveTableByAlias(
  catalog: Catalog,
  analysis: StatementAnalysis,
  aliasOrTable: string,
): ResolvedTable | null {
  const key = aliasOrTable.toLowerCase();
  const ref = analysis.aliasMap.get(key);
  if (!ref) return null;
  return catalog.findTable(ref.tableName, ref.schemaName);
}

export function resolvePrimaryFromTable(
  catalog: Catalog,
  analysis: StatementAnalysis,
): ResolvedTable | null {
  if (!analysis.primaryTable) return null;
  return catalog.findTable(analysis.primaryTable.tableName, analysis.primaryTable.schemaName);
}

/** 语句中所有已解析表（含 JOIN / 别名）。 */
export function resolveAllTablesInStatement(
  catalog: Catalog,
  analysis: StatementAnalysis,
): ResolvedTable[] {
  const results: ResolvedTable[] = [];
  const seen = new Set<string>();
  for (const ref of analysis.tables) {
    const resolved = catalog.findTable(ref.tableName, ref.schemaName);
    if (!resolved) continue;
    const key = resolved.qualifiedTable.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(resolved);
  }
  return results;
}

export function qualifiersForTableRef(ref: TableRef): string[] {
  const names = new Set<string>();
  names.add(ref.tableName);
  if (ref.alias) {
    names.add(ref.alias);
  }
  return [...names];
}

export interface TableRefSpan {
  schemaName?: string;
  tableName: string;
  from: number;
  to: number;
}

function tableTokenSpan(token: string, tokenFrom: number): TableRefSpan | null {
  const parsed = parseQualifiedTableToken(token);
  if (!parsed) return null;

  if (parsed.schemaName) {
    const dot = token.lastIndexOf(".");
    const tablePart = token.slice(dot + 1);
    const innerTable = stripIdentifierQuotes(tablePart);
    const tableFrom = tokenFrom + dot + 1;
    const leadQuote = tablePart.startsWith("`") || tablePart.startsWith('"') ? 1 : 0;
    return {
      schemaName: parsed.schemaName,
      tableName: parsed.tableName,
      from: tableFrom + leadQuote,
      to: tableFrom + leadQuote + innerTable.length,
    };
  }

  const leadQuote = token.startsWith("`") || token.startsWith('"') ? 1 : 0;
  const inner = stripIdentifierQuotes(token);
  return {
    tableName: parsed.tableName,
    from: tokenFrom + leadQuote,
    to: tokenFrom + leadQuote + inner.length,
  };
}

function pushRegexSpan(spans: TableRefSpan[], token: string, tokenFrom: number): void {
  const span = tableTokenSpan(token, tokenFrom);
  if (!span) return;
  spans.push(span);
}

function parseTableAliasChunkWithSpans(
  chunk: string,
  chunkStart: number,
  spans: TableRefSpan[],
): void {
  const trimmed = chunk.trim();
  if (!trimmed) return;
  const trimOffset = chunk.indexOf(trimmed);
  const chunkBase = chunkStart + trimOffset;
  const withoutOn = trimmed.replace(/\s+\bON\b[\s\S]*$/i, "").trim();
  const onOffset = trimmed.indexOf(withoutOn);
  const base = chunkBase + onOffset;
  const match = withoutOn.match(
    /^((?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?)(?:\s+(?:AS\s+)?([`"]?[\w$]+[`"]?))?$/i,
  );
  if (!match) return;
  const token = match[1];
  const tokenStart = base + withoutOn.indexOf(token);
  pushRegexSpan(spans, token, tokenStart);
}

function extractTableRefSpansFromRegex(sql: string, baseOffset: number): TableRefSpan[] {
  const spans: TableRefSpan[] = [];

  const fromMatch = sql.match(/\bFROM\b([\s\S]*)/i);
  if (fromMatch?.index !== undefined) {
    let segment = fromMatch[1];
    const stop = segment.search(
      /\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|UNION|EXCEPT|INTERSECT)\b/i,
    );
    if (stop >= 0) {
      segment = segment.slice(0, stop);
    }
    const segmentStart = fromMatch.index + fromMatch[0].indexOf(segment);
    const joinParts = segment.split(/\b(?:,(?![^()]*\)))|\b(?:INNER|LEFT|RIGHT|FULL|CROSS|NATURAL)?\s*JOIN\b/i);
    let searchFrom = 0;
    for (const part of joinParts) {
      const partIndex = segment.indexOf(part, searchFrom);
      if (partIndex < 0) continue;
      parseTableAliasChunkWithSpans(part, segmentStart + partIndex, spans);
      searchFrom = partIndex + part.length;
    }
  }

  const updateRe =
    /\bUPDATE\s+((?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?)(?:\s+(?:AS\s+)?([`"]?[\w$]+[`"]?))?(?=\s+SET\b)/gi;
  for (const match of sql.matchAll(updateRe)) {
    const token = match[1];
    const tokenStart = match.index! + match[0].indexOf(token);
    pushRegexSpan(spans, token, tokenStart);
  }

  const deleteRe =
    /\bDELETE\s+FROM\s+((?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?)(?:\s+(?:AS\s+)?([`"]?[\w$]+[`"]?))?/gi;
  for (const match of sql.matchAll(deleteRe)) {
    const token = match[1];
    const tokenStart = match.index! + match[0].indexOf(token);
    pushRegexSpan(spans, token, tokenStart);
  }

  const insertRe = /\bINSERT\s+INTO\s+((?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?)/gi;
  for (const match of sql.matchAll(insertRe)) {
    const token = match[1];
    const tokenStart = match.index! + match[0].indexOf(token);
    pushRegexSpan(spans, token, tokenStart);
  }

  return spans.map((span) => ({
    ...span,
    from: span.from + baseOffset,
    to: span.to + baseOffset,
  }));
}

function dedupeTableRefSpans(spans: TableRefSpan[]): TableRefSpan[] {
  const byRange = new Map<string, TableRefSpan>();
  for (const span of spans) {
    byRange.set(`${span.from}:${span.to}`, span);
  }
  return [...byRange.values()];
}

/** 提取语句中表引用的文档范围（用于 Lint 波浪线）。 */
export function extractTableRefSpans(
  sql: string,
  baseOffset = 0,
  dbType?: string | null,
): TableRefSpan[] {
  const trimmed = sql.trim();
  if (!trimmed) return [];
  const leading = sql.indexOf(trimmed);
  const adjustedBase = baseOffset + leading;

  const spans = extractTableRefSpansFromRegex(trimmed, adjustedBase);
  const analysis = analyzeStatement(trimmed, dbType);
  if (!analysis || analysis.tables.length === 0) {
    return dedupeTableRefSpans(spans);
  }

  const allowed = new Set(analysis.tables.map((ref) => refKey(ref)));
  return dedupeTableRefSpans(
    spans.filter((span) => {
      const ref: TableRef = { schemaName: span.schemaName, tableName: span.tableName };
      return allowed.has(refKey(ref));
    }),
  );
}

function formatMissingTableName(ref: TableRef): string {
  return ref.schemaName ? `${ref.schemaName}.${ref.tableName}` : ref.tableName;
}

/** 判断悬停标识符是否为不存在的表引用，返回展示名。 */
export function resolveMissingTableHover(
  catalog: Catalog,
  analysis: StatementAnalysis | null,
  word: string,
  qualifier: string | null,
): string | null {
  if (!catalog.hasTables()) return null;

  if (qualifier) {
    if (catalog.isDatabaseName(qualifier) && !catalog.findTable(word, qualifier)) {
      return `${qualifier}.${word}`;
    }
    return null;
  }

  if (!analysis) return null;

  const aliasRef = analysis.aliasMap.get(word.toLowerCase());
  if (aliasRef && !catalog.findTable(aliasRef.tableName, aliasRef.schemaName)) {
    return formatMissingTableName(aliasRef);
  }

  const tableRef = analysis.tables.find(
    (ref) =>
      ref.tableName.toLowerCase() === word.toLowerCase() &&
      (!ref.alias || ref.alias.toLowerCase() === word.toLowerCase()),
  );
  if (tableRef && !catalog.findTable(tableRef.tableName, tableRef.schemaName)) {
    return formatMissingTableName(tableRef);
  }

  return null;
}
