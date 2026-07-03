import { invoke } from "@tauri-apps/api/core";
import { commands } from "../../ipc/bindings";
import type { Connection } from "../../ipc/bindings";
import { parseSshConfig } from "../server/panel/serverConnection";
import { useSshConnectionStore } from "../../stores/sshConnectionStore";
import { useTerminalStore } from "../../stores/terminalStore";
import type { DbConnectionConfig } from "./api";
import { isMysqlConnectionInfoCapable } from "./api";
import { makeQueryRunId } from "./sql/queryRun";
import type { QueryResult } from "./workspace/dbWorkspaceState";
import { rowsToRecord } from "./workspace/dbWorkspaceState";
import { probeMysqlDeployment } from "./mysqlDeploymentDetect";

const LOCALHOST_ALIASES = new Set(["localhost", "127.0.0.1", "::1"]);

/** 单次从日志文件尾部读取的字节数（慢查询日志可能很大，默认只读尾部）。 */
export type SlowLogAvailability = {
  enabled: boolean;
  reason?: string;
  sshConnectionId?: string;
  logFilePath?: string;
  deploymentKind?: "host" | "docker";
  containerId?: string;
};

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

/** 粗略判断 host 是否为域名（非 IP 格式且非 localhost 别名）。 */
function isDomainName(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (LOCALHOST_ALIASES.has(h)) return false;
  // 包含字母 → 域名
  return /[a-zA-Z]/.test(h);
}

export function hostsMatch(dbHost: string, sshHost: string): boolean {
  const a = normalizeHost(dbHost);
  const b = normalizeHost(sshHost);
  if (a === b) return true;
  return LOCALHOST_ALIASES.has(a) && LOCALHOST_ALIASES.has(b);
}

/** 同步的快速匹配（不解析域名），用于无法 await 的上下文。 */
export function findSshConnectionForDbHostSync(
  sshConnections: Connection[],
  dbHost: string,
): Connection | undefined {
  return sshConnections.find((conn) => {
    if (conn.kind !== "ssh") return false;
    const cfg = parseSshConfig(conn);
    return cfg ? hostsMatch(dbHost, cfg.host) : false;
  });
}

/** 按数据库 host 查找匹配的 SSH 连接。先做直接匹配，失败时自动解析域名后重试。 */
export async function findSshConnectionForDbHost(
  sshConnections: Connection[],
  dbHost: string,
): Promise<Connection | undefined> {
  // 1. 直接匹配（同步快速路径）
  const matched = findSshConnectionForDbHostSync(sshConnections, dbHost);
  if (matched) return matched;

  // 2. 尝试解析两侧域名后匹配
  const needResolve = (h: string) => isDomainName(h) && !LOCALHOST_ALIASES.has(normalizeHost(h));
  const resolvedCache = new Map<string, string[]>();

  async function resolve(h: string): Promise<string[]> {
    const cached = resolvedCache.get(h);
    if (cached) return cached;
    try {
      const addrs = await invoke<string[]>("resolve_host", { host: h });
      resolvedCache.set(h, addrs);
      return addrs;
    } catch {
      return [];
    }
  }

  const dbResolved: string[] = needResolve(dbHost) ? await resolve(dbHost) : [normalizeHost(dbHost)];

  for (const conn of sshConnections) {
    if (conn.kind !== "ssh") continue;
    const cfg = parseSshConfig(conn);
    if (!cfg) continue;
    let sshCandidates: string[] = [normalizeHost(cfg.host)];
    if (needResolve(cfg.host)) {
      sshCandidates = [...sshCandidates, ...(await resolve(cfg.host))];
    }
    sshCandidates = [...new Set(sshCandidates)];

    for (const a of dbResolved) {
      for (const b of sshCandidates) {
        if (a === b) return conn;
      }
    }
  }

  return undefined;
}

function remotePaneConnected(resourceId: string): boolean {
  const { embeddedPanes, tabs } = useTerminalStore.getState();
  for (const pane of Object.values(embeddedPanes)) {
    if (pane.resourceId === resourceId && pane.type === "remote" && pane.status === "connected") {
      return true;
    }
  }
  for (const tab of tabs) {
    if (tab.session.resourceId === resourceId && tab.session.type === "remote" && tab.status === "connected") {
      return true;
    }
  }
  return false;
}

/** SSH 连接池或终端会话已建立。 */
export function isSshConnectionEstablished(sshConnectionId: string): boolean {
  if (useSshConnectionStore.getState().sessionActiveMap[sshConnectionId]) {
    return true;
  }
  return remotePaneConnected(sshConnectionId);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function queryMysqlVariables(
  connection: DbConnectionConfig,
): Promise<{ slowLogOn: boolean; logFilePath: string }> {
  const queryResult = await invoke<QueryResult>("db_execute_query", {
    connection,
    sql: "SHOW VARIABLES WHERE Variable_name IN ('slow_query_log', 'slow_query_log_file')",
    runId: makeQueryRunId(),
  });
  const rows = rowsToRecord(queryResult.columns, queryResult.rows);
  const slowLog = String(rows.find((row) => row.Variable_name === "slow_query_log")?.Value ?? "");
  const logFile = String(rows.find((row) => row.Variable_name === "slow_query_log_file")?.Value ?? "");
  const slowLogOn = slowLog === "ON" || slowLog === "1" || slowLog.toLowerCase() === "yes";
  return { slowLogOn, logFilePath: logFile.trim() };
}

/** 同步部分：仅根据 MySQL 类型、SSH 匹配与会话状态判断（不含慢日志开关探测）。 */
export function resolveSlowLogAvailabilitySync(
  connection: DbConnectionConfig,
  sshConnections: Connection[],
): SlowLogAvailability {
  if (!isMysqlConnectionInfoCapable(connection)) {
    return { enabled: false, reason: "not_mysql" };
  }
  const ssh = findSshConnectionForDbHostSync(sshConnections, connection.host);
  if (!ssh) {
    return { enabled: false, reason: "no_ssh" };
  }
  if (!isSshConnectionEstablished(ssh.id)) {
    return { enabled: false, reason: "ssh_not_connected", sshConnectionId: ssh.id };
  }
  return { enabled: false, reason: "checking", sshConnectionId: ssh.id };
}

/** 异步探测慢查询日志是否开启，并返回日志文件路径及部署信息。 */
export async function probeSlowLogAvailability(
  connection: DbConnectionConfig,
  sshConnections: Connection[],
): Promise<SlowLogAvailability> {
  console.log(`[probeSlowLogAvailability] 开始: ${connection.name} (${connection.host}:${connection.port})`);
  const sync = resolveSlowLogAvailabilitySync(connection, sshConnections);
  if (sync.reason === "not_mysql" || sync.reason === "no_ssh" || sync.reason === "ssh_not_connected") {
    console.log(`[probeSlowLogAvailability] 同步检查不通过: ${sync.reason}`);
    return sync;
  }
  const sshId = sync.sshConnectionId;
  if (!sshId) {
    console.warn(`[probeSlowLogAvailability] 无 sshConnectionId`);
    return { enabled: false, reason: "no_ssh" };
  }
  if (!isConnectionEnabledForProbe(connection)) {
    console.log(`[probeSlowLogAvailability] 连接未启用`);
    return { enabled: false, reason: "connection_disabled", sshConnectionId: sshId };
  }
  try {
    const { slowLogOn, logFilePath } = await queryMysqlVariables(connection);
    console.log(`[probeSlowLogAvailability] MySQL 变量: slow_log=${slowLogOn}, log_file=${logFilePath}`);
    if (!slowLogOn) {
      console.warn(`[probeSlowLogAvailability] 慢查询日志未开启`);
      return { enabled: false, reason: "slow_log_off", sshConnectionId: sshId };
    }
    if (!logFilePath) {
      console.warn(`[probeSlowLogAvailability] 慢查询日志路径为空`);
      return { enabled: false, reason: "slow_log_file_missing", sshConnectionId: sshId };
    }
    // 探测部署方式（主机 / Docker），决定如何读取日志文件
    console.log(`[probeSlowLogAvailability] 开始探测部署方式...`);
    const deployment = await probeMysqlDeployment(connection, sshConnections);
    console.log(`[probeSlowLogAvailability] 部署方式: ${deployment.kind}`, deployment);
    const deploymentKind = deployment.kind === "docker" ? "docker" as const : "host" as const;
    const containerId = deployment.kind === "docker" ? deployment.containerId : undefined;
    return { enabled: true, sshConnectionId: sshId, logFilePath, deploymentKind, containerId };
  } catch (err) {
    console.warn(`[probeSlowLogAvailability] 探测异常:`, err);
    return { enabled: false, reason: "probe_failed", sshConnectionId: sshId };
  }
}

function isConnectionEnabledForProbe(connection: DbConnectionConfig): boolean {
  return connection.enabled !== false;
}

function sshExec(sshConnectionId: string, command: string): Promise<{ stdout: string; stderr: string }> {
  return commands.sshPoolExecCommand(sshConnectionId, command).then((res) => {
    if (res.status !== "ok") {
      throw new Error(res.error.message);
    }
    return { stdout: res.data.stdout, stderr: res.data.stderr };
  });
}

/** 通过 SSH 读取远端文件尾部若干字节。 */
async function readMysqlSlowLogTailSsh(
  sshConnectionId: string,
  logFilePath: string,
  maxBytes: number,
): Promise<string> {
  const quoted = shellQuote(logFilePath);
  const command = `tail -c ${Math.max(1, Math.floor(maxBytes))} ${quoted} 2>/dev/null || true`;
  const res = await sshExec(sshConnectionId, command);
  const output = res.stdout;
  if (res.stderr.trim()) {
    return output || res.stderr;
  }
  return output;
}

/** 通过 SSH 获取远端日志文件大小（字节）。 */
async function readMysqlSlowLogFileSizeSsh(
  sshConnectionId: string,
  logFilePath: string,
): Promise<number> {
  const quoted = shellQuote(logFilePath);
  const command = `stat -c %s ${quoted} 2>/dev/null || wc -c < ${quoted}`;
  const res = await sshExec(sshConnectionId, command);
  const raw = res.stdout.trim().split(/\s+/)[0] ?? "0";
  const size = Number.parseInt(raw, 10);
  return Number.isFinite(size) && size >= 0 ? size : 0;
}

/** 通过 docker exec 读取容器内文件尾部若干字节。 */
async function readMysqlSlowLogTailDocker(
  sshConnectionId: string,
  containerId: string,
  logFilePath: string,
  maxBytes: number,
): Promise<string> {
  const cont = shellQuote(containerId);
  const file = shellQuote(logFilePath);
  const command = `docker exec ${cont} sh -c "tail -c ${Math.max(1, Math.floor(maxBytes))} ${file} 2>/dev/null || true"`;
  const res = await sshExec(sshConnectionId, command);
  const output = res.stdout;
  if (res.stderr.trim()) {
    return output || res.stderr;
  }
  return output;
}

/** 通过 docker exec 获取容器内日志文件大小（字节）。 */
async function readMysqlSlowLogFileSizeDocker(
  sshConnectionId: string,
  containerId: string,
  logFilePath: string,
): Promise<number> {
  const cont = shellQuote(containerId);
  const file = shellQuote(logFilePath);
  const command = `docker exec ${cont} sh -c "stat -c %s ${file} 2>/dev/null || wc -c < ${file}"`;
  const res = await sshExec(sshConnectionId, command);
  const raw = res.stdout.trim().split(/\s+/)[0] ?? "0";
  const size = Number.parseInt(raw, 10);
  return Number.isFinite(size) && size >= 0 ? size : 0;
}

/** 读取慢查询日志尾部若干字节（自动选择 SSH / Docker）。 */
export async function readMysqlSlowLogTail(
  sshConnectionId: string,
  logFilePath: string,
  maxBytes: number,
  deploymentKind?: "host" | "docker",
  containerId?: string,
): Promise<string> {
  if (deploymentKind === "docker" && containerId) {
    return readMysqlSlowLogTailDocker(sshConnectionId, containerId, logFilePath, maxBytes);
  }
  return readMysqlSlowLogTailSsh(sshConnectionId, logFilePath, maxBytes);
}

/** 获取日志文件大小（字节，自动选择 SSH / Docker）。 */
export async function readMysqlSlowLogFileSize(
  sshConnectionId: string,
  logFilePath: string,
  deploymentKind?: "host" | "docker",
  containerId?: string,
): Promise<number> {
  if (deploymentKind === "docker" && containerId) {
    return readMysqlSlowLogFileSizeDocker(sshConnectionId, containerId, logFilePath);
  }
  return readMysqlSlowLogFileSizeSsh(sshConnectionId, logFilePath);
}
