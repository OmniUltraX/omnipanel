import { invoke } from "@tauri-apps/api/core";
import type { DbConnectionConfig, DbUserMeta } from "../api";
import { makeQueryRunId } from "../sql/queryRun";
import type { QueryResult } from "../workspace/dbWorkspaceState";
import {
  formatMysqlUserHost,
  pgQuoteId,
  resolveUserEngine,
  type UserEngine,
} from "./userEngine";

export type GrantSummaryLine = {
  id: string;
  /** 行类型，用于着色 */
  kind: "role" | "attributes" | "member" | "database" | "schema" | "table" | "raw" | "other";
  /** 左侧标签，如 Database / Schema / Role */
  label: string;
  /** 主体内容 */
  detail: string;
  /** 撤销用：原始 privilege 列表 */
  revokePrivileges?: string;
  /** 撤销用：ON 后面的 scope */
  revokeScope?: string;
};

async function executeSql(
  connection: DbConnectionConfig,
  sql: string,
): Promise<QueryResult> {
  return invoke<QueryResult>("db_execute_query", {
    connection,
    sql,
    runId: makeQueryRunId(),
  });
}

function cellStr(row: unknown[], index: number): string {
  const v = row[index];
  if (v === null || v === undefined) return "";
  return String(v);
}

/** 解析 MySQL `GRANT ... ON ... TO ...` */
export function parseMysqlGrantString(grant: string): {
  privileges: string;
  scope: string;
} | null {
  const m = grant.match(/^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i);
  if (!m) return null;
  return { privileges: m[1].trim(), scope: m[2].trim() };
}

function mysqlScopeKind(scope: string): GrantSummaryLine["kind"] {
  const s = scope.replace(/`/g, "").trim();
  if (s === "*.*") return "other";
  if (s.endsWith(".*")) return "database";
  if (s.includes(".")) return "table";
  return "other";
}

function mysqlScopeLabel(scope: string): string {
  const kind = mysqlScopeKind(scope);
  if (kind === "database") return "Database";
  if (kind === "table") return "Table";
  if (scope.replace(/`/g, "") === "*.*") return "Global";
  return "Grant";
}

async function loadMysqlGrants(
  connection: DbConnectionConfig,
  user: DbUserMeta,
): Promise<GrantSummaryLine[]> {
  const result = await executeSql(
    connection,
    `SHOW GRANTS FOR ${formatMysqlUserHost(user.name, user.host)}`,
  );
  const lines: GrantSummaryLine[] = [];
  const attrs: string[] = [];
  if (user.isSuperuser) attrs.push("SUPER");
  if (user.canCreateDb) attrs.push("CREATEDB");
  if (user.accountLocked) attrs.push("LOCKED");
  else if (user.canLogin !== false) attrs.push("LOGIN");
  lines.push({
    id: "role",
    kind: "role",
    label: "User",
    detail: user.host ? `${user.name}@${user.host}` : user.name,
  });
  if (attrs.length > 0) {
    lines.push({
      id: "attrs",
      kind: "attributes",
      label: "Attributes",
      detail: attrs.join(", "),
    });
  }

  result.rows.forEach((row, i) => {
    const raw = cellStr(row, 0);
    const parsed = parseMysqlGrantString(raw);
    if (!parsed) {
      lines.push({
        id: `raw-${i}`,
        kind: "raw",
        label: "Grant",
        detail: raw,
      });
      return;
    }
    const kind = mysqlScopeKind(parsed.scope);
    const scopeClean = parsed.scope.replace(/`/g, "");
    lines.push({
      id: `g-${i}`,
      kind,
      label: mysqlScopeLabel(parsed.scope),
      detail: `${scopeClean} — ${parsed.privileges}`,
      revokePrivileges: parsed.privileges,
      revokeScope: parsed.scope,
    });
  });
  return lines;
}

async function loadPgGrants(
  connection: DbConnectionConfig,
  user: DbUserMeta,
): Promise<GrantSummaryLine[]> {
  const role = user.name;
  const lines: GrantSummaryLine[] = [];

  lines.push({
    id: "role",
    kind: "role",
    label: "Role",
    detail: role,
  });

  const attrs: string[] = [];
  if (user.isSuperuser) attrs.push("SUPERUSER");
  if (user.canCreateDb) attrs.push("CREATEDB");
  attrs.push(user.canLogin ? "LOGIN" : "NOLOGIN");
  lines.push({
    id: "attrs",
    kind: "attributes",
    label: "Attributes",
    detail: attrs.join(", "),
  });

  // 成员关系：谁拥有本角色 / 本角色拥有谁
  try {
    const members = await executeSql(
      connection,
      `SELECT r.rolname AS role, m.rolname AS member
       FROM pg_auth_members am
       JOIN pg_roles r ON r.oid = am.roleid
       JOIN pg_roles m ON m.oid = am.member
       WHERE r.rolname = ${pgQuoteLiteralSafe(role)}
          OR m.rolname = ${pgQuoteLiteralSafe(role)}
       ORDER BY 1, 2`,
    );
    for (let i = 0; i < members.rows.length; i++) {
      const r = cellStr(members.rows[i]!, 0);
      const m = cellStr(members.rows[i]!, 1);
      if (r === role) {
        lines.push({
          id: `mem-has-${i}`,
          kind: "member",
          label: "Has member",
          detail: m,
        });
      } else {
        lines.push({
          id: `mem-of-${i}`,
          kind: "member",
          label: "Member of",
          detail: r,
        });
      }
    }
  } catch {
    // 忽略成员查询失败
  }

  // 库级 ACL
  try {
    const dbAcl = await executeSql(
      connection,
      `SELECT d.datname, acl.privilege_type
       FROM pg_database d
       CROSS JOIN LATERAL aclexplode(d.datacl) AS acl(grantor, grantee, privilege_type, is_grantable)
       JOIN pg_roles r ON r.oid = acl.grantee
       WHERE d.datacl IS NOT NULL
         AND r.rolname = ${pgQuoteLiteralSafe(role)}
       ORDER BY d.datname, acl.privilege_type`,
    );
    const byDb = new Map<string, string[]>();
    for (const row of dbAcl.rows) {
      const db = cellStr(row, 0);
      const priv = cellStr(row, 1).toUpperCase();
      if (!db || !priv) continue;
      const list = byDb.get(db) ?? [];
      if (!list.includes(priv)) list.push(priv);
      byDb.set(db, list);
    }
    let i = 0;
    for (const [db, privs] of byDb) {
      lines.push({
        id: `db-${i++}`,
        kind: "database",
        label: "Database",
        detail: `${db} — ${privs.join(", ")}`,
        revokePrivileges: privs.join(", "),
        revokeScope: `DATABASE ${pgQuoteId(db)}`,
      });
    }
  } catch {
    // ACL 查询在部分权限下会失败
  }

  // Schema ACL
  try {
    const schemaAcl = await executeSql(
      connection,
      `SELECT n.nspname, acl.privilege_type
       FROM pg_namespace n
       CROSS JOIN LATERAL aclexplode(n.nspacl) AS acl(grantor, grantee, privilege_type, is_grantable)
       JOIN pg_roles r ON r.oid = acl.grantee
       WHERE n.nspacl IS NOT NULL
         AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
         AND n.nspname <> 'information_schema'
         AND r.rolname = ${pgQuoteLiteralSafe(role)}
       ORDER BY n.nspname, acl.privilege_type`,
    );
    const bySchema = new Map<string, string[]>();
    for (const row of schemaAcl.rows) {
      const schema = cellStr(row, 0);
      const priv = cellStr(row, 1).toUpperCase();
      if (!schema || !priv) continue;
      const list = bySchema.get(schema) ?? [];
      if (!list.includes(priv)) list.push(priv);
      bySchema.set(schema, list);
    }
    let i = 0;
    for (const [schema, privs] of bySchema) {
      lines.push({
        id: `sch-${i++}`,
        kind: "schema",
        label: "Schema",
        detail: `${schema} — ${privs.join(", ")}`,
        revokePrivileges: privs.join(", "),
        revokeScope: `SCHEMA ${pgQuoteId(schema)}`,
      });
    }
  } catch {
    // ignore
  }

  return lines;
}

function pgQuoteLiteralSafe(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function loadGrantSummary(
  connection: DbConnectionConfig,
  user: DbUserMeta,
): Promise<{ engine: UserEngine; lines: GrantSummaryLine[] }> {
  const engine = resolveUserEngine(connection.db_type);
  if (!engine) {
    return { engine: "mysql", lines: [] };
  }
  if (engine === "mysql") {
    return { engine, lines: await loadMysqlGrants(connection, user) };
  }
  return { engine, lines: await loadPgGrants(connection, user) };
}
