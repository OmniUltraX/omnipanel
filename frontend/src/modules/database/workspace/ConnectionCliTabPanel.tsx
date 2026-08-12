import type { Connection } from "../../../ipc/bindings";
import type { DbConnectionConfig } from "../api";
import type { MysqlDeploymentInfo } from "../mysqlDeploymentDetect";
import type { RedisDeploymentInfo } from "../redisDeploymentDetect";
import type { PostgresDeploymentInfo } from "../postgresDeploymentDetect";
import { ConnectionRedisConsolePanel } from "./ConnectionRedisConsolePanel";
import { ConnectionSqlConsolePanel } from "./ConnectionSqlConsolePanel";

interface ConnectionCliTabPanelProps {
  connection: DbConnectionConfig;
  client: "mysql" | "redis" | "psql";
  deployment?: MysqlDeploymentInfo | RedisDeploymentInfo | PostgresDeploymentInfo | null;
  deploymentLoading?: boolean;
  sshConnections?: Connection[];
  panelActive: boolean;
  visible: boolean;
}

/** MySQL / PostgreSQL / Redis 均走应用内命令行，无需本机安装客户端。 */
export function ConnectionCliTabPanel({
  connection,
  client,
  panelActive,
  visible,
}: ConnectionCliTabPanelProps) {
  if (client === "redis") {
    return (
      <ConnectionRedisConsolePanel
        connection={connection}
        panelActive={panelActive}
        visible={visible}
      />
    );
  }

  return (
    <ConnectionSqlConsolePanel
      connection={connection}
      panelActive={panelActive}
      visible={visible}
    />
  );
}
