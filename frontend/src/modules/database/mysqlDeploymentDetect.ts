import { invoke } from "@tauri-apps/api/core";
import { commands } from "../../ipc/bindings";
import type { Connection } from "../../ipc/bindings";
import type { DbConnectionConfig } from "./api";
import { isMysqlConnectionInfoCapable } from "./api";
import {
  ensureSshReady,
  findSshConnectionForDbHost,
} from "./mysqlSlowQueryLog";
import { makeQueryRunId } from "./sql/queryRun";
import type { QueryResult } from "./workspace/dbWorkspaceState";
import { rowsToRecord } from "./workspace/dbWorkspaceState";
import {
  buildFindDockerContainerByPortCommand,
  buildFindDockerContainerByPortFallbackCommand,
  parseDockerPsFormatLine,
  parseDockerPsPortsFallbackLine,
  type DockerContainerRef,
} from "./dockerContainerResolve";

export type MysqlDeploymentKind = "host" | "docker" | "unknown";

export type MysqlDeploymentReason =
  | "no_ssh"
  | "ssh_not_connected"
  | "no_pid_file"
  | "no_container"
  | "pid_not_in_container"
  | "probe_failed";

export interface MysqlDeploymentInfo {
  kind: MysqlDeploymentKind;
  /** 主机：安装目录；Docker：容器名（或 ID） */
  locationTag?: string;
  pidFile?: string;
  containerId?: string;
  containerName?: string;
  sshConnectionId?: string;
  /** 匹配到的 SSH 连接名称（服务器） */
  serverName?: string;
  reason?: MysqlDeploymentReason;
}

interface MysqlDeployVariables {
  pidFile: string;
  basedir: string;
  datadir: string;
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

async function queryMysqlDeployVariables(
  connection: DbConnectionConfig,
): Promise<MysqlDeployVariables> {
  const queryResult = await invoke<QueryResult>("db_execute_query", {
    connection,
    sql: "SHOW VARIABLES WHERE Variable_name IN ('pid_file', 'basedir', 'datadir')",
    runId: makeQueryRunId(),
  });
  const rows = rowsToRecord(queryResult.columns, queryResult.rows);
  const read = (name: string) =>
    String(rows.find((row) => row.Variable_name === name)?.Value ?? "").trim();
  return {
    pidFile: read("pid_file"),
    basedir: read("basedir"),
    datadir: read("datadir"),
  };
}

async function remoteFileExists(sshConnectionId: string, filePath: string): Promise<boolean> {
  const quoted = shellQuote(filePath);
  const { stdout } = await sshExec(
    sshConnectionId,
    `[ -f ${quoted} ] && echo 1 || echo 0`,
  );
  return stdout.trim() === "1";
}

function resolveHostInstallLocation(
  basedir: string,
  datadir: string,
  pidFile: string,
): string {
  if (basedir) {
    return basedir;
  }
  if (datadir) {
    return datadir;
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

/** 探测 MySQL 服务部署方式（主机 / Docker / 未知）。 */
export async function probeMysqlDeployment(
  connection: DbConnectionConfig,
  sshConnections: Connection[],
): Promise<MysqlDeploymentInfo> {
  if (!isMysqlConnectionInfoCapable(connection)) {
    return { kind: "unknown", reason: "probe_failed" };
  }

  let variables: MysqlDeployVariables;
  try {
    variables = await queryMysqlDeployVariables(connection);
  } catch {
    return { kind: "unknown", reason: "probe_failed" };
  }

  const { pidFile, basedir, datadir } = variables;
  if (!pidFile) {
    return { kind: "unknown", reason: "no_pid_file" };
  }

  const ssh = await findSshConnectionForDbHost(sshConnections, connection.host);
  if (!ssh) {
    return { kind: "unknown", reason: "no_ssh", pidFile };
  }

  const sshReady = await ensureSshReady(ssh.id);
  if (!sshReady) {
    return {
      kind: "unknown",
      reason: "ssh_not_connected",
      pidFile,
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
        locationTag: resolveHostInstallLocation(basedir, datadir, pidFile),
        ...sshMeta,
      };
    }

    const container = await findDockerContainerByPort(ssh.id, connection.port);
    if (!container) {
      return { kind: "unknown", reason: "no_container", pidFile, ...sshMeta };
    }

    if (await dockerContainerFileExists(ssh.id, container.id, pidFile)) {
      return {
        kind: "docker",
        pidFile,
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
      containerId: container.id,
      containerName: container.name,
      ...sshMeta,
    };
  } catch {
    return { kind: "unknown", reason: "probe_failed", pidFile, ...sshMeta };
  }
}
