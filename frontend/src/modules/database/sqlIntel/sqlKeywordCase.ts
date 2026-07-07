export type SqlKeywordCase = "upper" | "lower";

export const DEFAULT_SQL_KEYWORD_CASE: SqlKeywordCase = "upper";

/** 补全/片段中需统一大小写的 SQL 关键字与常用函数名（长关键字优先匹配）。 */
const SQL_KEYWORD_TOKENS = [
  "INNER JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "CROSS JOIN",
  "FULL JOIN",
  "CREATE TABLE",
  "ALTER TABLE",
  "DROP TABLE",
  "INSERT INTO",
  "DELETE FROM",
  "ORDER BY",
  "GROUP BY",
  "PARTITION BY",
  "SELECT",
  "FROM",
  "WHERE",
  "HAVING",
  "LIMIT",
  "UPDATE",
  "DELETE",
  "INSERT",
  "CREATE",
  "ALTER",
  "DROP",
  "UNION",
  "DISTINCT",
  "VALUES",
  "BETWEEN",
  "EXISTS",
  "INNER",
  "OUTER",
  "CROSS",
  "NATURAL",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COALESCE",
  "NULLIF",
  "CAST",
  "CONCAT",
  "UPPER",
  "LOWER",
  "TRIM",
  "LENGTH",
  "SUBSTRING",
  "EXTRACT",
  "ROW_NUMBER",
  "RANK",
  "DENSE_RANK",
  "STRING_AGG",
  "DATE_FORMAT",
  "TO_CHAR",
  "TO_DATE",
  "DATE_TRUNC",
  "strftime",
  "NOW",
  "CURDATE",
  "CURTIME",
  "ABS",
  "ROUND",
  "AND",
  "OR",
  "NOT",
  "NULL",
  "LIKE",
  "IN",
  "IS",
  "AS",
  "ON",
  "SET",
  "JOIN",
  "BY",
  "ASC",
  "DESC",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "WITH",
  "OVER",
  "INTO",
  "FULL",
  "LEFT",
  "RIGHT",
];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SQL_KEYWORD_PATTERN = new RegExp(
  `\\b(${[...SQL_KEYWORD_TOKENS].sort((a, b) => b.length - a.length).map(escapeRegex).join("|")})\\b`,
  "gi",
);

/** 将 SQL 片段中的关键字统一为大写或小写（保留占位符与标识符）。 */
export function applySqlKeywordCase(sql: string, keywordCase: SqlKeywordCase): string {
  if (keywordCase === "upper") {
    return sql.replace(SQL_KEYWORD_PATTERN, (match) => match.toUpperCase());
  }
  return sql.replace(SQL_KEYWORD_PATTERN, (match) => match.toLowerCase());
}

export function normalizeSqlKeywordCase(value: unknown): SqlKeywordCase {
  return value === "lower" ? "lower" : "upper";
}
