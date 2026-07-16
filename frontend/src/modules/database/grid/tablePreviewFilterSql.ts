import type { RuleGroupType, RuleType } from "react-querybuilder";
import type { DbColumnMeta } from "../api";
import type { SortState } from "../workspace/dbWorkspaceState";
import { formatFilterWhere, ensureTableFilterQuery, isTableFilterActive } from "./tablePreviewFilter";

/** 展示用 WHERE 子句（不含 WHERE 关键字） */
export function buildWhereClauseText(
  filter: RuleGroupType | null | undefined,
  dbType: string,
  columnMeta?: DbColumnMeta[],
): string {
  return formatFilterWhere(filter, dbType, columnMeta) ?? "";
}

/** 展示用 ORDER BY 子句（不含 ORDER BY 关键字；单列） */
export function buildOrderByClauseText(sort: SortState | null | undefined): string {
  if (!sort?.column) return "";
  return `${sort.column} ${sort.direction.toUpperCase()}`;
}

function unquoteIdent(raw: string): string {
  const s = raw.trim();
  if (
    (s.startsWith("`") && s.endsWith("`")) ||
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("[") && s.endsWith("]"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function parseLiteral(raw: string): unknown {
  const s = raw.trim();
  if (/^null$/i.test(s)) return null;
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  ) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  return s;
}

const COMPARISON_OPS = ["<>", "!=", "<=", ">=", "=", "<", ">"] as const;

type ParseWhereResult =
  | { ok: true; filter: RuleGroupType | null }
  | { ok: false; error: string };

type ParseOrderResult =
  | { ok: true; sort: SortState | null }
  | { ok: false; error: string };

function splitTopLevelAndOr(input: string): { combinator: "and" | "or"; parts: string[] } | null {
  const upper = input.toUpperCase();
  const trySplit = (kw: " AND " | " OR "): string[] | null => {
    const parts: string[] = [];
    let depth = 0;
    let inStr: "'" | '"' | null = null;
    let start = 0;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (inStr) {
        if (ch === inStr && input[i - 1] !== "\\") inStr = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        inStr = ch;
        continue;
      }
      if (ch === "(") {
        depth++;
        continue;
      }
      if (ch === ")") {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth === 0 && upper.slice(i, i + kw.length) === kw) {
        parts.push(input.slice(start, i).trim());
        start = i + kw.length;
        i += kw.length - 1;
      }
    }
    parts.push(input.slice(start).trim());
    return parts.length > 1 ? parts : null;
  };
  const andParts = trySplit(" AND ");
  if (andParts) return { combinator: "and", parts: andParts };
  const orParts = trySplit(" OR ");
  if (orParts) return { combinator: "or", parts: orParts };
  return null;
}

function parseAtomicWhere(expr: string, knownColumns: Set<string> | null): RuleType | null {
  const trimmed = expr.trim().replace(/^\(|\)$/g, "").trim();
  if (!trimmed) return null;

  const isNullMatch = trimmed.match(/^(.+?)\s+IS\s+(NOT\s+)?NULL$/i);
  if (isNullMatch) {
    const field = unquoteIdent(isNullMatch[1]);
    if (knownColumns && !knownColumns.has(field)) return null;
    return {
      field,
      operator: isNullMatch[2] ? "notNull" : "null",
      value: null,
    };
  }

  const inMatch = trimmed.match(/^(.+?)\s+(NOT\s+)?IN\s*\((.+)\)$/i);
  if (inMatch) {
    const field = unquoteIdent(inMatch[1]);
    if (knownColumns && !knownColumns.has(field)) return null;
    const values = inMatch[3]
      .split(",")
      .map((v) => parseLiteral(v.trim()))
      .filter((v) => v !== "");
    return {
      field,
      operator: inMatch[2] ? "notIn" : "in",
      value: values,
    };
  }

  const likeMatch = trimmed.match(/^(.+?)\s+(NOT\s+)?LIKE\s+(.+)$/i);
  if (likeMatch) {
    const field = unquoteIdent(likeMatch[1]);
    if (knownColumns && !knownColumns.has(field)) return null;
    return {
      field,
      operator: likeMatch[2] ? "notLike" : "like",
      value: String(parseLiteral(likeMatch[3])),
    };
  }

  for (const op of COMPARISON_OPS) {
    const idx = findOperatorIndex(trimmed, op);
    if (idx < 0) continue;
    const field = unquoteIdent(trimmed.slice(0, idx));
    const valueRaw = trimmed.slice(idx + op.length).trim();
    if (!field || !valueRaw) continue;
    if (knownColumns && !knownColumns.has(field)) continue;
    const rqbOp =
      op === "<>" || op === "!="
        ? "!="
        : op;
    return {
      field,
      operator: rqbOp,
      value: parseLiteral(valueRaw),
    };
  }

  return null;
}

function findOperatorIndex(expr: string, op: string): number {
  let inStr: "'" | '"' | null = null;
  for (let i = 0; i <= expr.length - op.length; i++) {
    const ch = expr[i];
    if (inStr) {
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inStr = ch;
      continue;
    }
    if (expr.slice(i, i + op.length) === op) {
      // 避免把 <= 当成 <
      if (op === "<" || op === ">") {
        const next = expr[i + 1];
        if (next === "=" || next === op) continue;
      }
      if (op === "=" && (expr[i - 1] === "!" || expr[i - 1] === "<" || expr[i - 1] === ">")) {
        continue;
      }
      return i;
    }
  }
  return -1;
}

/** 受限 WHERE 解析 → RuleGroupType；空串表示清除过滤 */
export function parseWhereClauseText(
  text: string,
  columnMeta?: DbColumnMeta[],
): ParseWhereResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: true, filter: null };
  }
  const known = columnMeta?.length
    ? new Set(columnMeta.map((c) => c.name))
    : null;

  const split = splitTopLevelAndOr(trimmed);
  const parts = split?.parts ?? [trimmed];
  const combinator = split?.combinator ?? "and";
  const rules: RuleType[] = [];
  for (const part of parts) {
    const rule = parseAtomicWhere(part, known);
    if (!rule) {
      return {
        ok: false,
        error: `无法解析条件: ${part}`,
      };
    }
    rules.push(rule);
  }
  if (rules.length === 0) {
    return { ok: true, filter: null };
  }
  return {
    ok: true,
    filter: ensureTableFilterQuery({ combinator, rules }),
  };
}

/** 受限 ORDER BY 解析（仅首列）；空串表示清除排序 */
export function parseOrderByClauseText(text: string): ParseOrderResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: true, sort: null };
  }
  const match = trimmed.match(
    /^([`"]?[\w.\u4e00-\u9fff]+[`"]?|\[[^\]]+\])(?:\s+(ASC|DESC))?$/i,
  );
  if (!match) {
    // 多列时只取第一段
    const first = trimmed.split(",")[0]?.trim() ?? "";
    const again = first.match(
      /^([`"]?[\w.\u4e00-\u9fff]+[`"]?|\[[^\]]+\])(?:\s+(ASC|DESC))?$/i,
    );
    if (!again) {
      return { ok: false, error: `无法解析排序: ${trimmed}` };
    }
    const column = unquoteIdent(again[1]);
    const direction = (again[2]?.toLowerCase() === "desc" ? "desc" : "asc") as
      | "asc"
      | "desc";
    return { ok: true, sort: { column, direction } };
  }
  const column = unquoteIdent(match[1]);
  const direction = (match[2]?.toLowerCase() === "desc" ? "desc" : "asc") as
    | "asc"
    | "desc";
  if (!column) {
    return { ok: false, error: `无法解析排序: ${trimmed}` };
  }
  return { ok: true, sort: { column, direction } };
}

export function isFilterTextDirty(
  draft: string,
  filter: RuleGroupType | null | undefined,
  dbType: string,
  columnMeta?: DbColumnMeta[],
): boolean {
  const canonical = buildWhereClauseText(filter, dbType, columnMeta);
  return draft.trim() !== canonical.trim();
}

export { isTableFilterActive };
