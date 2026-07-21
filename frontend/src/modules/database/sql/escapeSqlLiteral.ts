/**
 * 将单元格脏值转成 SQL 字面量（MySQL / MariaDB / SQLite 风格单引号字符串）。
 *
 * JSON 列编辑器会把合法 JSON `parse` 成 object；若直接 `String(obj)` 会变成
 * `[object Object]`，写入 JSON 列时触发 MySQL 3140 Invalid JSON。
 */
export function escapeSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "object") {
    return quoteSqlString(JSON.stringify(value));
  }
  return quoteSqlString(String(value));
}

function quoteSqlString(raw: string): string {
  // MySQL 默认启用反斜杠转义：先加倍 \\，再转义 '
  return `'${raw.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
