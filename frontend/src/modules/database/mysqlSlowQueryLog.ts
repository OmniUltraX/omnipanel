import { invoke } from "@tauri-apps/api/core";
import { commands } from "../../ipc/bindings";
import type { Connection } from "../../ipc/bindings";
import { parseSshConfig } from "../server/panel/serverConnection";
import { useSshConnectionStore } from "../../stores/sshConnectionStore";
import { acquireSshPoolSession, releaseSshPoolSession } from "../../stores/sshPoolSessionStore";
import { useTerminalStore } from "../../stores/terminalStore";
import type { DbConnectionConfig } from "./api";
import { isMysqlConnectionInfoCapable } from "./api";
import { makeQueryRunId } from "./sql/queryRun";
import type { QueryResult } from "./workspace/dbWorkspaceState";
import { rowsToRecord } from "./workspace/dbWorkspaceState";

const LOCALHOST_ALIASES = new Set(["localhost", "127.0.0.1", "::1"]);

/** 单次从日志文件尾部读取的字节数（慢查询日志可能很大，默认只读尾部）。 */
export const MYSQL_SLOW_LOG_CHUNK_BYTES = 512 * 1024;

export type SlowLogAvailability = {
  enabled: boolean;
  reason?: string;
  sshConnectionId?: string;
  logFilePath?: string;
};

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

export function hostsMatch(dbHost: string, sshHost: string): boolean {
  const a = normalizeHost(dbHost);
  const b = normalizeHost(sshHost);
  if (a === b) return true;
  return LOCALHOST_ALIASES.has(a) && LOCALHOST_ALIASES.has(b);
}

/** 按数据库连接 host 查找匹配的 SSH 连接（同主机名 / localhost 等价）。 */
export function findSshConnectionForDbHost(
  sshConnections: Connection[],
  dbHost: string,
): Connection | undefined {
  return sshConnections.find((conn) => {
    if (conn.kind !== "ssh") return false;
    const cfg = parseSshConfig(conn);
    return cfg ? hostsMatch(dbHost, cfg.host) : false;
  });
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

/** 同步解析数据库 host 对应的 SSH 主机名（无匹配则 undefined）。 */
export function getMatchedSshHostSync(
  sshConnections: Connection[],
  dbHost: string,
): string | undefined {
  const ssh = findSshConnectionForDbHost(sshConnections, dbHost);
  if (!ssh) {
    return undefined;
  }
  const host = parseSshConfig(ssh)?.host?.trim();
  return host || undefined;
}

function isLocalDbHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return !normalized || LOCALHOST_ALIASES.has(normalized);
}

/** 确保 SSH 连接池会话可用；已在线则直接返回 true。 */
export async function ensureSshReady(sshConnectionId: string): Promise<boolean> {
  const id = sshConnectionId.trim();
  if (!id) {
    return false;
  }
  if (isSshConnectionEstablished(id)) {
    return true;
  }

  acquireSshPoolSession(id);
  try {
    const res = await commands.sshPoolExecCommand(id, "true");
    if (res.status !== "ok") {
      releaseSshPoolSession(id);
      return false;
    }
    useSshConnectionStore.getState().setSessionActive(id, true);
    return true;
  } catch {
    releaseSshPoolSession(id);
    return false;
  }
}

/** Schema 缓存刷新前：为远程数据库连接预热匹配的 SSH 会话。 */
export async function reestablishSshForDbConnection(
  connection: DbConnectionConfig,
  sshConnections: Connection[],
): Promise<void> {
  if (connection.enabled === false || isLocalDbHost(connection.host)) {
    return;
  }
  const ssh = findSshConnectionForDbHost(sshConnections, connection.host);
  if (!ssh) {
    return;
  }
  await ensureSshReady(ssh.id);
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
  const ssh = findSshConnectionForDbHost(sshConnections, connection.host);
  if (!ssh) {
    return { enabled: false, reason: "no_ssh" };
  }
  if (!isSshConnectionEstablished(ssh.id)) {
    return { enabled: false, reason: "ssh_not_connected", sshConnectionId: ssh.id };
  }
  return { enabled: false, reason: "checking", sshConnectionId: ssh.id };
}

/** 异步探测慢查询日志是否开启，并返回日志文件路径。 */
export async function probeSlowLogAvailability(
  connection: DbConnectionConfig,
  sshConnections: Connection[],
): Promise<SlowLogAvailability> {
  const sync = resolveSlowLogAvailabilitySync(connection, sshConnections);
  if (sync.reason === "not_mysql" || sync.reason === "no_ssh" || sync.reason === "ssh_not_connected") {
    return sync;
  }
  const sshId = sync.sshConnectionId;
  if (!sshId) {
    return { enabled: false, reason: "no_ssh" };
  }
  if (!isConnectionEnabledForProbe(connection)) {
    return { enabled: false, reason: "connection_disabled", sshConnectionId: sshId };
  }
  try {
    const { slowLogOn, logFilePath } = await queryMysqlVariables(connection);
    if (!slowLogOn) {
      return { enabled: false, reason: "slow_log_off", sshConnectionId: sshId };
    }
    if (!logFilePath) {
      return { enabled: false, reason: "slow_log_file_missing", sshConnectionId: sshId };
    }
    return { enabled: true, sshConnectionId: sshId, logFilePath };
  } catch {
    return { enabled: false, reason: "probe_failed", sshConnectionId: sshId };
  }
}

function isConnectionEnabledForProbe(connection: DbConnectionConfig): boolean {
  return connection.enabled !== false;
}

/** 读取慢查询日志尾部若干字节（通过 SSH）。 */
export async function readMysqlSlowLogTail(
  sshConnectionId: string,
  logFilePath: string,
  maxBytes: number,
): Promise<string> {
  const quoted = shellQuote(logFilePath);
  const command = `tail -c ${Math.max(1, Math.floor(maxBytes))} ${quoted} 2>/dev/null || true`;
  const res = await commands.sshPoolExecCommand(sshConnectionId, command);
  if (res.status !== "ok") {
    throw new Error(res.error.message);
  }
  const output = res.data.stdout;
  if (res.data.stderr.trim()) {
    return output || res.data.stderr;
  }
  return output;
}

/** 获取远端日志文件大小（字节）。 */
export async function readMysqlSlowLogFileSize(
  sshConnectionId: string,
  logFilePath: string,
): Promise<number> {
  const quoted = shellQuote(logFilePath);
  const command = `stat -c %s ${quoted} 2>/dev/null || wc -c < ${quoted}`;
  const res = await commands.sshPoolExecCommand(sshConnectionId, command);
  if (res.status !== "ok") {
    throw new Error(res.error.message);
  }
  const raw = res.data.stdout.trim().split(/\s+/)[0] ?? "0";
  const size = Number.parseInt(raw, 10);
  return Number.isFinite(size) && size >= 0 ? size : 0;
}
