import { catalogFamily, canonicalHostEngine, hostCapabilities } from "../hostCapabilities";

function mysqlQuoteId(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function pgQuoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sqliteQuoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

type DropEngine = "mysql" | "postgres" | "sqlite" | "oracle" | "hive" | "generic" | "other";

function normalizeEngine(dbType: string): DropEngine {
  const engine = canonicalHostEngine(dbType);
  if (engine === "mysql") return "mysql";
  if (engine === "postgres") return "postgres";
  if (engine === "sqlite") return "sqlite";
  const family = catalogFamily(engine);
  if (family === "mysqlLike") return "mysql";
  if (family === "postgresLike") return "postgres";
  if (family === "oracleLike") return "oracle";
  if (family === "hiveLike") return "hive";
  if (family === "genericSql") return "generic";
  return "other";
}

export function isSchemaDropSqlSupported(dbType: string): boolean {
  return hostCapabilities(dbType).dropTable;
}

export function buildDropColumnSql(
  dbType: string,
  dbName: string,
  tableName: string,
  columnName: string,
): string | null {
  const engine = normalizeEngine(dbType);
  const column = columnName.trim();
  if (engine === "mysql") {
    const tableRef = `${mysqlQuoteId(dbName.trim())}.${mysqlQuoteId(tableName.trim())}`;
    return `ALTER TABLE ${tableRef} DROP COLUMN ${mysqlQuoteId(column)}`;
  }
  if (engine === "postgres") {
    const schema = "public";
    const tableRef = `${pgQuoteId(schema)}.${pgQuoteId(tableName.trim())}`;
    return `ALTER TABLE ${tableRef} DROP COLUMN ${pgQuoteId(column)}`;
  }
  if (engine === "sqlite") {
    const tableRef = sqliteQuoteId(tableName.trim());
    return `ALTER TABLE ${tableRef} DROP COLUMN ${sqliteQuoteId(column)}`;
  }
  if (engine === "oracle") {
    return `ALTER TABLE ${pgQuoteId(dbName.trim())}.${pgQuoteId(tableName.trim())} DROP COLUMN ${pgQuoteId(column)}`;
  }
  if (engine === "hive") {
    return `ALTER TABLE ${mysqlQuoteId(dbName.trim())}.${mysqlQuoteId(tableName.trim())} DROP COLUMN ${mysqlQuoteId(column)}`;
  }
  if (engine === "generic") {
    return `ALTER TABLE ${sqliteQuoteId(tableName.trim())} DROP COLUMN ${sqliteQuoteId(column)}`;
  }
  return null;
}

export function buildDropIndexSql(
  dbType: string,
  dbName: string,
  tableName: string,
  indexName: string,
): string | null {
  const engine = normalizeEngine(dbType);
  const name = indexName.trim();
  if (engine === "mysql") {
    const tableRef = `${mysqlQuoteId(dbName.trim())}.${mysqlQuoteId(tableName.trim())}`;
    return `ALTER TABLE ${tableRef} DROP INDEX ${mysqlQuoteId(name)}`;
  }
  if (engine === "postgres") {
    const schema = "public";
    return `DROP INDEX IF EXISTS ${pgQuoteId(schema)}.${pgQuoteId(name)}`;
  }
  if (engine === "sqlite" || engine === "generic") {
    return `DROP INDEX IF EXISTS ${sqliteQuoteId(name)}`;
  }
  if (engine === "oracle") {
    return `DROP INDEX ${pgQuoteId(dbName.trim())}.${pgQuoteId(name)}`;
  }
  if (engine === "hive") {
    return `DROP INDEX ${mysqlQuoteId(name)} ON ${mysqlQuoteId(dbName.trim())}.${mysqlQuoteId(tableName.trim())}`;
  }
  return null;
}

function mysqlQuoteUserPart(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function isSchemaNodeDropSupported(dbType: string, nodeType: string): boolean {
  const engine = normalizeEngine(dbType);
  if (engine === "other") {
    return false;
  }
  switch (nodeType) {
    case "column":
    case "index":
    case "table":
    case "view":
      return true;
    case "database":
      return engine === "mysql" || engine === "postgres";
    case "user":
      return engine === "mysql" || engine === "postgres" || engine === "oracle";
    default:
      return false;
  }
}

export function buildDropDatabaseSql(dbType: string, dbName: string): string | null {
  const engine = normalizeEngine(dbType);
  const name = dbName.trim();
  if (engine === "mysql") {
    return `DROP DATABASE ${mysqlQuoteId(name)}`;
  }
  if (engine === "postgres") {
    return `DROP DATABASE ${pgQuoteId(name)}`;
  }
  return null;
}

export function buildDropTableSql(
  dbType: string,
  dbName: string,
  tableName: string,
): string | null {
  const engine = normalizeEngine(dbType);
  const table = tableName.trim();
  if (engine === "mysql") {
    const tableRef = `${mysqlQuoteId(dbName.trim())}.${mysqlQuoteId(table)}`;
    return `DROP TABLE ${tableRef}`;
  }
  if (engine === "postgres") {
    const schema = "public";
    return `DROP TABLE ${pgQuoteId(schema)}.${pgQuoteId(table)}`;
  }
  if (engine === "sqlite" || engine === "generic") {
    return `DROP TABLE ${sqliteQuoteId(table)}`;
  }
  if (engine === "oracle") {
    return `DROP TABLE ${pgQuoteId(dbName.trim())}.${pgQuoteId(table)}`;
  }
  if (engine === "hive") {
    return `DROP TABLE ${mysqlQuoteId(dbName.trim())}.${mysqlQuoteId(table)}`;
  }
  return null;
}

export function buildDropViewSql(
  dbType: string,
  dbName: string,
  viewName: string,
): string | null {
  const engine = normalizeEngine(dbType);
  const view = viewName.trim();
  if (engine === "mysql") {
    const viewRef = `${mysqlQuoteId(dbName.trim())}.${mysqlQuoteId(view)}`;
    return `DROP VIEW ${viewRef}`;
  }
  if (engine === "postgres") {
    const schema = "public";
    return `DROP VIEW ${pgQuoteId(schema)}.${pgQuoteId(view)}`;
  }
  if (engine === "sqlite" || engine === "generic") {
    return `DROP VIEW ${sqliteQuoteId(view)}`;
  }
  if (engine === "oracle") {
    return `DROP VIEW ${pgQuoteId(dbName.trim())}.${pgQuoteId(view)}`;
  }
  if (engine === "hive") {
    return `DROP VIEW ${mysqlQuoteId(dbName.trim())}.${mysqlQuoteId(view)}`;
  }
  return null;
}

export function buildDropUserSql(
  dbType: string,
  userName: string,
  host?: string | null,
): string | null {
  const engine = normalizeEngine(dbType);
  const name = userName.trim();
  if (!name) {
    return null;
  }
  if (engine === "mysql") {
    const hostPart = mysqlQuoteUserPart((host ?? "%").trim() || "%");
    return `DROP USER IF EXISTS ${mysqlQuoteUserPart(name)}@${hostPart}`;
  }
  if (engine === "postgres") {
    return `DROP ROLE IF EXISTS ${pgQuoteId(name)}`;
  }
  if (engine === "oracle") {
    return `DROP USER ${pgQuoteId(name)}`;
  }
  return null;
}
