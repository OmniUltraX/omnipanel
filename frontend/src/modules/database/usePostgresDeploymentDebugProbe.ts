import { useEffect } from "react";
import type { Connection } from "../../ipc/bindings";
import type { DbConnectionConfig } from "./api";
import {
  DEPLOYMENT_DETECT_DEBUG,
  deployDetectLog,
  summarizeDbConnection,
  summarizeDeploymentInfo,
} from "./deploymentDetectDebug";
import { probePostgresDeployment } from "./postgresDeploymentDetect";

function isPostgresConnection(connection: Pick<DbConnectionConfig, "db_type">): boolean {
  const engine = connection.db_type.toLowerCase();
  return engine === "postgresql" || engine === "postgres";
}

/** 开发调试：PostgreSQL 连接信息面板尚未接入 UI 时，仍输出部署探测日志�?*/
export function usePostgresDeploymentDebugProbe(
  connection: DbConnectionConfig,
  sshConnections: Connection[],
  active: boolean,
): void {
  useEffect(() => {
    if (!DEPLOYMENT_DETECT_DEBUG || !active || !isPostgresConnection(connection)) {
      return;
    }

    deployDetectLog("postgresql", "panel.debugProbe.start", {
      connection: summarizeDbConnection(connection),
    });

    let cancelled = false;
    void probePostgresDeployment(connection, sshConnections).then((info) => {
      if (cancelled) {
        return;
      }
      deployDetectLog("postgresql", "panel.debugProbe.result", summarizeDeploymentInfo(info));
    });

    return () => {
      cancelled = true;
    };
  }, [
    active,
    connection.db_type,
    connection.host,
    connection.id,
    connection.port,
    sshConnections,
  ]);
}
