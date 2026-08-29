export const ACTION_DB_RESTART = "db.service.restart";
export const ACTION_DB_DROP_TABLE = "db.schema.drop_table";
export const ACTION_DB_DROP_DATABASE = "db.schema.drop_database";

export function restartTarget(
  sshId: string,
  service: string,
  kind: string,
  location: string,
): string {
  return `${sshId.trim()}|${service.trim()}|${kind.trim()}|${location.trim()}`;
}

export function dropTableTarget(connectionId: string, database: string, tables: string[]): string {
  const names = [...new Set(tables.map((n) => n.trim()).filter(Boolean))].sort();
  return `${connectionId.trim()}|${database.trim()}|${names.join(",")}`;
}

export function dropDatabaseTarget(connectionId: string, database: string): string {
  return `${connectionId.trim()}|${database.trim()}`;
}

export function dropTableObjectsTarget(
  connectionId: string,
  objects: Array<{ database: string; name: string }>,
): string {
  const dbs = [...new Set(objects.map((o) => o.database.trim()))].sort();
  if (dbs.length <= 1) {
    return dropTableTarget(
      connectionId,
      dbs[0] ?? "",
      objects.map((o) => o.name),
    );
  }
  return dropTableTarget(
    connectionId,
    "*",
    objects.map((o) => `${o.database.trim()}.${o.name.trim()}`),
  );
}
