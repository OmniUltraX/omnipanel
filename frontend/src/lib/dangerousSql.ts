export type DangerousSql =
  | { kind: "none" }
  | { kind: "drop_table"; name: string }
  | { kind: "drop_database"; name: string }
  | { kind: "drop_user"; name: string }
  | { kind: "alter_drop"; name: string }
  | { kind: "truncate"; name: string }
  | { kind: "delete_no_where"; name: string }
  | { kind: "flush"; name: string }
  | { kind: "kill"; name: string }
  | { kind: "multiple" };

function stripLeadingComments(stmt: string): string {
  let s = stmt.trimStart();
  while (s.startsWith("--")) {
    const nl = s.indexOf("\n");
    s = nl >= 0 ? s.slice(nl + 1).trimStart() : "";
  }
  return s;
}

function lastIdent(name: string): string {
  const first = name.split(/\s+/)[0]?.replace(/,$/, "") ?? name;
  const part = first.split(".").pop() ?? first;
  return part.replace(/[`"'\[\]\s]/g, "");
}

function skipIfExists(rest: string): string {
  return rest.toUpperCase().startsWith("IF EXISTS") ? rest.slice(9).trimStart() : rest;
}

function classifyOne(stmt: string): DangerousSql | null {
  const trimmed = stripLeadingComments(stmt);
  const upper = trimmed.toUpperCase();
  const take = (prefix: string): string | null => {
    if (!upper.startsWith(prefix)) return null;
    const rest = trimmed.slice(prefix.length);
    if (rest.length > 0 && !/\s/.test(rest[0] ?? "")) return null;
    return rest.trimStart();
  };
  const table = take("DROP TABLE");
  if (table != null) return { kind: "drop_table", name: lastIdent(skipIfExists(table)) };
  const db = take("DROP DATABASE") ?? take("DROP SCHEMA");
  if (db != null) return { kind: "drop_database", name: lastIdent(skipIfExists(db)) };
  const user = take("DROP USER");
  if (user != null) return { kind: "drop_user", name: lastIdent(skipIfExists(user)) };
  const index = take("DROP INDEX");
  if (index != null) return { kind: "alter_drop", name: lastIdent(skipIfExists(index)) };
  const truncateTable = take("TRUNCATE TABLE");
  if (truncateTable != null) return { kind: "truncate", name: lastIdent(truncateTable) };
  const truncate = take("TRUNCATE");
  if (truncate != null) return { kind: "truncate", name: lastIdent(truncate) };
  if (upper.startsWith("FLUSHALL")) return { kind: "flush", name: "FLUSHALL" };
  if (upper.startsWith("FLUSHDB")) return { kind: "flush", name: "FLUSHDB" };
  const del = take("DELETE FROM");
  if (del != null) {
    const name = lastIdent(del);
    const afterName = del.split(/\s+/).slice(1).join(" ");
    if (!afterName.toUpperCase().includes("WHERE")) {
      return { kind: "delete_no_where", name };
    }
  }
  const colIdx = upper.indexOf("DROP COLUMN");
  if (colIdx >= 0) {
    const name = lastIdent(trimmed.slice(colIdx + "DROP COLUMN".length).trimStart());
    if (name) return { kind: "alter_drop", name };
  }
  const kill = take("KILL");
  if (kill != null) return { kind: "kill", name: lastIdent(kill) };
  const pg = upper.indexOf("PG_TERMINATE_BACKEND");
  if (pg >= 0) {
    const digits = trimmed.slice(pg).match(/\d+/);
    if (digits?.[0]) return { kind: "kill", name: digits[0] };
  }
  return null;
}

export function classifySql(sql: string): DangerousSql {
  const found = sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("--"))
    .map(classifyOne)
    .filter((item): item is Exclude<DangerousSql, { kind: "none" } | { kind: "multiple" }> => item != null);
  if (found.length === 0) return { kind: "none" };
  if (found.length > 1) return { kind: "multiple" };
  return found[0]!;
}

export function inferDropTableDatabase(sql: string): string | undefined {
  const stmt = sql.split(";").map((s) => s.trim()).find((s) => s && !s.startsWith("--"));
  if (!stmt) return undefined;
  const trimmed = stripLeadingComments(stmt);
  if (!trimmed.toUpperCase().startsWith("DROP TABLE")) return undefined;
  const rest = skipIfExists(trimmed.slice("DROP TABLE".length).trimStart());
  const first = rest.split(/\s+/)[0] ?? "";
  const parts = first.split(".");
  if (parts.length >= 2) return parts[0].replace(/[`"'\[\]]/g, "");
  return undefined;
}
