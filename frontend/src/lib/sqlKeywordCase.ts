export type SqlKeywordCase = "upper" | "lower";

export const DEFAULT_SQL_KEYWORD_CASE: SqlKeywordCase = "upper";

export function normalizeSqlKeywordCase(value: unknown): SqlKeywordCase {
  return value === "lower" ? "lower" : "upper";
}
