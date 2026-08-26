/** Host 按引擎能力关入口，避免 sidecar 点进建库/克隆/删表后发 MySQL SQL。 */

export type HostCapabilities = {
  tableDesign: boolean;
  users: boolean;
  binlog: boolean;
  slowQuery: boolean;
  createDatabase: boolean;
  dropTable: boolean;
  cloneTable: boolean;
  /** 进程列表 / 状态 / CLI；其它 SQL sidecar 只留库列表 */
  connectionInfoExtra: boolean;
};

/** 与后端 `sidecar_catalog::CatalogFamily` 对齐。 */
export type CatalogFamily =
  | "oracleLike"
  | "postgresLike"
  | "mysqlLike"
  | "hiveLike"
  | "genericSql"
  | "nonSql";

const MYSQL = new Set(["mysql", "mariadb"]);
const POSTGRES = new Set(["postgresql", "postgres", "pg"]);
const SQLITE = new Set(["sqlite", "sqlite3"]);
const SQLSERVER = new Set(["sqlserver", "mssql", "sql server"]);
const ORACLE_LIKE = new Set([
  "oracle",
  "orcl",
  "dameng",
  "dm",
  "db2",
  "oceanbase-oracle",
  "gbase8s",
  "oscar",
  "informix",
  "iris",
  "yashandb",
  "xugu",
]);
const POSTGRES_LIKE = new Set([
  "kingbase",
  "kingbasees",
  "vastbase",
  "highgo",
  "uxdb",
  "cockroachdb",
  "gaussdb",
  "opengauss",
]);
const MYSQL_LIKE = new Set(["oceanbase", "goldendb", "gbase8a", "tidb", "mariadb"]);
const HIVE_LIKE = new Set(["hive", "spark", "databricks", "kylin"]);
const NON_SQL = new Set(["neo4j", "cassandra", "mongodb", "mongo", "redis", "qdrant"]);

export function canonicalHostEngine(dbType: string): string {
  const engine = dbType.trim().toLowerCase();
  if (MYSQL.has(engine)) return "mysql";
  if (POSTGRES.has(engine)) return "postgres";
  if (SQLITE.has(engine)) return "sqlite";
  if (SQLSERVER.has(engine)) return "sqlserver";
  if (engine === "orcl") return "oracle";
  if (engine === "dm") return "dameng";
  return engine;
}

export function catalogFamily(dbType: string): CatalogFamily {
  const engine = canonicalHostEngine(dbType);
  if (ORACLE_LIKE.has(engine) || engine === "oracle" || engine === "dameng") {
    return "oracleLike";
  }
  if (POSTGRES.has(engine) || POSTGRES_LIKE.has(engine) || engine === "postgres") {
    return "postgresLike";
  }
  if (MYSQL.has(engine) || MYSQL_LIKE.has(engine) || engine === "mysql") {
    return "mysqlLike";
  }
  if (HIVE_LIKE.has(engine)) return "hiveLike";
  if (NON_SQL.has(engine)) return "nonSql";
  return "genericSql";
}

export function isSqlCatalogFamily(dbType: string): boolean {
  return catalogFamily(dbType) !== "nonSql";
}

function isFirstPartyMysql(engine: string): boolean {
  return engine === "mysql";
}

function isFirstPartyPostgres(engine: string): boolean {
  return engine === "postgres";
}

function isFirstPartySqlite(engine: string): boolean {
  return engine === "sqlite";
}

function isFirstPartySqlserver(engine: string): boolean {
  return engine === "sqlserver";
}

export function hostCapabilities(dbType: string): HostCapabilities {
  const engine = canonicalHostEngine(dbType);
  const family = catalogFamily(engine);
  const mysql = isFirstPartyMysql(engine);
  const postgres = isFirstPartyPostgres(engine);
  const sqlite = isFirstPartySqlite(engine);
  const sqlserver = isFirstPartySqlserver(engine);
  const sql = isSqlCatalogFamily(engine);
  const sidecarUsers =
    family === "oracleLike" || family === "postgresLike" || family === "mysqlLike";

  if (mysql) {
    return {
      tableDesign: true,
      users: true,
      binlog: true,
      slowQuery: true,
      createDatabase: true,
      dropTable: true,
      cloneTable: true,
      connectionInfoExtra: true,
    };
  }
  if (postgres) {
    return {
      tableDesign: true,
      users: true,
      binlog: false,
      slowQuery: false,
      createDatabase: true,
      dropTable: true,
      cloneTable: true,
      connectionInfoExtra: true,
    };
  }
  if (sqlite) {
    return {
      tableDesign: true,
      users: false,
      binlog: false,
      slowQuery: false,
      createDatabase: true,
      dropTable: true,
      cloneTable: true,
      connectionInfoExtra: false,
    };
  }
  if (sqlserver) {
    return {
      tableDesign: true,
      users: false,
      binlog: false,
      slowQuery: false,
      createDatabase: false,
      dropTable: false,
      cloneTable: false,
      connectionInfoExtra: false,
    };
  }

  return {
    tableDesign: sql,
    users: sidecarUsers,
    binlog: false,
    slowQuery: false,
    createDatabase: false,
    dropTable: sql,
    cloneTable: sql,
    connectionInfoExtra: false,
  };
}

export function supportsCreateDatabase(dbType: string): boolean {
  return hostCapabilities(dbType).createDatabase;
}

export function supportsConnectionInfoExtra(dbType: string): boolean {
  return hostCapabilities(dbType).connectionInfoExtra;
}
