import { splitSqlStatements } from "./sqlLex";
import { findSqlSubqueries } from "./sqlSubquery";

/** 一条语句单独指定的执行目标。空列表表示跟文件当前的连接和库。 */
export interface SqlExecTarget {
  connId: string;
  database: string;
}

/** 落在文件上的覆盖。fingerprint 对上语句正文，同一句出现多次按顺序对。 */
export interface SavedSqlStatementTarget {
  fingerprint: string;
  targets: SqlExecTarget[];
  /** 缺省是顶层语句。subquery 只在单独执行这个子查询时生效。 */
  scope?: "subquery";
}

export interface SqlExecUnit {
  sql: string;
  /** null 表示跟文件当前连接和库，并参与脚本会话。 */
  target: SqlExecTarget | null;
}

export function sqlStatementFingerprint(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().replace(/;+\s*$/g, "").toLowerCase();
}

export function sameSqlExecTarget(left: SqlExecTarget, right: SqlExecTarget): boolean {
  return left.connId === right.connId && left.database.toLowerCase() === right.database.toLowerCase();
}

/**
 * 落盘前的覆盖列表。只剩文件当前这一条时清空，语句继续跟着文件走。
 */
export function persistStatementTargets(
  targets: readonly SqlExecTarget[],
  file: SqlExecTarget | null,
): SqlExecTarget[] {
  const normalized = normalizeSqlExecTargets(targets);
  const fileConn = file?.connId.trim() ?? "";
  const fileDatabase = file?.database.trim() ?? "";
  if (
    fileConn &&
    fileDatabase &&
    normalized.length === 1 &&
    sameSqlExecTarget(normalized[0]!, { connId: fileConn, database: fileDatabase })
  ) {
    return [];
  }
  return normalized;
}

export function normalizeSqlExecTargets(targets: readonly SqlExecTarget[]): SqlExecTarget[] {
  const seen = new Set<string>();
  const next: SqlExecTarget[] = [];
  for (const target of targets) {
    const connId = target.connId.trim();
    const database = target.database.trim();
    if (!connId || !database) continue;
    const key = `${connId}\0${database.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push({ connId, database });
  }
  return next;
}

export function parseSavedStatementTargets(raw: unknown): SavedSqlStatementTarget[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return [];
    try {
      list = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const saved: SavedSqlStatementTarget[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as { fingerprint?: unknown; targets?: unknown; scope?: unknown };
    const fingerprint = typeof record.fingerprint === "string" ? record.fingerprint : "";
    const targets = normalizeSqlExecTargets(
      Array.isArray(record.targets)
        ? record.targets.filter((entry): entry is SqlExecTarget => {
            if (!entry || typeof entry !== "object") return false;
            const target = entry as { connId?: unknown; database?: unknown };
            return typeof target.connId === "string" && typeof target.database === "string";
          })
        : [],
    );
    if (!fingerprint || targets.length === 0) continue;
    saved.push({
      fingerprint,
      targets,
      ...(record.scope === "subquery" ? { scope: "subquery" as const } : {}),
    });
  }
  return saved;
}

export function serializeSavedStatementTargets(
  saved: readonly SavedSqlStatementTarget[] | undefined,
): string | null {
  const normalized = (saved ?? [])
    .map((item) => ({
      fingerprint: item.fingerprint,
      targets: normalizeSqlExecTargets(item.targets),
      ...(item.scope === "subquery" ? { scope: "subquery" as const } : {}),
    }))
    .filter((item) => item.fingerprint && item.targets.length > 0);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

function assignScopedTargets(
  statements: readonly { sql: string }[],
  pool: readonly SavedSqlStatementTarget[],
): SqlExecTarget[][] {
  const used = new Set<number>();
  return statements.map((statement) => {
    const fingerprint = sqlStatementFingerprint(statement.sql);
    const index = pool.findIndex(
      (item, itemIndex) =>
        !used.has(itemIndex) &&
        item.fingerprint === fingerprint &&
        item.targets.length > 0,
    );
    if (index < 0) return [];
    used.add(index);
    return normalizeSqlExecTargets(pool[index]!.targets);
  });
}

/** 按语句出现顺序把已保存的覆盖对回去。对不上的丢掉，避免改过的 SQL 还打到旧库。 */
export function assignStatementTargets(
  statements: readonly { sql: string }[],
  saved: readonly SavedSqlStatementTarget[] | undefined,
): SqlExecTarget[][] {
  return assignScopedTargets(
    statements,
    (saved ?? []).filter((item) => item.scope !== "subquery"),
  );
}

/** 子查询单独执行时的覆盖。和顶层语句分开对，避免同一段 SQL 互相抢走。 */
export function assignSubqueryTargets(
  subqueries: readonly { sql: string }[],
  saved: readonly SavedSqlStatementTarget[] | undefined,
): SqlExecTarget[][] {
  return assignScopedTargets(
    subqueries,
    (saved ?? []).filter((item) => item.scope === "subquery"),
  );
}

export function rebindSavedStatementTargets(
  sql: string,
  saved: readonly SavedSqlStatementTarget[] | undefined,
): SavedSqlStatementTarget[] {
  const parts = splitSqlStatements(sql);
  const statements = parts.length > 0 ? parts : sql.trim() ? [{ sql: sql.trim() }] : [];
  const assigned = assignStatementTargets(statements, saved);
  const subqueries = findSqlSubqueries(sql);
  const subqueryAssigned = assignSubqueryTargets(subqueries, saved);
  const next: SavedSqlStatementTarget[] = [];
  statements.forEach((statement, index) => {
    const targets = assigned[index] ?? [];
    if (targets.length === 0) return;
    next.push({ fingerprint: sqlStatementFingerprint(statement.sql), targets });
  });
  subqueries.forEach((query, index) => {
    const targets = subqueryAssigned[index] ?? [];
    if (targets.length === 0) return;
    next.push({
      fingerprint: sqlStatementFingerprint(query.sql),
      targets,
      scope: "subquery",
    });
  });
  return next;
}

/**
 * 光标落在某条子查询里、并且正在执行的就是这段子查询时，返回它的覆盖。
 * 对不上返回 null，调用方再去对顶层语句。空数组表示这条子查询跟文件当前的库。
 */
function subqueryTargetsAt(
  documentSql: string,
  pieceSql: string,
  saved: readonly SavedSqlStatementTarget[] | undefined,
  anchor: number | undefined,
): SqlExecTarget[] | null {
  const subqueries = findSqlSubqueries(documentSql);
  if (subqueries.length === 0) return null;
  const fingerprint = sqlStatementFingerprint(pieceSql);
  const assigned = assignSubqueryTargets(subqueries, saved);
  if (anchor != null) {
    let best = -1;
    subqueries.forEach((query, index) => {
      if (anchor < query.from || anchor > query.to) return;
      if (sqlStatementFingerprint(query.sql) !== fingerprint) return;
      if (best < 0 || query.to - query.from < subqueries[best]!.to - subqueries[best]!.from) best = index;
    });
    return best >= 0 ? (assigned[best] ?? []) : null;
  }
  const index = subqueries.findIndex((query) => sqlStatementFingerprint(query.sql) === fingerprint);
  return index >= 0 ? (assigned[index] ?? []) : null;
}

export function sameSavedStatementTargets(
  left: readonly SavedSqlStatementTarget[] | undefined,
  right: readonly SavedSqlStatementTarget[] | undefined,
): boolean {
  return serializeSavedStatementTargets(left) === serializeSavedStatementTargets(right);
}

function isBlankChar(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/**
 * 高亮和执行库标记的右端：收到这条语句的分号，分号可以单独占一行。
 * 分号后面的换行和空行不算进范围。
 */
export function statementVisualEnd(text: string, from: number, to: number, limit: number): number {
  const cap = Math.max(from, Math.min(limit, text.length));
  let end = Math.max(from, Math.min(to, cap));
  while (end > from && isBlankChar(text[end - 1])) end -= 1;
  if (end > from && text[end - 1] === ";") return end;
  let scan = end;
  while (scan < cap && isBlankChar(text[scan])) scan += 1;
  if (scan < cap && text[scan] === ";") {
    scan += 1;
    while (scan < cap && (text[scan] === " " || text[scan] === "\t")) scan += 1;
    return scan;
  }
  return end;
}

/** 光标所在顶层语句的序号。分号上、以及下一条语句之前的空行，仍算前一条。 */
export function statementIndexAt(sql: string, offset: number): number {
  const parts = splitSqlStatements(sql);
  if (parts.length === 0) return -1;
  const clamped = Math.max(0, Math.min(offset, sql.length));
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    const nextFrom = i + 1 < parts.length ? parts[i + 1]!.from : sql.length + 1;
    if (clamped >= part.from && clamped < nextFrom) return i;
  }
  return clamped < parts[0]!.from ? 0 : parts.length - 1;
}

function expandUnits(
  statements: readonly { sql: string }[],
  targetsByIndex: readonly SqlExecTarget[][],
): SqlExecUnit[] {
  const units: SqlExecUnit[] = [];
  statements.forEach((statement, index) => {
    const sql = statement.sql.trim();
    if (!sql) return;
    const targets = targetsByIndex[index] ?? [];
    if (targets.length === 0) {
      units.push({ sql, target: null });
      return;
    }
    for (const target of targets) units.push({ sql, target });
  });
  return units;
}

/**
 * 整脚本、单条或选区各自展开成执行单元。
 * statementIndex 只在选中文本和该条语句正文对得上时生效，避免半句 SQL 误用别的库。
 * anchor 落在子查询里、且执行的就是这段子查询时，用子查询自己的库。整条语句仍走语句上的库。
 */
export function resolveSqlExecUnits(
  documentSql: string,
  sqlOverride: string | undefined,
  statementIndex: number | undefined,
  saved: readonly SavedSqlStatementTarget[] | undefined,
  anchor?: number,
): SqlExecUnit[] {
  const parts = splitSqlStatements(documentSql);
  const statements = parts.length > 0 ? parts : documentSql.trim() ? [{ sql: documentSql.trim() }] : [];
  const assigned = assignStatementTargets(statements, saved);
  const override = sqlOverride?.trim();
  if (!override || sqlStatementFingerprint(override) === sqlStatementFingerprint(documentSql)) {
    return expandUnits(statements, assigned);
  }

  const selected = splitSqlStatements(override);
  const pieces = selected.length > 0 ? selected : [{ sql: override }];
  if (pieces.length === 1 && statementIndex != null && statementIndex >= 0) {
    const part = statements[statementIndex];
    if (part && sqlStatementFingerprint(part.sql) === sqlStatementFingerprint(pieces[0]!.sql)) {
      return expandUnits([pieces[0]!], [assigned[statementIndex] ?? []]);
    }
  }

  if (pieces.length === 1 && anchor != null) {
    const subqueryTargets = subqueryTargetsAt(documentSql, pieces[0]!.sql, saved, anchor);
    if (subqueryTargets) return expandUnits([pieces[0]!], [subqueryTargets]);
  }

  const used = new Set<number>();
  let matchedStatement = false;
  const pieceTargets = pieces.map((piece) => {
    const fingerprint = sqlStatementFingerprint(piece.sql);
    const index = statements.findIndex(
      (statement, statementIndexInDoc) =>
        !used.has(statementIndexInDoc) && sqlStatementFingerprint(statement.sql) === fingerprint,
    );
    if (index < 0) return [];
    matchedStatement = true;
    used.add(index);
    return assigned[index] ?? [];
  });
  if (!matchedStatement && pieces.length === 1) {
    const subqueryTargets = subqueryTargetsAt(documentSql, pieces[0]!.sql, saved, undefined);
    if (subqueryTargets) return expandUnits([pieces[0]!], [subqueryTargets]);
  }
  return expandUnits(pieces, pieceTargets);
}
