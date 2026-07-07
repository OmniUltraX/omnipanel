import { splitSqlStatements } from "./sqlLex";

/** 去掉语句开头的空白与块/行注释，便于识别首关键字。 */
function stripLeadingComments(sql: string): string {
  let rest = sql.trimStart();
  for (;;) {
    if (rest.startsWith("--")) {
      const lineEnd = rest.indexOf("\n");
      rest = lineEnd >= 0 ? rest.slice(lineEnd + 1).trimStart() : "";
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      rest = end >= 0 ? rest.slice(end + 2).trimStart() : "";
      continue;
    }
    break;
  }
  return rest;
}

/**
 * MySQL/MariaDB 连接级语句：无需在 SQL 编辑器中选中数据库即可执行。
 * 含 SHOW VARIABLES、SHOW FULL PROCESSLIST 等 node-sql-parser 无法解析的语句。
 */
export function isConnectionLevelSql(sql: string): boolean {
  const head = stripLeadingComments(sql);
  if (!head) return false;
  return /^(SHOW|FLUSH|SET|KILL|USE|RESET|GRANT|REVOKE|BINLOG|CHANGE\s+MASTER|START\s+SLAVE|STOP\s+SLAVE|PURGE)\b/i.test(
    head,
  );
}

/** 执行前是否必须先选中数据库（多语句时任一语句需要库上下文即返回 true）。 */
export function sqlRequiresDatabaseContext(sql: string): boolean {
  const trimmed = sql.trim();
  if (!trimmed) return false;

  const parts = splitSqlStatements(trimmed);
  const statements = parts.length > 0 ? parts : [{ sql: trimmed, from: 0, to: trimmed.length, hadTrailingSemicolon: false }];

  return statements.some((part) => {
    const statement = part.sql.trim();
    return statement.length > 0 && !isConnectionLevelSql(statement);
  });
}
