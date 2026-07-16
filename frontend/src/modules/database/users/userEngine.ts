/** 用户/角色管理：引擎判定与 SQL 引号 */

export type UserEngine = "mysql" | "postgres";

export function resolveUserEngine(dbType: string): UserEngine | null {
  const t = dbType.toLowerCase();
  if (t === "mysql" || t === "mariadb") return "mysql";
  if (t === "postgresql" || t === "postgres") return "postgres";
  return null;
}

export function mysqlQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function mysqlQuoteId(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

export function pgQuoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function pgQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function formatMysqlUserHost(name: string, host?: string | null): string {
  const h = (host ?? "%").trim() || "%";
  return `${mysqlQuoteLiteral(name)}@${mysqlQuoteLiteral(h)}`;
}

export function userDisplayLabel(name: string, host?: string | null): string {
  return host ? `${name}@${host}` : name;
}
