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
