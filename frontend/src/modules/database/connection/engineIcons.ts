import mongoDark from "../../../assets/icons/mongo-dark.svg";
import mongoLight from "../../../assets/icons/mongo-light.svg";
import mysqlDark from "../../../assets/icons/mysql-dark.svg";
import mysqlLight from "../../../assets/icons/mysql-light.svg";
import postgresql from "../../../assets/icons/postgresql.svg";
import qdrantDark from "../../../assets/icons/qdrant-dark.svg";
import qdrantLight from "../../../assets/icons/qdrant-light.svg";
import redis from "../../../assets/icons/redis.svg";
import sqlite from "../../../assets/icons/sqlite.svg";
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
  sqlserver: null,
};

export function getEngineIcon(
  engine: DbEngine,
  theme: "light" | "dark",
): string | null {
  const key = resolveEngineKey(engine) ?? engine.trim().toLowerCase();
  const entry = ENGINE_ICONS[key];
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
  return engine ? getEngineIcon(engine, theme) : null;
}
