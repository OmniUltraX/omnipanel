/** 将 SQL 归类为 SELECT / DML / DDL / 其他（用于执行历史分组）。 */

export type SqlHistoryKind = "select" | "dml" | "ddl" | "other";

const LEADING_COMMENT = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/;

export function classifySqlHistoryKind(sql: string): SqlHistoryKind {
  const trimmed = sql.replace(LEADING_COMMENT, "").trimStart();
  const first = trimmed.split(/\s+/, 1)[0]?.toUpperCase() ?? "";
  if (!first) return "other";
  if (first === "SELECT" || first === "WITH" || first === "SHOW" || first === "DESCRIBE" || first === "DESC" || first === "EXPLAIN") {
    return "select";
  }
  if (
    first === "INSERT" ||
    first === "UPDATE" ||
    first === "DELETE" ||
    first === "REPLACE" ||
    first === "MERGE" ||
    first === "CALL" ||
    first === "TRUNCATE"
  ) {
    return "dml";
  }
  if (
    first === "CREATE" ||
    first === "ALTER" ||
    first === "DROP" ||
    first === "RENAME" ||
    first === "COMMENT"
  ) {
    return "ddl";
  }
  return "other";
}
