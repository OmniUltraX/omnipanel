/**
 * AI SQL 安全判定：识别只读语句，避免 SELECT / SHOW 等频繁进入审批。
 */

/** 去掉首部空白、单行/块注释，便于识别真实语句关键字。 */
export function stripSqlLeadingTrivia(sql: string): string {
  let s = sql.replace(/^\uFEFF/, "").trim();
  for (;;) {
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      if (nl < 0) return "";
      s = s.slice(nl + 1).trim();
      continue;
    }
    if (s.startsWith("#")) {
      // MySQL 风格行注释
      const nl = s.indexOf("\n");
      if (nl < 0) return "";
      s = s.slice(nl + 1).trim();
      continue;
    }
    if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      if (end < 0) return "";
      s = s.slice(end + 2).trim();
      continue;
    }
    break;
  }
  return s;
}

/** 粗略按分号拆分（忽略字符串内分号的完整解析，足够用于审批启发式）。 */
function splitSqlStatements(sql: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const prev = sql[i - 1];
    if (ch === "'" && !inDouble && !inBacktick && prev !== "\\") {
      inSingle = !inSingle;
      buf += ch;
      continue;
    }
    if (ch === '"' && !inSingle && !inBacktick && prev !== "\\") {
      inDouble = !inDouble;
      buf += ch;
      continue;
    }
    if (ch === "`" && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
      buf += ch;
      continue;
    }
    if (ch === ";" && !inSingle && !inDouble && !inBacktick) {
      if (buf.trim()) parts.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

const WRITE_KEYWORD_RE =
  /\b(insert|update|delete|drop|truncate|alter|create|replace|merge|grant|revoke|call|execute|exec|load|copy|optimize|vacuum|lock|unlock|kill)\b/i;

function isSafeSessionStatement(normalized: string): boolean {
  // USE / SET 常与 SELECT 连用；不把事务控制算作只读，避免悄悄开启事务
  return /^(use|set)\b/.test(normalized);
}

function isReadOnlyStatement(stmt: string): boolean {
  const head = stripSqlLeadingTrivia(stmt).toLowerCase();
  if (!head) return true;
  const normalized = head.replace(/^\(+/, "").trimStart();

  // 会话级切换：常与 SELECT 一起出现，不应触发审批
  if (isSafeSessionStatement(normalized)) return true;

  if (
    normalized.startsWith("select") ||
    normalized.startsWith("show") ||
    normalized.startsWith("describe") ||
    normalized.startsWith("desc") ||
    normalized.startsWith("explain") ||
    normalized.startsWith("pragma") ||
    normalized.startsWith("values")
  ) {
    return true;
  }

  // WITH … SELECT 视为只读；WITH … INSERT/UPDATE 等仍需审批
  if (normalized.startsWith("with")) {
    return !WRITE_KEYWORD_RE.test(normalized);
  }

  return false;
}

/**
 * 判断 SQL 是否为只读（可跳过敏感操作确认）。
 * 支持：首部注释、USE/SET 前缀、多语句中全部为只读。
 */
export function isReadOnlySql(sql: string): boolean {
  const trimmed = sql.trim();
  if (!trimmed) return false;
  const statements = splitSqlStatements(trimmed);
  if (statements.length === 0) return false;
  return statements.every(isReadOnlyStatement);
}

/** 从工具名 + raw_input 判断是否可自动放行 ACP 权限请求。 */
export function isSafeDatabaseToolPermission(
  toolTitle: string,
  rawInput: string,
): boolean {
  const title = toolTitle.toLowerCase();
  if (
    title.includes("get_databases") ||
    title.includes("get_tables") ||
    title.includes("get_table_info") ||
    title.includes("show_processlist") ||
    title.includes("slow_log")
  ) {
    return true;
  }
  if (!title.includes("execute_sql") && !title.includes("run_sql")) {
    return false;
  }
  try {
    const parsed = JSON.parse(rawInput || "{}") as { sql?: unknown };
    return typeof parsed.sql === "string" && isReadOnlySql(parsed.sql);
  } catch {
    return false;
  }
}
