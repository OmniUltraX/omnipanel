import { invoke } from "@tauri-apps/api/core";
import { commands } from "../../ipc/bindings";
import type { Connection } from "../../ipc/bindings";
import type { DbConnectionConfig } from "./api";
import {
  deployDetectLog,
  deployDetectWarn,
  summarizeDbConnection,
  summarizeDeploymentInfo,
  summarizeSshExecResult,
} from "./deploymentDetectDebug";
import {
  buildFindDockerContainerByPortCommand,
  buildFindDockerContainerByPortFallbackCommand,
  parseDockerPsFormatLine,
  parseDockerPsPortsFallbackLine,
  type DockerContainerRef,
} from "./dockerContainerResolve";
import {
  ensureSshReady,
  findSshConnectionForDbHost,
  findSshConnectionForDbHostSync,
} from "./mysqlSlowQueryLog";
import { makeQueryRunId } from "./sql/queryRun";
import type { QueryResult } from "./workspace/dbWorkspaceState";
import { rowsToRecord } from "./workspace/dbWorkspaceState";

export type PostgresDeploymentKind = "host" | "docker" | "unknown";

export type PostgresDeploymentReason =
  | "no_ssh"
  | "ssh_not_connected"
  | "no_pid_file"
  | "no_container"
  | "pid_not_in_container"
  | "probe_failed";

export interface PostgresDeploymentInfo {
  kind: PostgresDeploymentKind;
  locationTag?: string;
  pidFile?: string;
  dataDirectory?: string;
  configFile?: string;
  containerId?: string;
  containerName?: string;
  sshConnectionId?: string;
  serverName?: string;
  reason?: PostgresDeploymentReason;
}

interface PostgresDeployVariables {
  dataDirectory: string;
  externalPidFile: string;
  configFile: string;
}

const SERVICE = "postgresql" as const;

function isPostgresConnection(connection: Pick<DbConnectionConfig, "db_type">): boolean {
  const engine = connection.db_type.toLowerCase();
  return engine === "postgresql" || engine === "postgres";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function sshExec(
  sshConnectionId: string,
  command: string,
): Promise<{ stdout: string; stderr: string }> {
  deployDetectLog(SERVICE, "ssh.exec.start", { sshConnectionId, command });
  const res = await commands.sshPoolExecCommand(sshConnectionId, command);
  if (res.status !== "ok") {
    deployDetectWarn(SERVICE, "ssh.exec.fail", {
      sshConnectionId,
      command,
      error: res.error.message,
    });
    throw new Error(res.error.message);
  }
  const payload = { stdout: res.data.stdout, stderr: res.data.stderr };
  deployDetectLog(SERVICE, "ssh.exec.ok", {
    sshConnectionId,
    command,
    ...summarizeSshExecResult(payload),
  });
  return payload;
}

async function queryPostgresDeployVariables(
  connection: DbConnectionConfig,
): Promise<PostgresDeployVariables> {
  const sql =
    "SELECT name, setting FROM pg_settings WHERE name IN ('data_directory', 'external_pid_file', 'config_file')";
  deployDetectLog(SERVICE, "query.settings.start", { sql });
  const queryResult = await invoke<QueryResult>("db_execute_query", {
    connection,
    sql,
    runId: makeQueryRunId(),
  });
  const rows = rowsToRecord(queryResult.columns, queryResult.rows);
  const read = (name: string) =>
    String(rows.find((row) => row.name === name)?.setting ?? "").trim();
  const variables = {
    dataDirectory: read("data_directory"),
    externalPidFile: read("external_pid_file"),
    configFile: read("config_file"),
  };
  deployDetectLog(SERVICE, "query.settings.ok", variables);
  return variables;
}

function resolvePidFile(variables: PostgresDeployVariables): string {
  if (variables.externalPidFile) {
    return variables.externalPidFile;
  }
  if (variables.dataDirectory) {
    return `${variables.dataDirectory.replace(/\/+$/, "")}/postmaster.pid`;
  }
  return "";
}

async function remoteFileExists(sshConnectionId: string, filePath: string): Promise<boolean> {
  const quoted = shellQuote(filePath);
  const { stdout } = await sshExec(
    sshConnectionId,
    `[ -f ${quoted} ] && echo 1 || echo 0`,
  );
  const exists = stdout.trim() === "1";
  deployDetectLog(SERVICE, "remoteFileExists", { filePath, exists });
  return exists;
}

function resolveHostLocation(variables: PostgresDeployVariables, pidFile: string): string {
  if (variables.dataDirectory) {
    return variables.dataDirectory;
  }
  if (variables.configFile) {
    const normalized = variables.configFile.replace(/\\/g, "/");
    const slash = normalized.lastIndexOf("/");
    if (slash > 0) {
      return normalized.slice(0, slash);
    }
  }
  const normalized = pidFile.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  if (slash > 0) {
    return normalized.slice(0, slash);
  }
  return pidFile;
}

async function findDockerContainerByPort(
  sshConnectionId: string,
  port: number,
): Promise<DockerContainerRef | null> {
  const primaryCommand = buildFindDockerContainerByPortCommand(port);
  let { stdout } = await sshExec(sshConnectionId, primaryCommand);
  let parsed = parseDockerPsFormatLine(stdout.split("\n")[0] ?? "");
  deployDetectLog(SERVICE, "docker.findByPort.primary", {
    port,
    command: primaryCommand,
    rawLine: stdout.split("\n")[0] ?? "",
    parsed,
  });
  if (parsed) {
    return parsed;
  }

  const fallbackCommand = buildFindDockerContainerByPortFallbackCommand(port);
  ({ stdout } = await sshExec(sshConnectionId, fallbackCommand));
  parsed = parseDockerPsPortsFallbackLine(stdout.split("\n")[0] ?? "");
  deployDetectLog(SERVICE, "docker.findByPort.fallback", {
    port,
    command: fallbackCommand,
    rawLine: stdout.split("\n")[0] ?? "",
    parsed,
  });
  return parsed;
}

async function dockerContainerFileExists(
  sshConnectionId: string,
  containerId: string,
  filePath: string,
): Promise<boolean> {
  const id = shellQuote(containerId);
  const file = shellQuote(filePath);
  const command = `docker exec ${id} sh -c "[ -f ${file} ] && echo 1 || echo 0" 2>/dev/null`;
  const { stdout } = await sshExec(sshConnectionId, command);
  const exists = stdout.trim() === "1";
  deployDetectLog(SERVICE, "dockerContainerFileExists", { containerId, filePath, exists });
  return exists;
}

/** 探测 PostgreSQL 服务部署方式（主�?/ Docker / 未知）�?*/
export async function probePostgresDeployment(
  connection: DbConnectionConfig,
  sshConnections: Connection[],
): Promise<PostgresDeploymentInfo> {
  deployDetectLog(SERVICE, "probe.start", {
    connection: summarizeDbConnection(connection),
    sshConnectionCount: sshConnections.length,
  });

  if (!isPostgresConnection(connection)) {
    deployDetectWarn(SERVICE, "probe.skip.unsupportedEngine", {
      dbType: connection.db_type,
    });
    return { kind: "unknown", reason: "probe_failed" };
  }

  let variables: PostgresDeployVariables;
  try {
    variables = await queryPostgresDeployVariables(connection);
  } catch (e) {
    deployDetectWarn(SERVICE, "probe.fail.querySettings", { error: String(e) });
    return { kind: "unknown", reason: "probe_failed" };
  }

  const pidFile = resolvePidFile(variables);
  if (!pidFile) {
    deployDetectWarn(SERVICE, "probe.fail.noPidFile", variables);
    return {
      kind: "unknown",
      reason: "no_pid_file",
      dataDirectory: variables.dataDirectory,
      configFile: variables.configFile,
    };
  }

  const syncSsh = findSshConnectionForDbHostSync(sshConnections, connection.host);
  deployDetectLog(SERVICE, "ssh.match.sync", {
    dbHost: connection.host,
    matched: syncSsh ? { id: syncSsh.id, name: syncSsh.name } : null,
  });

  const ssh = await findSshConnectionForDbHost(sshConnections, connection.host);
  if (!ssh) {
    deployDetectWarn(SERVICE, "probe.fail.noSsh", {
      dbHost: connection.host,
      sshHosts: sshConnections.map((conn) => conn.name),
    });
    return {
      kind: "unknown",
      reason: "no_ssh",
      pidFile,
      dataDirectory: variables.dataDirectory,
      configFile: variables.configFile,
    };
  }

  const sshReady = await ensureSshReady(ssh.id);
  deployDetectLog(SERVICE, "ssh.ready", {
    sshConnectionId: ssh.id,
    serverName: ssh.name,
    ready: sshReady,
  });
  if (!sshReady) {
    return {
      kind: "unknown",
      reason: "ssh_not_connected",
      pidFile,
      dataDirectory: variables.dataDirectory,
      configFile: variables.configFile,
      sshConnectionId: ssh.id,
      serverName: ssh.name,
    };
  }

  const sshMeta = { sshConnectionId: ssh.id, serverName: ssh.name };

  try {
    if (await remoteFileExists(ssh.id, pidFile)) {
      const info: PostgresDeploymentInfo = {
        kind: "host",
        pidFile,
        dataDirectory: variables.dataDirectory,
        configFile: variables.configFile,
        locationTag: resolveHostLocation(variables, pidFile),
        ...sshMeta,
      };
      deployDetectLog(SERVICE, "probe.done", summarizeDeploymentInfo(info));
      return info;
    }

    deployDetectLog(SERVICE, "probe.hostPidMissing.tryDocker", {
      pidFile,
      port: connection.port,
    });
    const container = await findDockerContainerByPort(ssh.id, connection.port);
    if (!container) {
      const info: PostgresDeploymentInfo = {
        kind: "unknown",
        reason: "no_container",
        pidFile,
        dataDirectory: variables.dataDirectory,
        configFile: variables.configFile,
        ...sshMeta,
      };
      deployDetectWarn(SERVICE, "probe.done", summarizeDeploymentInfo(info));
      return info;
    }

    if (await dockerContainerFileExists(ssh.id, container.id, pidFile)) {
      const info: PostgresDeploymentInfo = {
        kind: "docker",
        pidFile,
        dataDirectory: variables.dataDirectory,
        configFile: variables.configFile,
        containerId: container.id,
        containerName: container.name,
        locationTag: container.name || container.id,
        ...sshMeta,
      };
      deployDetectLog(SERVICE, "probe.done", summarizeDeploymentInfo(info));
      return info;
    }

    const info: PostgresDeploymentInfo = {
      kind: "unknown",
      reason: "pid_not_in_container",
      pidFile,
      dataDirectory: variables.dataDirectory,
      configFile: variables.configFile,
      containerId: container.id,
      containerName: container.name,
      ...sshMeta,
    };
    deployDetectWarn(SERVICE, "probe.done", summarizeDeploymentInfo(info));
    return info;
  } catch (e) {
    deployDetectWarn(SERVICE, "probe.fail.exception", { error: String(e), pidFile });
    return {
      kind: "unknown",
      reason: "probe_failed",
      pidFile,
      dataDirectory: variables.dataDirectory,
      configFile: variables.configFile,
      ...sshMeta,
    };
  }
}
