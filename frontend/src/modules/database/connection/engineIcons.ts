import cassandra from "../../../assets/icons/cassandra.svg";
import clickhouse from "../../../assets/icons/clickhouse.svg";
import dameng from "../../../assets/icons/dameng.svg";
import firebird from "../../../assets/icons/firebird.svg";
import hive from "../../../assets/icons/hive.svg";
import mongoDark from "../../../assets/icons/mongo-dark.svg";
import mongoLight from "../../../assets/icons/mongo-light.svg";
import mysqlDark from "../../../assets/icons/mysql-dark.svg";
import mysqlLight from "../../../assets/icons/mysql-light.svg";
import neo4j from "../../../assets/icons/neo4j.svg";
import oracle from "../../../assets/icons/oracle.svg";
import postgresql from "../../../assets/icons/postgresql.svg";
import qdrantDark from "../../../assets/icons/qdrant-dark.svg";
import qdrantLight from "../../../assets/icons/qdrant-light.svg";
import redis from "../../../assets/icons/redis.svg";
import sqlite from "../../../assets/icons/sqlite.svg";
import sqlserver from "../../../assets/icons/sqlserver.svg";
import { resolveEngineKey } from "../engineRegistry";

/** 引擎 key 为开放字符串；下列为内置图标别名。 */
export type DbEngine = string;

const ENGINE_ICONS: Record<string, { light: string; dark: string } | null> = {
  mysql: { light: mysqlLight, dark: mysqlDark },
  mongodb: { light: mongoLight, dark: mongoDark },
  qdrant: { light: qdrantLight, dark: qdrantDark },
  redis: { light: redis, dark: redis },
  postgresql: { light: postgresql, dark: postgresql },
  sqlite: { light: sqlite, dark: sqlite },
  sqlserver: { light: sqlserver, dark: sqlserver },
  oracle: { light: oracle, dark: oracle },
  neo4j: { light: neo4j, dark: neo4j },
  cassandra: { light: cassandra, dark: cassandra },
  hive: { light: hive, dark: hive },
  dameng: { light: dameng, dark: dameng },
  clickhouse: { light: clickhouse, dark: clickhouse },
  firebird: { light: firebird, dark: firebird },
};

export function getEngineIcon(
  engine: DbEngine,
  theme: "light" | "dark",
): string | null {
  const key = resolveEngineKey(engine) ?? engine.trim().toLowerCase();
  const entry = ENGINE_ICONS[key] ?? ENGINE_ICONS[engine.trim().toLowerCase()];
  return entry ? entry[theme] : null;
}

export function resolveDbEngineType(dbType: string): DbEngine | null {
  return resolveEngineKey(dbType);
}

export function getEngineIconByType(
  dbType: string,
  theme: "light" | "dark",
): string | null {
  const engine = resolveDbEngineType(dbType);
  return engine ? getEngineIcon(engine, theme) : getEngineIcon(dbType, theme);
}
