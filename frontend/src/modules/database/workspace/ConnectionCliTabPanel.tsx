import type { Connection } from "../../../ipc/bindings";
import { useI18n } from "../../../i18n";
import type { DbConnectionConfig } from "../api";
import type { MysqlDeploymentInfo } from "../mysqlDeploymentDetect";
import type { RedisDeploymentInfo } from "../redisDeploymentDetect";
import type { PostgresDeploymentInfo } from "../postgresDeploymentDetect";
import { ConnectionCliTerminalWorkspace } from "./ConnectionCliTerminalWorkspace";
import { ConnectionSqlConsolePanel } from "./ConnectionSqlConsolePanel";
import { useConnectionCliTerminal } from "./useConnectionCliTerminal";

interface ConnectionCliTabPanelProps {
  connection: DbConnectionConfig;
  client: "mysql" | "redis" | "psql";
  deployment: MysqlDeploymentInfo | RedisDeploymentInfo | PostgresDeploymentInfo | null;
  deploymentLoading?: boolean;
  sshConnections: Connection[];
  /** 连接信息面板是否激活；关闭面板时才释放终端会话。 */
  panelActive: boolean;
  /** 命令行子标签是否可见（仅控制展示，不断开连接）。 */
  visible: boolean;
}

/** Redis 仍走系统 redis-cli；MySQL/PostgreSQL 走应用内 mysql>/postgres=# 命令行。 */
function RedisCliShellPanel({
  connection,
  deployment,
  deploymentLoading = false,
  sshConnections,
  panelActive,
  visible,
}: Omit<ConnectionCliTabPanelProps, "client">) {
  const { t } = useI18n();

  const { pane, resource, paneId, terminalModes, reconnectKey, handleSenderChange } =
    useConnectionCliTerminal({
      connection,
      client: "redis",
      deployment,
      deploymentLoading,
      sshConnections,
      panelActive,
      t,
    });

  if (!panelActive) {
    return null;
  }

  if (deploymentLoading && deployment == null) {
    return (
      <div className={`db-connection-cli${visible ? "" : " db-connection-cli--hidden"}`}>
        <div className="db-tables-panel-empty">{t("common.loading")}</div>
      </div>
    );
  }

  if (terminalModes.length === 0) {
    return (
      <div className={`db-connection-cli${visible ? "" : " db-connection-cli--hidden"}`}>
        <div className="db-tables-panel-empty">{t("database.connectionInfo.cli.empty")}</div>
      </div>
    );
  }

  return (
    <div className={`db-connection-cli${visible ? "" : " db-connection-cli--hidden"}`}>
      {connection.password ? (
        <p className="db-connection-cli-warning">{t("database.connectionInfo.cli.passwordWarning")}</p>
      ) : null}

      <ConnectionCliTerminalWorkspace
        pane={pane}
        resource={resource}
        paneId={paneId}
        reconnectKey={reconnectKey}
        terminalActive={visible}
        onSenderChange={handleSenderChange}
      />
    </div>
  );
}

export function ConnectionCliTabPanel({
  connection,
  client,
  deployment,
  deploymentLoading = false,
  sshConnections,
  panelActive,
  visible,
}: ConnectionCliTabPanelProps) {
  if (client === "mysql" || client === "psql") {
    return (
      <ConnectionSqlConsolePanel
        connection={connection}
        panelActive={panelActive}
        visible={visible}
      />
    );
  }

  return (
    <RedisCliShellPanel
      connection={connection}
      deployment={deployment}
      deploymentLoading={deploymentLoading}
      sshConnections={sshConnections}
      panelActive={panelActive}
      visible={visible}
    />
  );
}
