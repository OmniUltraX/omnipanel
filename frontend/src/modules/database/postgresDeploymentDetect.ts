import { invoke } from "@tauri-apps/api/core";
import { commands } from "../../ipc/bindings";
import type { Connection } from "../../ipc/bindings";
import type { DbConnectionConfig } from "./api";
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
  const res = await commands.sshPoolExecCommand(sshConnectionId, command);
  if (res.status !== "ok") {
    throw new Error(res.error.message);
  }
  return { stdout: res.data.stdout, stderr: res.data.stderr };
}

async function queryPostgresDeployVariables(
  connection: DbConnectionConfig,
): Promise<PostgresDeployVariables> {
  const queryResult = await invoke<QueryResult>("db_execute_query", {
    connection,
    sql:
      "SELECT name, setting FROM pg_settings WHERE name IN ('data_directory', 'external_pid_file', 'config_file')",
    runId: makeQueryRunId(),
  });
  const rows = rowsToRecord(queryResult.columns, queryResult.rows);
  const read = (name: string) =>
    String(rows.find((row) => row.name === name)?.setting ?? "").trim();
  return {
    dataDirectory: read("data_directory"),
    externalPidFile: read("external_pid_file"),
    configFile: read("config_file"),
  };
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
  return stdout.trim() === "1";
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
  let { stdout } = await sshExec(
    sshConnectionId,
    buildFindDockerContainerByPortCommand(port),
  );
  let parsed = parseDockerPsFormatLine(stdout.split("\n")[0] ?? "");
  if (parsed) {
    return parsed;
  }
  ({ stdout } = await sshExec(
    sshConnectionId,
    buildFindDockerContainerByPortFallbackCommand(port),
  ));
  parsed = parseDockerPsPortsFallbackLine(stdout.split("\n")[0] ?? "");
  return parsed;
}

async function dockerContainerFileExists(
  sshConnectionId: string,
  containerId: string,
  filePath: string,
): Promise<boolean> {
  const id = shellQuote(containerId);
  const file = shellQuote(filePath);
  const { stdout } = await sshExec(
    sshConnectionId,
    `docker exec ${id} sh -c "[ -f ${file} ] && echo 1 || echo 0" 2>/dev/null`,
  );
  return stdout.trim() === "1";
}

/** ?? PostgreSQL ????????? / Docker / ???? */
export async function probePostgresDeployment(
  connection: DbConnectionConfig,
  sshConnections: Connection[],
): Promise<PostgresDeploymentInfo> {
  if (!isPostgresConnection(connection)) {
    return { kind: "unknown", reason: "probe_failed" };
  }

  let variables: PostgresDeployVariables;
  try {
    variables = await queryPostgresDeployVariables(connection);
  } catch {
    return { kind: "unknown", reason: "probe_failed" };
  }

  const pidFile = resolvePidFile(variables);
  if (!pidFile) {
    return {
      kind: "unknown",
      reason: "no_pid_file",
      dataDirectory: variables.dataDirectory,
      configFile: variables.configFile,
    };
  }

  const ssh = await findSshConnectionForDbHost(sshConnections, connection.host);
  if (!ssh) {
    return {
      kind: "unknown",
      reason: "no_ssh",
      pidFile,
      dataDirectory: variables.dataDirectory,
      configFile: variables.configFile,
    };
  }

  const sshReady = await ensureSshReady(ssh.id);
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
      return {
        kind: "host",
        pidFile,
        dataDirectory: variables.dataDirectory,
        configFile: variables.configFile,
        locationTag: resolveHostLocation(variables, pidFile),
        ...sshMeta,
      };
    }

    const container = await findDockerContainerByPort(ssh.id, connection.port);
    if (!container) {
      return {
        kind: "unknown",
        reason: "no_container",
        pidFile,
        dataDirectory: variables.dataDirectory,
        configFile: variables.configFile,
        ...sshMeta,
      };
    }

    if (await dockerContainerFileExists(ssh.id, container.id, pidFile)) {
      return {
        kind: "docker",
        pidFile,
        dataDirectory: variables.dataDirectory,
        configFile: variables.configFile,
        containerId: container.id,
        containerName: container.name,
        locationTag: container.name || container.id,
        ...sshMeta,
      };
    }

    return {
      kind: "unknown",
      reason: "pid_not_in_container",
      pidFile,
      dataDirectory: variables.dataDirectory,
      configFile: variables.configFile,
      containerId: container.id,
      containerName: container.name,
      ...sshMeta,
    };
  } catch {
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
