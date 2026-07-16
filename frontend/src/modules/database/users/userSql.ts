import { buildDropUserSql } from "../schema/schemaTreeDropSql";
import {
  formatMysqlUserHost,
  mysqlQuoteId,
  mysqlQuoteLiteral,
  pgQuoteId,
  pgQuoteLiteral,
  resolveUserEngine,
  type UserEngine,
} from "./userEngine";

export function buildCreateUserSql(
  dbType: string,
  name: string,
  password: string,
  host?: string,
): string | null {
  const engine = resolveUserEngine(dbType);
  const n = name.trim();
  if (!engine || !n) return null;
  if (engine === "mysql") {
    return `CREATE USER ${formatMysqlUserHost(n, host)} IDENTIFIED BY ${mysqlQuoteLiteral(password)}`;
  }
  return `CREATE ROLE ${pgQuoteId(n)} WITH LOGIN PASSWORD ${pgQuoteLiteral(password)}`;
}

export function buildChangePasswordSql(
  dbType: string,
  name: string,
  password: string,
  host?: string | null,
): string | null {
  const engine = resolveUserEngine(dbType);
  const n = name.trim();
  if (!engine || !n) return null;
  if (engine === "mysql") {
    return `ALTER USER ${formatMysqlUserHost(n, host)} IDENTIFIED BY ${mysqlQuoteLiteral(password)}`;
  }
  return `ALTER ROLE ${pgQuoteId(n)} PASSWORD ${pgQuoteLiteral(password)}`;
}

export function buildSetLoginEnabledSql(
  dbType: string,
  name: string,
  enabled: boolean,
  host?: string | null,
): string | null {
  const engine = resolveUserEngine(dbType);
  const n = name.trim();
  if (!engine || !n) return null;
  if (engine === "mysql") {
    const lock = enabled ? "ACCOUNT UNLOCK" : "ACCOUNT LOCK";
    return `ALTER USER ${formatMysqlUserHost(n, host)} ${lock}`;
  }
  return `ALTER ROLE ${pgQuoteId(n)} ${enabled ? "LOGIN" : "NOLOGIN"}`;
}

export function buildDropUserSqlForEngine(
  dbType: string,
  name: string,
  host?: string | null,
): string | null {
  return buildDropUserSql(dbType, name, host);
}

export type GrantScopeKind = "global" | "database" | "schema" | "table";

export function buildGrantSql(
  engine: UserEngine,
  opts: {
    name: string;
    host?: string | null;
    privileges: string[];
    scopeKind: GrantScopeKind;
    database?: string;
    schema?: string;
    table?: string;
    withGrantOption?: boolean;
  },
): string | null {
  const privs = opts.privileges.filter(Boolean);
  if (privs.length === 0) return null;
  const privList = privs.join(", ");
  const grantOpt = opts.withGrantOption ? " WITH GRANT OPTION" : "";

  if (engine === "mysql") {
    const target = formatMysqlUserHost(opts.name, opts.host);
    const scope = mysqlScopeSql(opts.scopeKind, opts.database, opts.table);
    if (!scope) return null;
    return `GRANT ${privList} ON ${scope} TO ${target}${grantOpt}`;
  }

  const role = pgQuoteId(opts.name);
  if (opts.scopeKind === "database") {
    const db = opts.database?.trim();
    if (!db) return null;
    return `GRANT ${privList} ON DATABASE ${pgQuoteId(db)} TO ${role}${grantOpt}`;
  }
  if (opts.scopeKind === "schema") {
    const schema = opts.schema?.trim() || "public";
    return `GRANT ${privList} ON SCHEMA ${pgQuoteId(schema)} TO ${role}${grantOpt}`;
  }
  if (opts.scopeKind === "table") {
    const schema = opts.schema?.trim() || "public";
    const table = opts.table?.trim();
    if (!table) return null;
    return `GRANT ${privList} ON TABLE ${pgQuoteId(schema)}.${pgQuoteId(table)} TO ${role}${grantOpt}`;
  }
  // global → DATABASE 需显式库名；无库时不允许
  return null;
}

export function buildRevokeSql(
  engine: UserEngine,
  opts: {
    name: string;
    host?: string | null;
    privileges: string;
    scopeSql: string;
  },
): string | null {
  const privs = opts.privileges.trim();
  const scope = opts.scopeSql.trim();
  if (!privs || !scope) return null;
  if (engine === "mysql") {
    return `REVOKE ${privs} ON ${scope} FROM ${formatMysqlUserHost(opts.name, opts.host)}`;
  }
  return `REVOKE ${privs} ON ${scope} FROM ${pgQuoteId(opts.name)}`;
}

function mysqlScopeSql(
  kind: GrantScopeKind,
  database?: string,
  table?: string,
): string | null {
  if (kind === "global") return "*.*";
  const db = database?.trim();
  if (!db) return null;
  if (kind === "database") return `${mysqlQuoteId(db)}.*`;
  const tbl = table?.trim();
  if (!tbl) return null;
  return `${mysqlQuoteId(db)}.${mysqlQuoteId(tbl)}`;
}
