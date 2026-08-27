import type { SmallComponentIcon } from "./types";
import { useSettingsStore } from "../../../stores/settingsStore";
import dockerIcon from "../../../assets/icons/docker.svg";
import javaIcon from "../../../assets/icons/java.svg";
import mysqlDark from "../../../assets/icons/mysql-dark.svg";
import mysqlLight from "../../../assets/icons/mysql-light.svg";
import redisIcon from "../../../assets/icons/redis.svg";
import serverIcon from "../../../assets/icons/server.svg";

function AssetIcon({
  src,
  size = 18,
  className,
}: {
  src: string;
  size?: number;
  className?: string;
}) {
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={className}
      aria-hidden
      draggable={false}
    />
  );
}

function makeAssetIcon(src: string): SmallComponentIcon {
  function WidgetAssetIcon({
    size = 18,
    className,
  }: {
    size?: number;
    className?: string;
  }) {
    return <AssetIcon src={src} size={size} className={className} />;
  }
  return WidgetAssetIcon;
}

/** 服务器资源监控 */
export const ServerResourceMonitorIcon = makeAssetIcon(serverIcon);

/** Docker 容器 / Compose 监控 */
export const DockerMonitorIcon = makeAssetIcon(dockerIcon);

/** Redis 概览 */
export const RedisOverviewIcon = makeAssetIcon(redisIcon);

/** 宝塔 Java 网站监控 */
export const BtJavaWebsiteMonitorIcon = makeAssetIcon(javaIcon);

/** Spring Boot Admin JVM 监控 */
export const SpringBootAdminIcon = makeAssetIcon(javaIcon);

/** MySQL：随主题切换 light / dark logo */
export const MysqlOverviewIcon: SmallComponentIcon = function MysqlOverviewIcon({
  size = 18,
  className,
}) {
  const theme = useSettingsStore((s) => s.resolved);
  const src = theme === "light" ? mysqlLight : mysqlDark;
  return <AssetIcon src={src} size={size} className={className} />;
};
