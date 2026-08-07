/** SQL 执行历史条目的语句类型标签（取首个关键字）。 */
export type SqlHistoryKind =
  | "select"
  | "insert"
  | "update"
  | "delete"
  | "replace"
  | "merge"
  | "truncate"
  | "call"
  | "with"
  | "show"
  | "describe"
  | "explain"
  | "create"
  | "alter"
  | "drop"
  | "rename"
  | "comment"
  /** 旧版分组：仍可读已持久化记录 */
  | "dml"
  | "ddl"
  | "other";

const LEADING_COMMENT = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/;

const KNOWN = new Set<string>([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "MERGE",
  "TRUNCATE",
  "CALL",
  "WITH",
  "SHOW",
  "DESCRIBE",
  "DESC",
  "EXPLAIN",
  "CREATE",
  "ALTER",
  "DROP",
  "RENAME",
  "COMMENT",
]);

/** 将 SQL 归类为具体语句类型（用于执行历史 tag）。 */
export function classifySqlHistoryKind(sql: string): SqlHistoryKind {
  const trimmed = sql.replace(LEADING_COMMENT, "").trimStart();
  const first = trimmed.split(/\s+/, 1)[0]?.toUpperCase() ?? "";
  if (!first || !KNOWN.has(first)) return "other";
  if (first === "DESC") return "describe";
  return first.toLowerCase() as SqlHistoryKind;
}

/** 历史列表上展示的 tag 文案。 */
export function sqlHistoryKindLabel(kind: SqlHistoryKind): string {
  switch (kind) {
    case "describe":
      return "DESCRIBE";
    case "dml":
      return "DML";
    case "ddl":
      return "DDL";
    case "other":
      return "OTHER";
    default:
      return kind.toUpperCase();
  }
}

/** tag 视觉分组：查询 / 写入 / 结构 / 其他。 */
export function sqlHistoryKindTone(
  kind: SqlHistoryKind,
): "select" | "write" | "schema" | "other" {
  switch (kind) {
    case "select":
    case "with":
    case "show":
    case "describe":
    case "explain":
      return "select";
    case "insert":
    case "update":
    case "delete":
    case "replace":
    case "merge":
    case "truncate":
    case "call":
    case "dml":
      return "write";
    case "create":
    case "alter":
    case "drop":
    case "rename":
    case "comment":
    case "ddl":
      return "schema";
    default:
      return "other";
  }
}
