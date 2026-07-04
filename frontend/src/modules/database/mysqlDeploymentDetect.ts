import { invoke } from "@tauri-apps/api/core";
import { commands } from "../../ipc/bindings";
import type { Connection } from "../../ipc/bindings";
import type { DbConnectionConfig } from "./api";
import { isMysqlConnectionInfoCapable } from "./api";
import {
  findSshConnectionForDbHost,
  isSshConnectionEstablished,
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

function parseDockerPsLine(line: string): { id: string; name: string } | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) {
    return null;
  }
  return { id: parts[0], name: parts[1] };
}

async function findDockerContainerByPort(
  sshConnectionId: string,
  port: number,
): Promise<{ id: string; name: string } | null> {
  const portNeedle = `:${port}`;
  const quotedNeedle = shellQuote(portNeedle);
  const { stdout } = await sshExec(
    sshConnectionId,
    `docker ps 2>/dev/null | grep ${quotedNeedle} | head -1`,
  );
  return parseDockerPsLine(stdout.split("\n")[0] ?? "");
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
  console.log(`[probeMysqlDeployment] 开始探测: ${connection.name} (${connection.host}:${connection.port})`);

  if (!isMysqlConnectionInfoCapable(connection)) {
    console.warn(`[probeMysqlDeployment] 非 MySQL 连接，跳过`);
    return { kind: "unknown", reason: "probe_failed" };
  }

  let variables: MysqlDeployVariables;
  try {
    variables = await queryMysqlDeployVariables(connection);
    console.log(`[probeMysqlDeployment] 查询到变量: pid_file=${variables.pidFile}, basedir=${variables.basedir}, datadir=${variables.datadir}`);
  } catch {
    console.warn(`[probeMysqlDeployment] 查询 MySQL 变量失败`);
    return { kind: "unknown", reason: "probe_failed" };
  }

  const { pidFile, basedir, datadir } = variables;
  if (!pidFile) {
    console.warn(`[probeMysqlDeployment] pid_file 为空`);
    return { kind: "unknown", reason: "no_pid_file" };
  }

  const ssh = await findSshConnectionForDbHost(sshConnections, connection.host);
  if (!ssh) {
    console.warn(`[probeMysqlDeployment] 未匹配到 SSH 连接 (host=${connection.host})`);
    return { kind: "unknown", reason: "no_ssh", pidFile };
  }
  console.log(`[probeMysqlDeployment] 匹配到 SSH: ${ssh.name} (${ssh.id})`);

  if (!isSshConnectionEstablished(ssh.id)) {
    console.log(`[probeMysqlDeployment] SSH 未连接，尝试自动连接: ${ssh.name}`);
    try {
      const res = await commands.sshConnectConnection(ssh.id, 80, 24);
      if (res.status !== "ok") {
        console.warn(`[probeMysqlDeployment] SSH 自动连接失败: ${res.error.message}`);
        return {
          kind: "unknown",
          reason: "ssh_not_connected",
          pidFile,
          sshConnectionId: ssh.id,
          serverName: ssh.name,
        };
      }
      console.log(`[probeMysqlDeployment] SSH 自动连接成功: ${ssh.name}`);
    } catch (err) {
      console.warn(`[probeMysqlDeployment] SSH 自动连接异常:`, err);
      return {
        kind: "unknown",
        reason: "ssh_not_connected",
        pidFile,
        sshConnectionId: ssh.id,
        serverName: ssh.name,
      };
    }
  }
  console.log(`[probeMysqlDeployment] SSH 已连接: ${ssh.name}`);

  const sshMeta = { sshConnectionId: ssh.id, serverName: ssh.name };

  try {
    const hostExists = await remoteFileExists(ssh.id, pidFile);
    console.log(`[probeMysqlDeployment] 主机上检测 pid_file: ${pidFile} → ${hostExists}`);
    if (hostExists) {
      const location = resolveHostInstallLocation(basedir, datadir, pidFile);
      console.log(`[probeMysqlDeployment] → 判定: 主机部署 (location=${location})`);
      return {
        kind: "host",
        pidFile,
        locationTag: location,
        ...sshMeta,
      };
    }

    const container = await findDockerContainerByPort(ssh.id, connection.port);
    if (!container) {
      console.warn(`[probeMysqlDeployment] 未找到映射端口 ${connection.port} 的 Docker 容器 → 判定: 未知`);
      return { kind: "unknown", reason: "no_container", pidFile, ...sshMeta };
    }
    console.log(`[probeMysqlDeployment] 匹配到容器: ${container.name} (${container.id})`);

    const inContainer = await dockerContainerFileExists(ssh.id, container.id, pidFile);
    console.log(`[probeMysqlDeployment] 容器内检测 pid_file: ${pidFile} → ${inContainer}`);
    if (inContainer) {
      console.log(`[probeMysqlDeployment] → 判定: Docker 部署 (container=${container.name})`);
      return {
        kind: "docker",
        pidFile,
        containerId: container.id,
        containerName: container.name,
        locationTag: container.name || container.id,
        ...sshMeta,
      };
    }

    console.warn(`[probeMysqlDeployment] pid_file 不在容器内 → 判定: 未知`);
    return {
      kind: "unknown",
      reason: "pid_not_in_container",
      pidFile,
      containerId: container.id,
      containerName: container.name,
      ...sshMeta,
    };
  } catch (err) {
    console.warn(`[probeMysqlDeployment] 探测过程异常:`, err);
    return { kind: "unknown", reason: "probe_failed", pidFile, ...sshMeta };
  }
}
