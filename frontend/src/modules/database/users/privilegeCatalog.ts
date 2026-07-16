import type { UserEngine } from "./userEngine";
import type { GrantScopeKind } from "./userSql";

export type PrivilegeChip = {
  id: string;
  label: string;
};

export type ScopeOption = {
  id: GrantScopeKind;
  /** i18n key suffix under database.connectionInfo.users.scope* */
  labelKey: string;
};

const MYSQL_DB_PRIVS: PrivilegeChip[] = [
  { id: "SELECT", label: "SELECT" },
  { id: "INSERT", label: "INSERT" },
  { id: "UPDATE", label: "UPDATE" },
  { id: "DELETE", label: "DELETE" },
  { id: "CREATE", label: "CREATE" },
  { id: "DROP", label: "DROP" },
  { id: "ALTER", label: "ALTER" },
  { id: "INDEX", label: "INDEX" },
  { id: "REFERENCES", label: "REFERENCES" },
  { id: "CREATE TEMPORARY TABLES", label: "TEMPORARY" },
  { id: "EXECUTE", label: "EXECUTE" },
  { id: "SHOW VIEW", label: "SHOW VIEW" },
];

const MYSQL_GLOBAL_PRIVS: PrivilegeChip[] = [
  ...MYSQL_DB_PRIVS,
  { id: "RELOAD", label: "RELOAD" },
  { id: "PROCESS", label: "PROCESS" },
  { id: "REPLICATION CLIENT", label: "REPL CLIENT" },
  { id: "REPLICATION SLAVE", label: "REPL SLAVE" },
  { id: "SHOW DATABASES", label: "SHOW DB" },
  { id: "SUPER", label: "SUPER" },
  { id: "ALL PRIVILEGES", label: "ALL" },
];

const PG_DB_PRIVS: PrivilegeChip[] = [
  { id: "CONNECT", label: "CONNECT" },
  { id: "CREATE", label: "CREATE" },
  { id: "TEMPORARY", label: "TEMPORARY" },
];

const PG_SCHEMA_PRIVS: PrivilegeChip[] = [
  { id: "USAGE", label: "USAGE" },
  { id: "CREATE", label: "CREATE" },
];

const PG_TABLE_PRIVS: PrivilegeChip[] = [
  { id: "SELECT", label: "SELECT" },
  { id: "INSERT", label: "INSERT" },
  { id: "UPDATE", label: "UPDATE" },
  { id: "DELETE", label: "DELETE" },
  { id: "TRUNCATE", label: "TRUNCATE" },
  { id: "REFERENCES", label: "REFERENCES" },
  { id: "TRIGGER", label: "TRIGGER" },
  { id: "ALL PRIVILEGES", label: "ALL" },
];

export function scopeOptionsForEngine(engine: UserEngine): ScopeOption[] {
  if (engine === "mysql") {
    return [
      { id: "global", labelKey: "scopeGlobal" },
      { id: "database", labelKey: "scopeDatabase" },
      { id: "table", labelKey: "scopeTable" },
    ];
  }
  return [
    { id: "database", labelKey: "scopeDatabase" },
    { id: "schema", labelKey: "scopeSchema" },
    { id: "table", labelKey: "scopeTable" },
  ];
}

export function privilegeChipsFor(
  engine: UserEngine,
  scopeKind: GrantScopeKind,
): PrivilegeChip[] {
  if (engine === "mysql") {
    return scopeKind === "global" ? MYSQL_GLOBAL_PRIVS : MYSQL_DB_PRIVS;
  }
  if (scopeKind === "database") return PG_DB_PRIVS;
  if (scopeKind === "schema") return PG_SCHEMA_PRIVS;
  return PG_TABLE_PRIVS;
}

export function defaultScopeKind(engine: UserEngine): GrantScopeKind {
  return engine === "mysql" ? "database" : "database";
}
