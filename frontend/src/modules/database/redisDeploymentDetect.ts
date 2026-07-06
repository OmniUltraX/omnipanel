import { commands } from "../../ipc/bindings";
import type { Connection } from "../../ipc/bindings";
import type { DbConnectionConfig } from "./api";
import { isRedisConnection, redisConfigGet } from "./api";
import {
  ensureSshReady,
  findSshConnectionForDbHost,
} from "./mysqlSlowQueryLog";

export type RedisDeploymentKind = "host" | "docker" | "unknown";

export type RedisDeploymentReason =
  | "no_ssh"
  | "ssh_not_connected"
  | "no_pid_file"
  | "no_container"
  | "pid_not_in_container"
  | "probe_failed";

export interface RedisDeploymentInfo {
  kind: RedisDeploymentKind;
  /** 主机：安装/数据目录（CONFIG GET dir）；Docker：容器名（或 ID） */
  locationTag?: string;
  pidFile?: string;
  /** CONFIG GET dir：Redis 安装目录，配置文件通常位于 `{dir}/redis.conf` */
  dir?: string;
  containerId?: string;
  containerName?: string;
  sshConnectionId?: string;
  serverName?: string;
  reason?: RedisDeploymentReason;
}

interface RedisDeployVariables {
  pidFile: string;
  dir: string;
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

async function queryRedisConfigValue(
  connection: DbConnectionConfig,
  name: string,
): Promise<string> {
  const pairs = await redisConfigGet(connection, name);
  const lower = name.toLowerCase();
  const hit = pairs.find(([key]) => key.toLowerCase() === lower);
  return String(hit?.[1] ?? "").trim();
}

async function queryRedisDeployVariables(
  connection: DbConnectionConfig,
): Promise<RedisDeployVariables> {
  const [pidFile, dir] = await Promise.all([
    queryRedisConfigValue(connection, "pidfile"),
    queryRedisConfigValue(connection, "dir"),
  ]);
  return { pidFile, dir };
}

async function remoteFileExists(sshConnectionId: string, filePath: string): Promise<boolean> {
  const quoted = shellQuote(filePath);
  const { stdout } = await sshExec(
    sshConnectionId,
    `[ -f ${quoted} ] && echo 1 || echo 0`,
  );
  return stdout.trim() === "1";
}

function resolveHostLocation(dir: string, pidFile: string): string {
  if (dir) {
    return dir;
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

/** 探测 Redis 服务部署方式（主机 / Docker / 未知）。 */
export async function probeRedisDeployment(
  connection: DbConnectionConfig,
  sshConnections: Connection[],
): Promise<RedisDeploymentInfo> {
  if (!isRedisConnection(connection)) {
    return { kind: "unknown", reason: "probe_failed" };
  }

  let variables: RedisDeployVariables;
  try {
    variables = await queryRedisDeployVariables(connection);
  } catch {
    return { kind: "unknown", reason: "probe_failed" };
  }

  const { pidFile, dir } = variables;
  if (!pidFile) {
    return { kind: "unknown", reason: "no_pid_file", dir };
  }

  const ssh = findSshConnectionForDbHost(sshConnections, connection.host);
  if (!ssh) {
    return { kind: "unknown", reason: "no_ssh", pidFile, dir };
  }

  const sshReady = await ensureSshReady(ssh.id);
  if (!sshReady) {
    return {
      kind: "unknown",
      reason: "ssh_not_connected",
      pidFile,
      dir,
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
        dir,
        locationTag: resolveHostLocation(dir, pidFile),
        ...sshMeta,
      };
    }

    const container = await findDockerContainerByPort(ssh.id, connection.port);
    if (!container) {
      return { kind: "unknown", reason: "no_container", pidFile, dir, ...sshMeta };
    }

    if (await dockerContainerFileExists(ssh.id, container.id, pidFile)) {
      return {
        kind: "docker",
        pidFile,
        dir,
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
      dir,
      containerId: container.id,
      containerName: container.name,
      ...sshMeta,
    };
  } catch {
    return { kind: "unknown", reason: "probe_failed", pidFile, dir, ...sshMeta };
  }
}
