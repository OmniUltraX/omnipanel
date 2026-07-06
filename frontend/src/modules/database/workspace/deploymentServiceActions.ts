import { invoke } from "@tauri-apps/api/core";
import { commands } from "../../../ipc/bindings";
import type { TextEditorIO } from "../../../components/textEditor/types";
import type { RemoteConfigDeployment } from "../../../components/textEditor/io/remoteConfigTextIO";
import type { DbConnectionConfig } from "../api";
import { redisConfigGet } from "../api";
import { resolveDockerExecTarget } from "../dockerContainerResolve";
import type { MysqlDeploymentInfo } from "../mysqlDeploymentDetect";
import { ensureSshReady } from "../mysqlSlowQueryLog";
import type { RedisDeploymentInfo } from "../redisDeploymentDetect";
import { makeQueryRunId } from "../sql/queryRun";
import type { QueryResult } from "./dbWorkspaceState";
import { rowsToRecord } from "./dbWorkspaceState";

export type DatabaseServiceKind = "mysql" | "redis";

export type DeploymentServiceInfo = MysqlDeploymentInfo | RedisDeploymentInfo;

export type ServiceLogSource =
  | { mode: "file"; path: string; subtitle: string }
  | { mode: "docker_logs"; containerId: string; subtitle: string };

const LOG_TAIL_LINES = 1000;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function toRemoteDeployment(deployment: DeploymentServiceInfo): RemoteConfigDeployment {
  return {
    sshConnectionId: deployment.sshConnectionId,
    containerId: deployment.containerId,
  };
}

function resolveContainerId(deployment: DeploymentServiceInfo): string | null {
  return resolveDockerExecTarget({
    containerId: deployment.containerId,
    containerName: deployment.containerName,
    locationTag: deployment.locationTag,
  });
}

async function sshExec(sshId: string, command: string): Promise<string> {
  const ok = await ensureSshReady(sshId);
  if (!ok) {
    throw new Error("ssh_not_connected");
  }
  const res = await commands.sshPoolExecCommand(sshId, command);
  if (res.status !== "ok") {
    throw new Error(res.error?.message ?? "ssh_exec_failed");
  }
  return res.data.stdout;
}

async function remoteFileExists(
  sshId: string,
  path: string,
  containerId?: string,
): Promise<boolean> {
  if (containerId) {
    const out = await sshExec(
      sshId,
      `docker exec ${shellQuote(containerId)} sh -c "[ -f ${shellQuote(path)} ] && echo 1 || echo 0" 2>/dev/null`,
    );
    return out.trim() === "1";
  }
  const out = await sshExec(sshId, `[ -f ${shellQuote(path)} ] && echo 1 || echo 0`);
  return out.trim() === "1";
}

async function queryMysqlVariable(connection: DbConnectionConfig, name: string): Promise<string> {
  const queryResult = await invoke<QueryResult>("db_execute_query", {
    connection,
    sql: "SHOW VARIABLES WHERE Variable_name IN ('log_error')",
    runId: makeQueryRunId(),
  });
  const rows = rowsToRecord(queryResult.columns, queryResult.rows);
  const row = rows.find(
    (item) => String(item.Variable_name ?? "").toLowerCase() === name.toLowerCase(),
  );
  return String(row?.Value ?? "").trim();
}

export function canManageDeployedService(
  deployment: DeploymentServiceInfo | null,
): deployment is DeploymentServiceInfo {
  return Boolean(
    deployment &&
      (deployment.kind === "host" || deployment.kind === "docker") &&
      deployment.sshConnectionId,
  );
}

function dockerLogsSource(deployment: DeploymentServiceInfo, containerId: string): ServiceLogSource {
  const label = deployment.containerName || containerId;
  return {
    mode: "docker_logs",
    containerId,
    subtitle: `docker logs · ${label}`,
  };
}

/** 解析 MySQL 错误日志来源（主机文件 / 容器内文件 / docker logs）。 */
export async function resolveMysqlServiceLogSource(
  connection: DbConnectionConfig,
  deployment: MysqlDeploymentInfo,
): Promise<ServiceLogSource> {
  const sshId = deployment.sshConnectionId!;
  const containerId = deployment.kind === "docker" ? resolveContainerId(deployment) : null;

  let logError = "";
  try {
    logError = await queryMysqlVariable(connection, "log_error");
  } catch {
    logError = "";
  }

  if (logError && logError.toLowerCase() !== "stderr") {
    if (await remoteFileExists(sshId, logError, containerId ?? undefined)) {
      return { mode: "file", path: logError, subtitle: logError };
    }
  }

  if (containerId) {
    return dockerLogsSource(deployment, containerId);
  }

  const hostCandidates = [
    "/var/log/mysql/error.log",
    "/var/log/mysqld.log",
    "/var/log/mariadb/mariadb.log",
  ];
  for (const path of hostCandidates) {
    if (await remoteFileExists(sshId, path)) {
      return { mode: "file", path, subtitle: path };
    }
  }

  throw new Error("log_not_found");
}

/** 解析 Redis 日志来源（CONFIG GET logfile / docker logs / journalctl）。 */
export async function resolveRedisServiceLogSource(
  connection: DbConnectionConfig,
  deployment: RedisDeploymentInfo,
): Promise<ServiceLogSource> {
  const sshId = deployment.sshConnectionId!;
  const containerId = deployment.kind === "docker" ? resolveContainerId(deployment) : null;

  let logPath = "";
  try {
    const pairs = await redisConfigGet(connection, "logfile");
    logPath = String(
      pairs.find(([key]) => key.toLowerCase() === "logfile")?.[1] ?? "",
    ).trim();
  } catch {
    logPath = "";
  }

  if (logPath) {
    if (await remoteFileExists(sshId, logPath, containerId ?? undefined)) {
      return { mode: "file", path: logPath, subtitle: logPath };
    }
  }

  if (containerId) {
    return dockerLogsSource(deployment, containerId);
  }

  for (const unit of ["redis", "redis-server"]) {
    try {
      const out = await sshExec(
        sshId,
        `journalctl -u ${shellQuote(unit)} -n 1 --no-pager 2>/dev/null | wc -l`,
      );
      if (Number(out.trim()) > 0) {
        return {
          mode: "file",
          path: `journalctl:${unit}`,
          subtitle: `journalctl -u ${unit}`,
        };
      }
    } catch {
      // try next unit
    }
  }

  throw new Error("log_not_found");
}

export function createServiceLogTextIO(
  source: ServiceLogSource,
  deployment: RemoteConfigDeployment,
): TextEditorIO {
  if (source.mode === "docker_logs") {
    const sshId = deployment.sshConnectionId!;
    const containerId = source.containerId;
    return {
      readText: async () =>
        sshExec(
          sshId,
          `docker logs --tail ${LOG_TAIL_LINES} ${shellQuote(containerId)} 2>&1`,
        ),
      writeText: async () => {
        throw new Error("readonly");
      },
    };
  }

  if (source.path.startsWith("journalctl:")) {
    const unit = source.path.slice("journalctl:".length);
    const sshId = deployment.sshConnectionId!;
    return {
      readText: async () =>
        sshExec(
          sshId,
          `journalctl -u ${shellQuote(unit)} -n ${LOG_TAIL_LINES} --no-pager 2>/dev/null`,
        ),
      writeText: async () => {
        throw new Error("readonly");
      },
    };
  }

  const sshId = deployment.sshConnectionId;
  const containerId = deployment.containerId;
  const path = source.path;

  return {
    readText: async () => {
      if (!sshId) {
        throw new Error("no_ssh");
      }
      if (containerId) {
        return sshExec(
          sshId,
          `docker exec ${shellQuote(containerId)} sh -c "tail -n ${LOG_TAIL_LINES} ${shellQuote(path)} 2>/dev/null"`,
        );
      }
      return sshExec(sshId, `tail -n ${LOG_TAIL_LINES} ${shellQuote(path)} 2>/dev/null`);
    },
    writeText: async () => {
      throw new Error("readonly");
    },
  };
}

function buildDockerRestartCommand(containerId: string): string {
  return `docker restart ${shellQuote(containerId)}`;
}

function buildHostMysqlRestartCommand(): string {
  return [
    "if command -v systemctl >/dev/null 2>&1; then",
    "for u in mysql mysqld mariadb; do",
    'if systemctl is-active --quiet "$u" 2>/dev/null; then systemctl restart "$u" && exit 0; fi;',
    "done;",
    "fi;",
    "if command -v service >/dev/null 2>&1; then",
    'for u in mysql mysqld mariadb; do service "$u" restart 2>/dev/null && exit 0; done;',
    "fi;",
    "exit 1",
  ].join(" ");
}

function buildHostRedisRestartCommand(): string {
  return [
    "if command -v systemctl >/dev/null 2>&1; then",
    "for u in redis redis-server; do",
    'if systemctl is-active --quiet "$u" 2>/dev/null; then systemctl restart "$u" && exit 0; fi;',
    "done;",
    "fi;",
    "if command -v service >/dev/null 2>&1; then",
    'for u in redis redis-server; do service "$u" restart 2>/dev/null && exit 0; done;',
    "fi;",
    "exit 1",
  ].join(" ");
}

/** 按部署方式重启 MySQL / Redis 服务。 */
export async function restartDeployedService(
  service: DatabaseServiceKind,
  deployment: DeploymentServiceInfo,
): Promise<void> {
  const sshId = deployment.sshConnectionId;
  if (!sshId) {
    throw new Error("no_ssh");
  }

  let command: string;
  if (deployment.kind === "docker") {
    const containerId = resolveContainerId(deployment);
    if (!containerId) {
      throw new Error("no_container");
    }
    command = buildDockerRestartCommand(containerId);
  } else if (deployment.kind === "host") {
    command =
      service === "mysql" ? buildHostMysqlRestartCommand() : buildHostRedisRestartCommand();
  } else {
    throw new Error("unsupported_deployment");
  }

  await sshExec(sshId, command);
}

export function describeRestartTarget(deployment: DeploymentServiceInfo): string {
  if (deployment.kind === "docker") {
    return deployment.containerName || deployment.containerId || deployment.locationTag || "Docker";
  }
  return deployment.serverName || deployment.locationTag || "host";
}
