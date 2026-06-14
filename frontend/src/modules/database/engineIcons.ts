import mysqlDark from "../../assets/icons/mysql-dark.svg";
import mysqlLight from "../../assets/icons/mysql-light.svg";
import redis from "../../assets/icons/redis.svg";

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
 * - postgresql / sqlite / sqlserver / mongodb：暂无 logo，调用方需自行回退
 */
const ENGINE_ICONS: Record<DbEngine, { light: string; dark: string } | null> = {
  mysql: { light: mysqlLight, dark: mysqlDark },
  redis: { light: redis, dark: redis },
  postgresql: null,
  sqlite: null,
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

const ENGINE_KEYS = Object.keys(ENGINE_ICONS) as DbEngine[];

export function getEngineIconByType(
  dbType: string,
  theme: "light" | "dark",
): string | null {
  const engine = ENGINE_KEYS.find((key) => key === dbType);
  return engine ? getEngineIcon(engine, theme) : null;
}
