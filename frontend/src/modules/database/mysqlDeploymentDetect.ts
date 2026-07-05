import { invoke } from "@tauri-apps/api/core";
import { exists } from "@tauri-apps/plugin-fs";
import { commands } from "../../ipc/bindings";
import type { Connection } from "../../ipc/bindings";
import type { DbConnectionConfig } from "./api";
import { isMysqlConnectionInfoCapable } from "./api";
import {
  findSshConnectionForDbHost,
  ensureSshExecReady,
} from "./mysqlSlowQueryLog";
import { makeQueryRunId } from "./sql/queryRun";
import type { QueryResult } from "./workspace/dbWorkspaceState";
import { rowsToRecord } from "./workspace/dbWorkspaceState";

export type MysqlDeploymentKind = "host" | "docker" | "unknown";

export type MysqlDeploymentReason =
  | "no_ssh"
  | "ssh_not_connected"
  | "no_pid_file"
  | "no_container"
  | "pid_not_in_container"
  | "db_query_failed"
  | "ssh_command_failed"
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
  /** 失败时的补充细节（错误信息、路径等） */
  detail?: string;
}

interface MysqlDeployVariables {
  pidFile: string;
  basedir: string;
  datadir: string;
}

const LOCALHOST_ALIASES = new Set(["localhost", "127.0.0.1", "::1"]);

function isLocalDbHost(host: string): boolean {
  return LOCALHOST_ALIASES.has(host.trim().toLowerCase());
}

function formatProbeError(error: unknown): string {
  if (typeof error === "string") {
    return error.trim();
  }
  if (error instanceof Error) {
    return error.message.trim();
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function readMysqlVariable(rows: Record<string, unknown>[], name: string): string {
  const target = name.toLowerCase();
  for (const row of rows) {
    const nameKey = Object.keys(row).find((key) => {
      const lower = key.toLowerCase();
      return lower === "variable_name" || lower === "name";
    });
    const valueKey = Object.keys(row).find((key) => key.toLowerCase() === "value");
    if (!nameKey || !valueKey) {
      continue;
    }
    if (String(row[nameKey] ?? "").trim().toLowerCase() === target) {
      return String(row[valueKey] ?? "").trim();
    }
  }
  return "";
}

async function localFileExists(filePath: string): Promise<boolean> {
  const normalized = filePath.trim();
  if (!normalized) {
    return false;
  }
  try {
    return await exists(normalized);
  } catch {
    return false;
  }
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
    const err = res.error;
    const detail = "cause" in err && err.cause ? `${err.message}：${err.cause}` : err.message;
    throw new Error(detail);
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
  return {
    pidFile: readMysqlVariable(rows, "pid_file"),
    basedir: readMysqlVariable(rows, "basedir"),
    datadir: readMysqlVariable(rows, "datadir"),
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

interface DockerContainerRef {
  id: string;
  name: string;
  ports: string;
}

async function listRunningContainers(
  sshConnectionId: string,
): Promise<DockerContainerRef[]> {
  const { stdout } = await sshExec(
    sshConnectionId,
    `docker ps --format '{{.ID}}\t{{.Names}}\t{{.Ports}}' 2>/dev/null`,
  );
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, names, ports = ""] = line.split("\t");
      const name = (names?.split(",")[0] ?? names ?? id ?? "").trim();
      return { id: id?.trim() ?? "", name, ports: ports.trim() };
    })
    .filter((item) => item.id.length > 0);
}

/** 宿主机端口是否映射到容器（如 0.0.0.0:3306->3306/tcp）。 */
function hostPortPublished(ports: string, port: number): boolean {
  if (!ports) {
    return false;
  }
  return (
    new RegExp(`(^|[,\\[])[^\\s]*:${port}->`).test(ports) ||
    new RegExp(`\\b:${port}->`).test(ports)
  );
}

/** 容器是否暴露指定端口（含仅 expose、无 publish 的情况）。 */
function containerPortExposed(ports: string, port: number): boolean {
  if (!ports) {
    return false;
  }
  return (
    hostPortPublished(ports, port) ||
    new RegExp(`->${port}/(?:tcp|udp)`).test(ports) ||
    new RegExp(`(^|, )${port}/(?:tcp|udp)`).test(ports)
  );
}

async function findDockerContainerByPidFile(
  sshConnectionId: string,
  pidFile: string,
  containers: DockerContainerRef[],
): Promise<DockerContainerRef | null> {
  for (const container of containers) {
    const exists = await dockerContainerFileExists(sshConnectionId, container.id, pidFile);
    if (exists) {
      return container;
    }
  }
  return null;
}

async function findDockerContainer(
  sshConnectionId: string,
  port: number,
  pidFile: string,
): Promise<{ id: string; name: string } | null> {
  for (const filter of [
    `publish=${port}`,
    `publish=${port}/tcp`,
    `publish=${port}/udp`,
    `expose=${port}`,
  ]) {
    try {
      const { stdout } = await sshExec(
        sshConnectionId,
        `docker ps --format '{{.ID}}\t{{.Names}}' --filter "${filter}" 2>/dev/null | head -1`,
      );
      const line = stdout.trim();
      if (!line) {
        continue;
      }
      const [id, names] = line.split("\t");
      if (id?.trim()) {
        return { id: id.trim(), name: (names?.split(",")[0] ?? id).trim() };
      }
    } catch {
      // try next filter
    }
  }

  const containers = await listRunningContainers(sshConnectionId);

  const byHostPort = containers.find((item) => hostPortPublished(item.ports, port));
  if (byHostPort) {
    return { id: byHostPort.id, name: byHostPort.name };
  }

  const byExpose = containers.find((item) => containerPortExposed(item.ports, port));
  if (byExpose) {
    return { id: byExpose.id, name: byExpose.name };
  }

  const byPidFile = await findDockerContainerByPidFile(sshConnectionId, pidFile, containers);
  if (byPidFile) {
    return { id: byPidFile.id, name: byPidFile.name };
  }

  return null;
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
  } catch (error) {
    return {
      kind: "unknown",
      reason: "db_query_failed",
      detail: formatProbeError(error),
    };
  }

  const { pidFile, basedir, datadir } = variables;
  if (!pidFile) {
    return { kind: "unknown", reason: "no_pid_file" };
  }

  if (isLocalDbHost(connection.host)) {
    const localExists = await localFileExists(pidFile);
    if (localExists) {
      return {
        kind: "host",
        pidFile,
        locationTag: resolveHostInstallLocation(basedir, datadir, pidFile),
      };
    }
  }

  const ssh = await findSshConnectionForDbHost(sshConnections, connection.host);
  if (!ssh) {
    if (isLocalDbHost(connection.host)) {
      return {
        kind: "unknown",
        reason: "no_container",
        pidFile,
        detail: pidFile,
      };
    }
    return { kind: "unknown", reason: "no_ssh", pidFile };
  }

  if (!(await ensureSshExecReady(ssh.id, connection, sshConnections))) {
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
    const hostExists = await remoteFileExists(ssh.id, pidFile);
    if (hostExists) {
      const location = resolveHostInstallLocation(basedir, datadir, pidFile);
      return {
        kind: "host",
        pidFile,
        locationTag: location,
        ...sshMeta,
      };
    }

    const container = await findDockerContainer(ssh.id, connection.port, pidFile);
    if (!container) {
      return { kind: "unknown", reason: "no_container", pidFile, ...sshMeta };
    }

    const inContainer = await dockerContainerFileExists(ssh.id, container.id, pidFile);
    if (inContainer) {
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
  } catch (error) {
    return {
      kind: "unknown",
      reason: "ssh_command_failed",
      pidFile,
      ...sshMeta,
      detail: formatProbeError(error),
    };
  }
}
