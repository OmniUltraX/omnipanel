/** 用户/角色管理：引擎判定与 SQL 引号 */

import { canonicalHostEngine, catalogFamily } from "../hostCapabilities";

export type UserEngine = "mysql" | "postgres" | "oracle";

export function resolveUserEngine(dbType: string): UserEngine | null {
  const engine = canonicalHostEngine(dbType);
  if (engine === "mysql") return "mysql";
  if (engine === "postgres") return "postgres";
  const family = catalogFamily(engine);
  if (family === "mysqlLike") return "mysql";
  if (family === "postgresLike") return "postgres";
  if (family === "oracleLike") return "oracle";
  return null;
}

export function connectionSupportsUsers(
  connection: Pick<{ db_type: string }, "db_type"> | string,
): boolean {
  const dbType = typeof connection === "string" ? connection : connection.db_type;
  return resolveUserEngine(dbType) !== null;
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

export function oracleQuoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function oracleQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function formatMysqlUserHost(name: string, host?: string | null): string {
  const h = (host ?? "%").trim() || "%";
  return `${mysqlQuoteLiteral(name)}@${mysqlQuoteLiteral(h)}`;
}

export function userDisplayLabel(name: string, host?: string | null): string {
  return host ? `${name}@${host}` : name;
}
