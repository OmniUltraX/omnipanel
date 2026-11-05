import type { DbColumnMeta } from "../api";
import { isSameCellValue } from "../cell_editor/types";
import { extractTableRefsFromRegex } from "../sqlEditor/parser/analyzer";
import { escapeSqlLiteral } from "./escapeSqlLiteral";
import { quoteSqlIdent } from "../grid/tableDataGridCopySql";
import { readRowKeyValue } from "../workspace/dbWorkspaceTabHelpers";
import { resolvePreviewRowKey } from "../workspace/dbWorkspaceState";

export type SqlResultEditTarget = {
  schemaName?: string;
  tableName: string;
  alias?: string;
};

/** SELECT 列表项归属：用于 JOIN 结果列唯一定位到基表。 */
export type SqlResultSelectOrigin =
  | { kind: "star"; qualifier?: string }
  | { kind: "column"; qualifier?: string; column: string; outputName: string }
  | { kind: "expression"; outputName?: string };

export type SqlResultEditColumns = {
  /** 可编辑结果列元数据（含所属表主键列，便于网格按列 id 查找） */
  columnMeta: DbColumnMeta[];
  /** 参与行键的全部主键结果列（多表取并集） */
  pkResultNames: string[];
  resultToTableName: Record<string, string>;
  columnTypeByResultName: Record<string, string>;
  /** 结果列 → targets 下标 */
  resultToTargetIndex: Record<string, number>;
  targets: SqlResultEditTarget[];
  /** 各表主键对应的结果列名 */
  pkResultNamesByTarget: string[][];
};

export type SqlResultDirtyRows = Record<string, Record<string, unknown>>;

/**
 * 可写回的 SELECT：单表或 JOIN 多表均可。
 * DISTINCT / GROUP BY / 聚合 / 子查询 FROM / 集合运算仍整页只读。
 */
export function resolveSqlResultEditTargets(sql: string): SqlResultEditTarget[] | null {
  const normalized = stripSqlComments(sql).trim().replace(/;+\s*$/u, "").trim();
  if (!normalized) return null;
  const scanned = maskSqlStrings(normalized);
  if (scanned.includes(";")) return null;

  const selectBody = stripLeadingWithClause(scanned);
  if (!selectBody || !/^select\b/i.test(selectBody)) return null;
  if (/\b(union|intersect|except|minus)\b/i.test(selectBody)) return null;
  if (/\bgroup\s+by\b/i.test(selectBody)) return null;
  if (/\bhaving\b/i.test(selectBody)) return null;
  if (/\bdistinct\b/i.test(selectBody)) return null;
  if (/\binto\b/i.test(selectBody)) return null;
  if (/\bfrom\s*\(/i.test(selectBody)) return null;
  if (/\(\s*select\b/i.test(selectBody)) return null;
  if (/\b(count|sum|avg|min|max|group_concat|json_arrayagg|json_objectagg)\s*\(/i.test(selectBody)) {
    return null;
  }

  const refs = extractTableRefsFromRegex(selectBody);
  if (refs.length === 0) return null;

  return refs
    .map((ref) => {
      const tableName = ref.tableName.trim();
      const schemaName = ref.schemaName?.trim();
      const alias = ref.alias?.trim();
      const target: SqlResultEditTarget = schemaName ? { schemaName, tableName } : { tableName };
      if (alias) target.alias = alias;
      return target;
    })
    .filter((target) => Boolean(target.tableName));
}

/** 单表便利接口：多表（含 JOIN）时返回 null。 */
export function resolveSqlResultEditTarget(sql: string): SqlResultEditTarget | null {
  const targets = resolveSqlResultEditTargets(sql);
  if (!targets || targets.length !== 1) return null;
  const only = targets[0];
  if (!only) return null;
  return only.schemaName
    ? { schemaName: only.schemaName, tableName: only.tableName }
    : { tableName: only.tableName };
}

/** 解析 SELECT 列表列归属（不含 FROM 之后）。失败返回 null。 */
export function parseSqlResultSelectOrigins(sql: string): SqlResultSelectOrigin[] | null {
  const normalized = stripSqlComments(sql).trim().replace(/;+\s*$/u, "").trim();
  if (!normalized) return null;
  const scanned = maskSqlStrings(normalized);
  const selectBody = stripLeadingWithClause(scanned);
  if (!selectBody || !/^select\b/i.test(selectBody)) return null;
  const list = extractSelectListSegment(selectBody);
  if (list == null) return null;
  const items = splitTopLevelComma(list);
  if (items.length === 0) return null;

  const origins: SqlResultSelectOrigin[] = [];
  for (const rawItem of items) {
    const parsed = parseSelectListItem(rawItem);
    if (!parsed) return null;
    origins.push(parsed);
  }
  return origins;
}

/**
 * 单表匹配（兼容旧调用）。
 * 结果列能对上表列，且主键都在结果里，才允许编辑。
 */
export function matchSqlResultEditColumns(
  resultColumns: string[],
  tableColumns: DbColumnMeta[],
  target?: SqlResultEditTarget,
): SqlResultEditColumns | null {
  return matchSqlResultEditColumnsForTables(
    resultColumns,
    [{ target: target ?? { tableName: "__single__" }, columns: tableColumns }],
    null,
  );
}

/**
 * 多表 / JOIN：列可编 iff 唯一归属基表 T 且 T 的主键列都在结果中。
 * 有 selectOrigins 时：按 column 的 outputName/限定符映射；expression 别名只读；
 * 含 * / t.* 时，剩余结果列再按列名唯一归属（可限制在 t 表）。
 * 无 origins 时整表按列名唯一归属（单表 SELECT * 等）。
 */
export function matchSqlResultEditColumnsForTables(
  resultColumns: string[],
  tables: Array<{ target: SqlResultEditTarget; columns: DbColumnMeta[] }>,
  selectOrigins: SqlResultSelectOrigin[] | null,
): SqlResultEditColumns | null {
  if (!resultColumns.length || tables.length === 0) return null;

  const qualifierToIndex = buildQualifierIndex(tables.map((table) => table.target));

  type Mapping = { tableIndex: number; tableColumn: string; meta: DbColumnMeta };
  const mappedByResult = new Map<string, Mapping>();
  const blocked = new Set<string>();
  const duplicateNames = new Set<string>();

  const rememberDuplicate = (resultName: string) => {
    if (mappedByResult.has(resultName)) mappedByResult.delete(resultName);
    duplicateNames.add(resultName);
    blocked.add(resultName);
  };

  const seenResult = new Set<string>();
  for (const resultName of resultColumns) {
    if (seenResult.has(resultName)) rememberDuplicate(resultName);
    else seenResult.add(resultName);
  }

  const hasStar = Boolean(selectOrigins?.some((origin) => origin.kind === "star"));
  const starQualifiers = (selectOrigins ?? [])
    .filter((origin): origin is Extract<SqlResultSelectOrigin, { kind: "star" }> => origin.kind === "star")
    .map((origin) => origin.qualifier?.toLowerCase())
    .filter((value): value is string => Boolean(value));

  if (selectOrigins) {
    for (const origin of selectOrigins) {
      if (origin.kind === "expression") {
        if (origin.outputName) blocked.add(origin.outputName);
        continue;
      }
      if (origin.kind !== "column") continue;
      const resultName = origin.outputName;
      if (!resultColumns.includes(resultName) || blocked.has(resultName) || duplicateNames.has(resultName)) {
        continue;
      }
      const mapping = mapOriginToTable(origin, tables, qualifierToIndex);
      if (!mapping) continue;
      if (mappedByResult.has(resultName)) {
        rememberDuplicate(resultName);
        continue;
      }
      mappedByResult.set(resultName, mapping);
    }
  }

  for (const resultName of resultColumns) {
    if (mappedByResult.has(resultName) || blocked.has(resultName) || duplicateNames.has(resultName)) {
      continue;
    }
    // 明确选出的列已处理；仅 * / 无 origins 时才用列名兜底
    if (selectOrigins && !hasStar) continue;
    let mapping: Mapping | null = null;
    if (starQualifiers.length > 0) {
      const scopedIndexes = [
        ...new Set(
          starQualifiers
            .map((qualifier) => qualifierToIndex.get(qualifier))
            .filter((index): index is number => index != null),
        ),
      ];
      if (scopedIndexes.length > 0) {
        mapping = mapResultNameUniquely(
          resultName,
          scopedIndexes.map((index) => tables[index]!),
        );
        if (mapping) {
          mapping = {
            ...mapping,
            tableIndex: scopedIndexes[mapping.tableIndex]!,
          };
        }
      } else {
        mapping = mapResultNameUniquely(resultName, tables);
      }
    } else {
      mapping = mapResultNameUniquely(resultName, tables);
    }
    if (mapping) mappedByResult.set(resultName, mapping);
  }

  const pkResultNamesByTarget: string[][] = tables.map(() => []);
  const tableEditable = tables.map((table, tableIndex) => {
    const pkCols = table.columns.filter((column) => column.isPk);
    if (pkCols.length === 0) return false;
    const pkResultNames: string[] = [];
    for (const pk of pkCols) {
      let found: string | null = null;
      for (const [resultName, mapping] of mappedByResult) {
        if (mapping.tableIndex === tableIndex && mapping.tableColumn === pk.name) {
          found = resultName;
          break;
        }
      }
      if (!found) return false;
      pkResultNames.push(found);
    }
    pkResultNamesByTarget[tableIndex] = pkResultNames;
    return true;
  });

  const columnMeta: DbColumnMeta[] = [];
  const resultToTableName: Record<string, string> = {};
  const columnTypeByResultName: Record<string, string> = {};
  const resultToTargetIndex: Record<string, number> = {};
  const pkResultNames: string[] = [];
  const pkSeen = new Set<string>();

  for (const [resultName, mapping] of mappedByResult) {
    if (!tableEditable[mapping.tableIndex]) continue;
    columnMeta.push({ ...mapping.meta, name: resultName });
    resultToTableName[resultName] = mapping.tableColumn;
    columnTypeByResultName[resultName] = mapping.meta.type;
    resultToTargetIndex[resultName] = mapping.tableIndex;
  }

  for (let i = 0; i < tables.length; i++) {
    if (!tableEditable[i]) continue;
    for (const name of pkResultNamesByTarget[i] ?? []) {
      if (pkSeen.has(name)) continue;
      pkSeen.add(name);
      pkResultNames.push(name);
    }
  }

  if (columnMeta.length === 0 || pkResultNames.length === 0) return null;

  return {
    columnMeta,
    pkResultNames,
    resultToTableName,
    columnTypeByResultName,
    resultToTargetIndex,
    targets: tables.map((table) => table.target),
    pkResultNamesByTarget,
  };
}

export function sqlResultCellDirty(
  dirty: SqlResultDirtyRows,
  row: Record<string, unknown>,
  pkResultNames: string[],
  column: string,
  value: unknown,
  baseValue?: unknown,
): SqlResultDirtyRows {
  const rowKey = resolvePreviewRowKey(
    row,
    pkResultNames.map((name) => ({ name })),
  );
  if (!rowKey) return dirty;
  const original = baseValue !== undefined ? baseValue : row[column];
  const next: SqlResultDirtyRows = { ...dirty };
  const rowDirty = { ...(next[rowKey] ?? {}) };
  if (isSameCellValue(original, value)) {
    delete rowDirty[column];
  } else {
    rowDirty[column] = value;
  }
  if (Object.keys(rowDirty).length === 0) {
    delete next[rowKey];
  } else {
    next[rowKey] = rowDirty;
  }
  return next;
}

export function mergeSqlResultOverrides(
  committed: SqlResultDirtyRows,
  dirty: SqlResultDirtyRows,
): SqlResultDirtyRows {
  const merged: SqlResultDirtyRows = { ...committed };
  for (const [rowKey, columns] of Object.entries(dirty)) {
    merged[rowKey] = { ...(merged[rowKey] ?? {}), ...columns };
  }
  return merged;
}

export function countSqlResultDirtyCells(dirty: SqlResultDirtyRows): number {
  let count = 0;
  for (const columns of Object.values(dirty)) {
    count += Object.keys(columns).length;
  }
  return count;
}

export function buildSqlResultUpdateStatements(opts: {
  dbType?: string;
  dirty: SqlResultDirtyRows;
  resultToTableName: Record<string, string>;
  columnTypeByResultName: Record<string, string>;
  /** 多表：优先使用 */
  targets?: SqlResultEditTarget[];
  pkResultNamesByTarget?: string[][];
  resultToTargetIndex?: Record<string, number>;
  /** 单表兼容 */
  schemaName?: string;
  tableName?: string;
  pkResultNames?: string[];
}): string[] {
  const { dbType, dirty, resultToTableName, columnTypeByResultName } = opts;

  const targets =
    opts.targets && opts.targets.length > 0
      ? opts.targets
      : opts.tableName
        ? [{ schemaName: opts.schemaName, tableName: opts.tableName }]
        : [];
  if (targets.length === 0) return [];

  const pkByTarget: string[][] =
    opts.pkResultNamesByTarget && opts.pkResultNamesByTarget.length === targets.length
      ? opts.pkResultNamesByTarget
      : targets.map(() => opts.pkResultNames ?? []);

  const resultToTargetIndex =
    opts.resultToTargetIndex ??
    Object.fromEntries(Object.keys(resultToTableName).map((name) => [name, 0] as const));

  const statements: string[] = [];
  const limit = isMysqlEngine(dbType) ? " LIMIT 1" : "";

  for (const [rowKey, changes] of Object.entries(dirty)) {
    const entries = Object.entries(changes);
    if (entries.length === 0) continue;

    const byTarget = new Map<number, Array<[string, unknown]>>();
    for (const entry of entries) {
      const resultName = entry[0];
      const targetIndex = resultToTargetIndex[resultName];
      if (targetIndex == null || targetIndex < 0 || targetIndex >= targets.length) continue;
      const list = byTarget.get(targetIndex) ?? [];
      list.push(entry);
      byTarget.set(targetIndex, list);
    }

    for (const [targetIndex, targetChanges] of byTarget) {
      const target = targets[targetIndex]!;
      const pkResultNames = pkByTarget[targetIndex] ?? [];
      if (!target.tableName || pkResultNames.length === 0 || targetChanges.length === 0) continue;

      const tableSql = target.schemaName
        ? `${quoteSqlIdent(dbType, target.schemaName)}.${quoteSqlIdent(dbType, target.tableName)}`
        : quoteSqlIdent(dbType, target.tableName);
      const setClause = targetChanges
        .map(([resultName, value]) => {
          const tableColumn = resultToTableName[resultName] ?? resultName;
          return `${quoteSqlIdent(dbType, tableColumn)} = ${escapeSqlLiteral(value, {
            dbType,
            columnType: columnTypeByResultName[resultName] ?? null,
          })}`;
        })
        .join(", ");
      const whereClause = pkResultNames
        .map((resultName) => {
          const tableColumn = resultToTableName[resultName] ?? resultName;
          const ident = quoteSqlIdent(dbType, tableColumn);
          const raw = readRowKeyValue(rowKey, resultName);
          if (raw === "") return `${ident} IS NULL`;
          return `${ident} = ${escapeSqlLiteral(raw, {
            dbType,
            columnType: columnTypeByResultName[resultName] ?? null,
          })}`;
        })
        .join(" AND ");
      statements.push(`UPDATE ${tableSql} SET ${setClause} WHERE ${whereClause}${limit}`);
    }
  }

  return statements;
}

function buildQualifierIndex(targets: SqlResultEditTarget[]): Map<string, number> {
  const map = new Map<string, number>();
  const tableNameCounts = new Map<string, number>();
  for (const target of targets) {
    const key = target.tableName.toLowerCase();
    tableNameCounts.set(key, (tableNameCounts.get(key) ?? 0) + 1);
  }
  targets.forEach((target, index) => {
    if (target.alias) map.set(target.alias.toLowerCase(), index);
    const tableKey = target.tableName.toLowerCase();
    if ((tableNameCounts.get(tableKey) ?? 0) === 1) {
      map.set(tableKey, index);
    }
  });
  return map;
}

function mapOriginToTable(
  origin: SqlResultSelectOrigin,
  tables: Array<{ target: SqlResultEditTarget; columns: DbColumnMeta[] }>,
  qualifierToIndex: Map<string, number>,
): { tableIndex: number; tableColumn: string; meta: DbColumnMeta } | null {
  if (origin.kind !== "column") return null;
  if (origin.qualifier) {
    const tableIndex = qualifierToIndex.get(origin.qualifier.toLowerCase());
    if (tableIndex == null) return null;
    const meta = findColumnMeta(tables[tableIndex]!.columns, origin.column);
    if (!meta) return null;
    return { tableIndex, tableColumn: meta.name, meta };
  }
  return mapResultNameUniquely(origin.column, tables);
}

function mapResultNameUniquely(
  resultName: string,
  tables: Array<{ target: SqlResultEditTarget; columns: DbColumnMeta[] }>,
): { tableIndex: number; tableColumn: string; meta: DbColumnMeta } | null {
  const hits: Array<{ tableIndex: number; meta: DbColumnMeta }> = [];
  tables.forEach((table, tableIndex) => {
    const meta = findColumnMeta(table.columns, resultName);
    if (meta) hits.push({ tableIndex, meta });
  });
  if (hits.length !== 1) return null;
  const only = hits[0]!;
  return { tableIndex: only.tableIndex, tableColumn: only.meta.name, meta: only.meta };
}

function findColumnMeta(columns: DbColumnMeta[], name: string): DbColumnMeta | null {
  return (
    columns.find((column) => column.name === name) ??
    columns.find((column) => column.name.toLowerCase() === name.toLowerCase()) ??
    null
  );
}

function extractSelectListSegment(selectBody: string): string | null {
  const head = selectBody.match(/^select\s+/i);
  if (!head) return null;
  let i = head[0].length;
  const len = selectBody.length;
  const allMatch = selectBody.slice(i).match(/^all\s+/i);
  if (allMatch) i += allMatch[0].length;

  let depth = 0;
  for (let j = i; j < len; j++) {
    const ch = selectBody[j];
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (/^from\b/i.test(selectBody.slice(j))) {
      return selectBody.slice(i, j).trim();
    }
  }
  return null;
}

function splitTopLevelComma(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseSelectListItem(raw: string): SqlResultSelectOrigin | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let expr = trimmed;
  let alias: string | undefined;

  const asMatch = trimmed.match(/^([\s\S]+?)\s+AS\s+([`"]?[\w$]+[`"]?)$/i);
  if (asMatch) {
    expr = asMatch[1]!.trim();
    alias = stripIdentQuotes(asMatch[2]!);
  } else {
    // 隐式别名：左侧不是「单个简单标识符」时，右侧才当作别名（如 a.id bid）
    const implicit = trimmed.match(/^(.+?)\s+([`"]?[\w$]+[`"]?)$/);
    if (implicit) {
      const left = implicit[1]!.trim();
      const right = stripIdentQuotes(implicit[2]!);
      if (right && !isSqlKeyword(right) && !isSimpleColumnRef(trimmed) && parseSimpleColumnRef(left)) {
        expr = left;
        alias = right;
      }
    }
  }

  if (expr === "*" || trimmed === "*") {
    return { kind: "star" };
  }
  const qualStar = expr.match(/^([`"]?[\w$]+[`"]?)\.\*$/);
  if (qualStar) {
    return { kind: "star", qualifier: stripIdentQuotes(qualStar[1]!) };
  }

  const simple = parseSimpleColumnRef(expr);
  if (simple) {
    return {
      kind: "column",
      qualifier: simple.qualifier,
      column: simple.column,
      outputName: alias ?? simple.column,
    };
  }

  return { kind: "expression", outputName: alias };
}

function isSimpleColumnRef(text: string): boolean {
  return parseSimpleColumnRef(text) != null;
}

function parseSimpleColumnRef(text: string): { qualifier?: string; column: string } | null {
  const trimmed = text.trim();
  const qualified = trimmed.match(/^([`"]?[\w$]+[`"]?)\.([`"]?[\w$]+[`"]?)$/);
  if (qualified) {
    return {
      qualifier: stripIdentQuotes(qualified[1]!),
      column: stripIdentQuotes(qualified[2]!),
    };
  }
  const bare = trimmed.match(/^([`"]?[\w$]+[`"]?)$/);
  if (bare) {
    const column = stripIdentQuotes(bare[1]!);
    if (!column || isSqlKeyword(column)) return null;
    return { column };
  }
  return null;
}

function stripIdentQuotes(name: string): string {
  return name.replace(/^[`"]|[`"]$/g, "");
}

function isSqlKeyword(name: string): boolean {
  return /^(AS|FROM|WHERE|JOIN|ON|AND|OR|SELECT|IN|IS|NOT|NULL|LIKE|BETWEEN|CASE|WHEN|THEN|ELSE|END)$/i.test(
    name,
  );
}

function isMysqlEngine(dbType: string | undefined): boolean {
  const type = (dbType ?? "mysql").toLowerCase();
  return type.includes("mysql") || type.includes("mariadb");
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function maskSqlStrings(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

/** 去掉前导 WITH cte AS (...), ...，露出主查询 SELECT；解析失败返回 null。 */
function stripLeadingWithClause(sql: string): string | null {
  const trimmed = sql.trim();
  if (!/^with\b/i.test(trimmed)) return trimmed;

  let i = trimmed.search(/\bwith\b/i);
  if (i < 0) return null;
  i += 4;
  const len = trimmed.length;

  const skipWs = () => {
    while (i < len && /\s/.test(trimmed[i]!)) i += 1;
  };

  while (i < len) {
    skipWs();
    const name = trimmed.slice(i).match(/^(?:[`"][\w$]+[`"]|[\w$]+)/);
    if (!name) return null;
    i += name[0].length;
    skipWs();
    if (trimmed[i] === "(") {
      const close = findMatchingCloseParen(trimmed, i);
      if (close < 0) return null;
      i = close + 1;
      skipWs();
    }
    if (!/^as\b/i.test(trimmed.slice(i))) return null;
    i += 2;
    skipWs();
    if (trimmed[i] !== "(") return null;
    const close = findMatchingCloseParen(trimmed, i);
    if (close < 0) return null;
    i = close + 1;
    skipWs();
    if (trimmed[i] === ",") {
      i += 1;
      continue;
    }
    break;
  }

  skipWs();
  const rest = trimmed.slice(i).trim();
  return /^select\b/i.test(rest) ? rest : null;
}

function findMatchingCloseParen(sql: string, openIndex: number): number {
  let depth = 1;
  for (let i = openIndex + 1; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
