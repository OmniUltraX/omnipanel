import mysqlDark from "../../../assets/icons/mysql-dark.svg";
import mysqlLight from "../../../assets/icons/mysql-light.svg";
import postgresql from "../../../assets/icons/postgresql.svg";
import redis from "../../../assets/icons/redis.svg";
import sqlite from "../../../assets/icons/sqlite.svg";

export type DbEngine =
  | "postgresql"
  | "mysql"
  | "sqlite"
  | "sqlserver"
  | "redis"
  | "mongodb";

/**
 * 每种数据源在 light / dark 主题下的 logo。
 *
 * - mysql：分别提供 light / dark 两套配色
 * - redis：只有一份 svg，light / dark 主题共用
 * - postgresql：单份 svg，light / dark 共用
 * - sqlserver / mongodb：暂无 logo，调用方需自行回退
 * - sqlite：单份 svg，light / dark 共用
 */
const ENGINE_ICONS: Record<DbEngine, { light: string; dark: string } | null> = {
  mysql: { light: mysqlLight, dark: mysqlDark },
  redis: { light: redis, dark: redis },
  postgresql: { light: postgresql, dark: postgresql },
  sqlite: { light: sqlite, dark: sqlite },
  sqlserver: null,
  mongodb: null,
};

export function getEngineIcon(
  engine: DbEngine,
  theme: "light" | "dark",
): string | null {
  const entry = ENGINE_ICONS[engine];
  return entry ? entry[theme] : null;
}

const ENGINE_ALIASES: Record<string, DbEngine> = {
  mysql: "mysql",
  mariadb: "mysql",
  postgresql: "postgresql",
  postgres: "postgresql",
  pg: "postgresql",
};

export function resolveDbEngineType(dbType: string): DbEngine | null {
  const normalized = dbType.trim().toLowerCase();
  if (normalized in ENGINE_ICONS) {
    return normalized as DbEngine;
  }
  return ENGINE_ALIASES[normalized] ?? null;
}

export function getEngineIconByType(
  dbType: string,
  theme: "light" | "dark",
): string | null {
  const engine = resolveDbEngineType(dbType);
  return engine ? getEngineIcon(engine, theme) : null;
}
