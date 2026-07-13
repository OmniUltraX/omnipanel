import { invoke } from "@tauri-apps/api/core";
import { commands } from "../../ipc/bindings";
import type { Connection } from "../../ipc/bindings";
import { parseSshConfig } from "../server/panel/serverConnection";
import { useSshConnectionStore } from "../../stores/sshConnectionStore";
import { forceReleaseSshPoolSession } from "../../stores/sshPoolSessionStore";
import { useTerminalStore } from "../../stores/terminalStore";
import type { DbConnectionConfig } from "./api";
import { isMysqlConnectionInfoCapable } from "./api";
import { makeQueryRunId } from "./sql/queryRun";
import type { QueryResult } from "./workspace/dbWorkspaceState";
import { rowsToRecord } from "./workspace/dbWorkspaceState";
import { probeMysqlDeployment } from "./mysqlDeploymentDetect";

const LOCALHOST_ALIASES = new Set(["localhost", "127.0.0.1", "::1"]);

/** 单次从日志文件尾部读取的字节数（慢查询日志可能很大，默认只读尾部）。 */
export const MYSQL_SLOW_LOG_CHUNK_BYTES = 32 * 1024;

/** 计算慢查询日志分页总数（第 1 页为最新一段）。 */
export function slowLogTotalPages(
  fileSize: number,
  chunkBytes: number = MYSQL_SLOW_LOG_CHUNK_BYTES,
): number {
  if (fileSize <= 0) return 1;
  return Math.max(1, Math.ceil(fileSize / chunkBytes));
}

/** 计算某一页在文件中的字节范围 [start, start + length)。第 1 页为文件末尾最新一段。 */
export function slowLogPageByteRange(
  page: number,
  fileSize: number,
  chunkBytes: number = MYSQL_SLOW_LOG_CHUNK_BYTES,
): { start: number; length: number } {
  if (fileSize <= 0 || page < 1) {
    return { start: 0, length: 0 };
  }
  const endExclusive = Math.max(0, fileSize - (page - 1) * chunkBytes);
  const start = Math.max(0, endExclusive - chunkBytes);
  return { start, length: endExclusive - start };
}

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
  return /[a-zA-Z]/.test(h);
}

/** 第一步：直接匹配 SSH Host 或 PublicIP（含 localhost 别名互通）。 */
export function hostsMatch(dbHost: string, sshHost: string, sshPublicIp?: string): boolean {
  const a = normalizeHost(dbHost);
  const b = normalizeHost(sshHost);
  if (a === b) return true;
  if (LOCALHOST_ALIASES.has(a) && LOCALHOST_ALIASES.has(b)) return true;
  if (sshPublicIp) {
    const publicIp = normalizeHost(sshPublicIp);
    if (a === publicIp) return true;
  }
  return false;
}

/** 同步的快速匹配（仅第一步，不解析域名），用于无法 await 的上下文。 */
export function findSshConnectionForDbHostSync(
  sshConnections: Connection[],
  dbHost: string,
): Connection | undefined {
  return sshConnections.find((conn) => {
    if (conn.kind !== "ssh") return false;
    const cfg = parseSshConfig(conn);
    return cfg ? hostsMatch(dbHost, cfg.host, cfg.publicIp) : false;
  });
}

/** 同步匹配并返回对应 SSH 连接的 Host（未匹配时返回 undefined）。 */
export function getMatchedSshHostSync(
  sshConnections: Connection[],
  dbHost: string,
): string | undefined {
  const ssh = findSshConnectionForDbHostSync(sshConnections, dbHost);
  if (!ssh) return undefined;
  return parseSshConfig(ssh)?.host;
}

async function resolveHostAddresses(host: string, cache: Map<string, string[]>): Promise<string[]> {
  const cached = cache.get(host);
  if (cached) return cached;
  try {
    const addrs = await invoke<string[]>("resolve_host", { host });
    cache.set(host, addrs);
    return addrs;
  } catch {
    return [];
  }
}

/**
 * 按数据库 host 查找匹配的 SSH 连接：
 * 1. 直接匹配 SSH Host 或 PublicIP
 * 2. 未命中时，解析 SSH Host 为域名的项，用其 IP 与数据库 host 比对
 */
export async function findSshConnectionForDbHost(
  sshConnections: Connection[],
  dbHost: string,
): Promise<Connection | undefined> {
  const matched = findSshConnectionForDbHostSync(sshConnections, dbHost);
  if (matched) return matched;

  const normalizedDbHost = normalizeHost(dbHost);
  const resolvedCache = new Map<string, string[]>();

  for (const conn of sshConnections) {
    if (conn.kind !== "ssh") continue;
    const cfg = parseSshConfig(conn);
    if (!cfg || !isDomainName(cfg.host)) continue;

    const resolved = await resolveHostAddresses(cfg.host, resolvedCache);
    for (const addr of resolved) {
      if (normalizeHost(addr) === normalizedDbHost) {
        return conn;
      }
    }
  }

  return undefined;
}

function isRemoteDbConnection(connection: Pick<DbConnectionConfig, "host" | "db_type" | "enabled">): boolean {
  if (connection.enabled === false) return false;
  const dbType = connection.db_type.toLowerCase();
  if (dbType === "sqlite" || dbType === "sqlite3") return false;
  const host = connection.host.trim();
  if (!host || LOCALHOST_ALIASES.has(host.toLowerCase())) return false;
  return true;
}

/** 刷新本地缓存前，释放并重新建立与数据库 host 对应的 SSH 连接池会话。 */
export async function reestablishSshForDbConnection(
  connection: Pick<DbConnectionConfig, "host" | "db_type" | "enabled">,
  sshConnections: Connection[],
): Promise<void> {
  if (!isRemoteDbConnection(connection)) return;

  const ssh = await findSshConnectionForDbHost(sshConnections, connection.host);
  if (!ssh) return;

  forceReleaseSshPoolSession(ssh.id);
  try {
    await commands.sshPoolRelease(ssh.id);
  } catch {
    // 忽略释放失败，后续仍会尝试重建
  }

  // 仅重建连接池会话（exec 通道），不打开交互式终端。
  await commands.sshPoolFetchStats(ssh.id).catch(() => {});
}

const SSH_EXEC_PROBE = "echo 1";

async function probeSshPoolExec(sshConnectionId: string): Promise<boolean> {
  try {
    const res = await commands.sshPoolExecCommand(sshConnectionId, SSH_EXEC_PROBE);
    if (res.status !== "ok") {
      return false;
    }
    return res.data.stdout.trim() === "1";
  } catch {
    return false;
  }
}

/** 确保 SSH 连接池 exec 通道可用（探测 + 必要时重建会话后重试）。 */
export async function ensureSshExecReady(
  sshConnectionId: string,
  connection: Pick<DbConnectionConfig, "host" | "db_type" | "enabled">,
  sshConnections: Connection[],
): Promise<boolean> {
  if (await probeSshPoolExec(sshConnectionId)) {
    return true;
  }

  await reestablishSshForDbConnection(connection, sshConnections);

  if (await probeSshPoolExec(sshConnectionId)) {
    return true;
  }

  return false;
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

/** 确保 SSH 连接池或终端会话可用于远程命令执行。 */
export async function ensureSshReady(sshConnectionId: string): Promise<boolean> {
  if (isSshConnectionEstablished(sshConnectionId)) {
    return true;
  }

  try {
    const res = await commands.sshPoolFetchStats(sshConnectionId);
    if (res.status === "ok") {
      return true;
    }
  } catch {
    // 回退终端连接
  }

  try {
    const res = await commands.sshConnectConnection(sshConnectionId, 80, 24);
    if (res.status === "ok") {
      return true;
    }
  } catch {
    // ignore
  }

  return isSshConnectionEstablished(sshConnectionId);
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
  const read = (name: string) =>
    String(rows.find((row) => row.Variable_name === name)?.Value ?? "").trim();
  const rawSlowLog = read("slow_query_log");
  const rawLogFile = read("slow_query_log_file");
  const slowLogOn =
    rawSlowLog === "ON" ||
    rawSlowLog === "1" ||
    rawSlowLog.toLowerCase() === "yes" ||
    rawSlowLog.toLowerCase() === "true";
  return { slowLogOn, logFilePath: rawLogFile };
}

async function ensureSshSessionForSlowLog(
  connection: DbConnectionConfig,
  sshConnections: Connection[],
  sshConnectionId: string,
): Promise<boolean> {
  return ensureSshExecReady(sshConnectionId, connection, sshConnections);
}

function isRemoteMysqlHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return Boolean(normalized) && !LOCALHOST_ALIASES.has(normalized);
}

/** 同步部分：MySQL 远程连接在异步 SSH 解析完成前返回 checking。 */
export function resolveSlowLogAvailabilitySync(
  connection: DbConnectionConfig,
  sshConnections: Connection[],
): SlowLogAvailability {
  if (!isMysqlConnectionInfoCapable(connection)) {
    return { enabled: false, reason: "not_mysql" };
  }

  const ssh = findSshConnectionForDbHostSync(sshConnections, connection.host);
  if (!ssh) {
    if (isRemoteMysqlHost(connection.host)) {
      return { enabled: false, reason: "checking" };
    }
    return { enabled: false, reason: "no_ssh" };
  }

  return { enabled: false, reason: "checking", sshConnectionId: ssh.id };
}

/** 异步探测慢查询日志是否开启，并返回日志文件路径及部署信息。 */
export async function probeSlowLogAvailability(
  connection: DbConnectionConfig,
  sshConnections: Connection[],
): Promise<SlowLogAvailability> {
  if (!isMysqlConnectionInfoCapable(connection)) {
    return { enabled: false, reason: "not_mysql" };
  }

  if (!isConnectionEnabledForProbe(connection)) {
    return { enabled: false, reason: "connection_disabled" };
  }

  const ssh = await findSshConnectionForDbHost(sshConnections, connection.host);
  if (!ssh) {
    return { enabled: false, reason: "no_ssh" };
  }

  const sshId = ssh.id;
  const sshReady = await ensureSshSessionForSlowLog(connection, sshConnections, sshId);
  if (!sshReady) {
    return { enabled: false, reason: "ssh_not_connected", sshConnectionId: sshId };
  }

  try {
    const { slowLogOn, logFilePath } = await queryMysqlVariables(connection);
    if (!slowLogOn) {
      return { enabled: false, reason: "slow_log_off", sshConnectionId: sshId };
    }
    if (!logFilePath) {
      return { enabled: false, reason: "slow_log_file_missing", sshConnectionId: sshId };
    }

    const deployment = await probeMysqlDeployment(connection, sshConnections);
    const deploymentKind = deployment.kind === "docker" ? "docker" as const : "host" as const;
    const containerId = deployment.kind === "docker" ? deployment.containerId : undefined;
    return {
      enabled: true,
      sshConnectionId: sshId,
      logFilePath,
      deploymentKind,
      containerId,
    };
  } catch {
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

/** 通过 SSH 读取远端文件指定字节范围。 */
async function readMysqlSlowLogRangeSsh(
  sshConnectionId: string,
  logFilePath: string,
  start: number,
  length: number,
): Promise<string> {
  if (length <= 0) return "";
  const quoted = shellQuote(logFilePath);
  const offset = Math.max(1, Math.floor(start) + 1);
  const count = Math.max(1, Math.floor(length));
  const command = `tail -c +${offset} ${quoted} 2>/dev/null | head -c ${count}`;
  const res = await sshExec(sshConnectionId, command);
  const output = res.stdout;
  if (res.stderr.trim()) {
    return output || res.stderr;
  }
  return output;
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

/** 通过 docker exec 读取容器内文件指定字节范围。 */
async function readMysqlSlowLogRangeDocker(
  sshConnectionId: string,
  containerId: string,
  logFilePath: string,
  start: number,
  length: number,
): Promise<string> {
  if (length <= 0) return "";
  const cont = shellQuote(containerId);
  const file = shellQuote(logFilePath);
  const offset = Math.max(1, Math.floor(start) + 1);
  const count = Math.max(1, Math.floor(length));
  const command =
    `docker exec ${cont} sh -c "tail -c +${offset} ${file} 2>/dev/null | head -c ${count}"`;
  const res = await sshExec(sshConnectionId, command);
  const output = res.stdout;
  if (res.stderr.trim()) {
    return output || res.stderr;
  }
  return output;
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

/** 读取慢查询日志指定字节范围（自动选择 SSH / Docker）。 */
export async function readMysqlSlowLogRange(
  sshConnectionId: string,
  logFilePath: string,
  start: number,
  length: number,
  deploymentKind?: "host" | "docker",
  containerId?: string,
): Promise<string> {
  if (deploymentKind === "docker" && containerId) {
    return readMysqlSlowLogRangeDocker(sshConnectionId, containerId, logFilePath, start, length);
  }
  return readMysqlSlowLogRangeSsh(sshConnectionId, logFilePath, start, length);
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
