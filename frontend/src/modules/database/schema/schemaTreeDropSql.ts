function mysqlQuoteId(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function pgQuoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function normalizeEngine(dbType: string): "mysql" | "postgres" | "sqlite" | "other" {
  const engine = dbType.toLowerCase();
  if (engine === "mysql" || engine === "mariadb") {
    return "mysql";
  }
  if (engine === "postgresql" || engine === "postgres") {
    return "postgres";
  }
  if (engine === "sqlite" || engine === "sqlite3") {
    return "sqlite";
  }
  return "other";
}

function sqliteQuoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function isSchemaDropSqlSupported(dbType: string): boolean {
  return normalizeEngine(dbType) !== "other";
}

export function buildDropColumnSql(
  dbType: string,
  dbName: string,
  tableName: string,
  columnName: string,
): string | null {
  const engine = normalizeEngine(dbType);
  if (engine === "mysql") {
    const tableRef = `${mysqlQuoteId(dbName.trim())}.${mysqlQuoteId(tableName.trim())}`;
    return `ALTER TABLE ${tableRef} DROP COLUMN ${mysqlQuoteId(columnName.trim())}`;
  }
  if (engine === "postgres") {
    const schema = "public";
    const tableRef = `${pgQuoteId(schema)}.${pgQuoteId(tableName.trim())}`;
    return `ALTER TABLE ${tableRef} DROP COLUMN ${pgQuoteId(columnName.trim())}`;
  }
  if (engine === "sqlite") {
    const tableRef = sqliteQuoteId(tableName.trim());
    return `ALTER TABLE ${tableRef} DROP COLUMN ${sqliteQuoteId(columnName.trim())}`;
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
  if (engine === "sqlite") {
    return `DROP INDEX IF EXISTS ${sqliteQuoteId(name)}`;
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
      return engine === "mysql" || engine === "postgres";
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
  if (engine === "sqlite") {
    return `DROP TABLE ${sqliteQuoteId(table)}`;
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
  if (engine === "sqlite") {
    return `DROP VIEW ${sqliteQuoteId(view)}`;
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
  return null;
}
