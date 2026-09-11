/**
 * 将单元格脏值转成 SQL 字面量（MySQL / MariaDB / SQLite 风格单引号字符串）。
 *
 * JSON 列编辑器会把合法 JSON `parse` 成 object；若直接 `String(obj)` 会变成
 * `[object Object]`，写入 JSON 列时触发 MySQL 3140 Invalid JSON。
 *
 * BIT / BOOLEAN 列必须写数字或布尔字面量：MySQL 给 BIT 列赋字符串会按字节串
 * 处理，`'1'` 是 1 字节 = 8 bit，超过 `BIT(1)` 的 1 bit → 1406 Data too long。
 * 所以这两类列需要传入列声明类型走特殊分支。PG 系用 TRUE/FALSE 与 B'..'。
 */
export function escapeSqlLiteral(
  value: unknown,
  opts?: { dbType?: string; columnType?: string | null },
): string {
  if (value === null || value === undefined) return "NULL";

  const dbType = opts?.dbType;
  const kind = resolveColumnKind(opts?.columnType);

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NULL";
    if (kind === "bit" && isPostgresEngine(dbType)) {
      return bitLiteralForPg(value);
    }
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean") {
    if (isPostgresEngine(dbType)) return value ? "TRUE" : "FALSE";
    return value ? "1" : "0";
  }
  if (typeof value === "object") {
    return quoteSqlString(JSON.stringify(value));
  }

  const text = String(value);
  if (kind === "bit") {
    const literal = parseBitLiteral(text, dbType);
    if (literal !== null) return literal;
  }
  if (kind === "boolean") {
    return parseBooleanLiteral(text, dbType);
  }
  return quoteSqlString(text);
}

type SqlColumnKind = "bit" | "boolean" | "other";

/** 目标引擎是否为 PostgreSQL 系（boolean/bit 字面量写法不同）。 */
function isPostgresEngine(dbType?: string): boolean {
  const t = (dbType ?? "").toLowerCase();
  return t.includes("postgres") || t === "pg";
}

/** 按列声明类型归类：只有 BIT / BOOL 需要特殊字面量，其余保持加引号字符串。 */
function resolveColumnKind(columnType?: string | null): SqlColumnKind {
  if (!columnType) return "other";
  const t = columnType.toLowerCase().replace(/\(.*\)/, "").trim();
  if (t === "bit") return "bit";
  if (t === "bool" || t === "boolean") return "boolean";
  return "other";
}

/** BIT 值转字面量：MySQL 直接写数字，PG 写 B'..'；无法解析时返回 null 走兜底。 */
function parseBitLiteral(text: string, dbType?: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const lower = trimmed.toLowerCase();
  let bits: number;
  if (lower === "true") {
    bits = 1;
  } else if (lower === "false") {
    bits = 0;
  } else {
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) return null;
    bits = Math.trunc(n);
  }
  return isPostgresEngine(dbType) ? `B'${bits.toString(2)}'` : String(bits);
}

function bitLiteralForPg(value: number): string {
  return `B'${Math.max(0, Math.trunc(value)).toString(2)}'`;
}

/** BOOLEAN 值转字面量：PG 用 TRUE/FALSE，其余按 1/0（兼容 tinyint/bit 风格存储）。 */
function parseBooleanLiteral(text: string, dbType?: string): string {
  const lower = text.trim().toLowerCase();
  const truthy = lower === "true" || lower === "1";
  if (isPostgresEngine(dbType)) return truthy ? "TRUE" : "FALSE";
  return truthy ? "1" : "0";
}

function quoteSqlString(raw: string): string {
  // MySQL：加倍反斜杠；单引号用 SQL 标准 ''（兼容 NO_BACKSLASH_ESCAPES，且与后端语句拆分一致）
  return `'${raw.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}
