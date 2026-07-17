import { commands } from "../../ipc/bindings";
import type { Connection, DbConnectionConfig as BindingsDbConnectionConfig } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import type { DbConnectionConfig } from "./api";
import { isMysqlConnectionInfoCapable } from "./api";
import { makeQueryRunId } from "./sql/queryRun";
import { rowsToRecord } from "./workspace/dbWorkspaceState";
import { probeMysqlDeployment } from "./mysqlDeploymentDetect";
import {
  ensureSshExecReady,
  findSshConnectionForDbHost,
  findSshConnectionForDbHostSync,
  hostsMatch,
} from "./mysqlSlowQueryLog";
import { parseSshConfig } from "../server/panel/serverConnection";

function ipcConn(connection: DbConnectionConfig): BindingsDbConnectionConfig {
  return connection as BindingsDbConnectionConfig;
}

/** 官方 my2sql Linux x86_64 二进制（仓库内置，无 GitHub Releases）。 */
export const MY2SQL_DOWNLOAD_URL =
  "https://raw.githubusercontent.com/liuhr/my2sql/master/releases/centOS_release_7.x/my2sql";

/** 默认安装路径（用户目录，无需 sudo）。 */
export const MY2SQL_REMOTE_INSTALL_PATH = "~/.omnipanel/bin/my2sql";

const LOCALHOST_ALIASES = new Set(["localhost", "127.0.0.1", "::1"]);

/** 时间线输出上限（字节），避免 SSH 一次性塞满内存。 */
const TIMELINE_OUTPUT_BYTES = 2 * 1024 * 1024;

export type BinlogAvailability = {
  enabled: boolean;
  reason?: string;
  sshConnectionId?: string;
  deploymentKind?: "host" | "docker";
  containerId?: string;
  logBinOn?: boolean;
  binlogFormat?: string;
  binlogRowImage?: string;
  logBinBasename?: string;
  flashbackCapable?: boolean;
};

export type BinlogFileInfo = {
  name: string;
  size: number;
};

export type BinlogFileTimes = {
  /** 文件创建时间；Linux 文件系统不支持时为 undefined。 */
  createdAt?: Date;
  modifiedAt?: Date;
};

export type FlashbackToolKind = "my2sql" | "binlog2sql";

export type FlashbackToolResolution =
  | { status: "ready"; kind: FlashbackToolKind; command: string }
  | { status: "need_install"; remoteOs?: string; remoteArch?: string }
  | { status: "unavailable"; reason: string };

export type BinlogDmlKind = "INSERT" | "UPDATE" | "DELETE" | "OTHER";

export type BinlogTimelineEvent = {
  id: string;
  kind: BinlogDmlKind;
  time: string;
  database: string;
  table: string;
  binlogFile: string;
  startPos: number;
  stopPos: number;
  summary: string;
  sql: string;
};

function shellQuote(value: string | null | undefined): string {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

async function sshExec(
  sshConnectionId: string,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const res = await commands.sshPoolExecCommand(sshConnectionId, command);
  if (res.status !== "ok") {
    throw new Error(res.error.message);
  }
  return {
    stdout: res.data.stdout ?? "",
    stderr: res.data.stderr ?? "",
    exitCode: res.data.exitCode ?? 1,
  };
}

function isTruthyMysqlVar(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === "on" || v === "1" || v === "yes" || v === "true";
}

function isRemoteMysqlHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return Boolean(normalized) && !LOCALHOST_ALIASES.has(normalized);
}

async function queryMysqlBinlogVariables(
  connection: DbConnectionConfig,
): Promise<{
  logBinOn: boolean;
  binlogFormat: string;
  binlogRowImage: string;
  logBinBasename: string;
  binlogEncryption: string;
}> {
  const res = await unwrapCommand(
    commands.dbExecuteQuery(
      ipcConn(connection),
      "SHOW VARIABLES WHERE Variable_name IN ('log_bin','binlog_format','binlog_row_image','log_bin_basename','binlog_encryption')",
      makeQueryRunId(),
      null,
      null,
    ),
  );
  const rows = rowsToRecord(res.columns, res.rows);
  const read = (name: string) =>
    String(rows.find((row) => row.Variable_name === name)?.Value ?? "").trim();
  return {
    logBinOn: isTruthyMysqlVar(read("log_bin")),
    binlogFormat: read("binlog_format").toUpperCase() || "UNKNOWN",
    binlogRowImage: read("binlog_row_image").toUpperCase() || "UNKNOWN",
    logBinBasename: read("log_bin_basename"),
    binlogEncryption: read("binlog_encryption"),
  };
}

/** 同步探测：远程 MySQL 在异步完成前返回 checking。 */
export function resolveBinlogAvailabilitySync(
  connection: DbConnectionConfig,
  sshConnections: Connection[],
): BinlogAvailability {
  if (!isMysqlConnectionInfoCapable(connection)) {
    return { enabled: false, reason: "not_mysql" };
  }
  if (connection.enabled === false) {
    return { enabled: false, reason: "connection_disabled" };
  }
  const ssh = findSshConnectionForDbHostSync(sshConnections, connection.host);
  if (!ssh) {
    if (isRemoteMysqlHost(connection.host)) {
      return { enabled: false, reason: "checking" };
    }
    return { enabled: false, reason: "no_ssh" };
  }
  return {
    enabled: false,
    reason: "checking",
    sshConnectionId: ssh.id,
  };
}

/** 异步探测 binlog 是否可用。 */
export async function probeBinlogAvailability(
  connection: DbConnectionConfig,
  sshConnections: Connection[],
): Promise<BinlogAvailability> {
  if (!isMysqlConnectionInfoCapable(connection)) {
    return { enabled: false, reason: "not_mysql" };
  }
  if (connection.enabled === false) {
    return { enabled: false, reason: "connection_disabled" };
  }

  const ssh = await findSshConnectionForDbHost(sshConnections, connection.host);
  if (!ssh) {
    return { enabled: false, reason: "no_ssh" };
  }
  const sshId = ssh.id;
  const sshReady = await ensureSshExecReady(sshId, connection, sshConnections);
  if (!sshReady) {
    return { enabled: false, reason: "ssh_not_connected", sshConnectionId: sshId };
  }

  try {
    const vars = await queryMysqlBinlogVariables(connection);
    if (!vars.logBinOn) {
      return {
        enabled: false,
        reason: "binlog_off",
        sshConnectionId: sshId,
        logBinOn: false,
      };
    }
    if (isTruthyMysqlVar(vars.binlogEncryption)) {
      return {
        enabled: false,
        reason: "binlog_encrypted",
        sshConnectionId: sshId,
        logBinOn: true,
      };
    }

    const deployment = await probeMysqlDeployment(connection, sshConnections);
    const deploymentKind = deployment.kind === "docker" ? ("docker" as const) : ("host" as const);
    const containerId = deployment.kind === "docker" ? deployment.containerId : undefined;

    const flashbackCapable =
      vars.binlogFormat === "ROW" &&
      (vars.binlogRowImage === "FULL" || vars.binlogRowImage === "");

    return {
      enabled: true,
      sshConnectionId: sshId,
      deploymentKind,
      containerId,
      logBinOn: true,
      binlogFormat: vars.binlogFormat,
      binlogRowImage: vars.binlogRowImage,
      logBinBasename: vars.logBinBasename,
      flashbackCapable,
    };
  } catch {
    return { enabled: false, reason: "probe_failed", sshConnectionId: sshId };
  }
}

/** 列出二进制日志文件。 */
export async function listBinaryLogs(
  connection: DbConnectionConfig,
): Promise<BinlogFileInfo[]> {
  const res = await unwrapCommand(
    commands.dbExecuteQuery(ipcConn(connection), "SHOW BINARY LOGS", makeQueryRunId(), null, null),
  );
  const rows = rowsToRecord(res.columns, res.rows);
  return rows
    .map((row) => {
      const name = String(row.Log_name ?? row.log_name ?? "").trim();
      const sizeRaw = row.File_size ?? row.file_size ?? 0;
      const size = typeof sizeRaw === "number" ? sizeRaw : Number.parseInt(String(sizeRaw), 10);
      return { name, size: Number.isFinite(size) ? size : 0 };
    })
    .filter((f) => f.name.length > 0);
}

export function resolveMysqlbinlogPath(
  logBinBasename: string | undefined,
  logFileName: string,
): string {
  const base = (logBinBasename ?? "").trim();
  if (!base) return logFileName;
  if (base.includes("/")) {
    const dir = base.slice(0, base.lastIndexOf("/") + 1);
    return `${dir}${logFileName}`;
  }
  return logFileName;
}

/** 读取 binlog 文件创建/修改时间；容器场景从容器内读取。 */
export async function getBinlogFileTimes(params: {
  sshConnectionId: string;
  logFilePath: string;
  deploymentKind?: "host" | "docker";
  containerId?: string;
}): Promise<BinlogFileTimes> {
  const { sshConnectionId, logFilePath, deploymentKind, containerId } = params;
  const statCommand = `stat -c '%W %Y' ${shellQuote(logFilePath)} 2>/dev/null`;
  const command =
    deploymentKind === "docker" && containerId
      ? `docker exec ${shellQuote(containerId)} sh -c ${shellQuote(statCommand)}`
      : statCommand;
  const res = await sshExec(sshConnectionId, command);
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || "读取二进制日志文件时间失败");
  }
  const [createdRaw, modifiedRaw] = res.stdout.trim().split(/\s+/, 2);
  const toDate = (raw: string | undefined): Date | undefined => {
    const seconds = Number.parseInt(raw ?? "", 10);
    // GNU stat 在 birth time 不可用时返回 0 或 -1。
    return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : undefined;
  };
  return {
    createdAt: toDate(createdRaw),
    modifiedAt: toDate(modifiedRaw),
  };
}

/** 探测闪回工具：my2sql → binlog2sql → 需安装。 */
export async function resolveFlashbackTool(
  sshConnectionId: string,
): Promise<FlashbackToolResolution> {
  const probe = await sshExec(
    sshConnectionId,
    [
      `if [ -x "$HOME/.omnipanel/bin/my2sql" ]; then echo MY2SQL:$HOME/.omnipanel/bin/my2sql;`,
      `elif command -v my2sql >/dev/null 2>&1; then echo MY2SQL:$(command -v my2sql);`,
      `elif command -v binlog2sql >/dev/null 2>&1; then echo B2S:$(command -v binlog2sql);`,
      `elif [ -f "$HOME/binlog2sql/binlog2sql.py" ]; then echo B2S:python3 $HOME/binlog2sql/binlog2sql.py;`,
      `else echo NONE; fi`,
      `uname -s; uname -m`,
    ].join("\n"),
  );
  const lines = probe.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const toolLine = lines[0] ?? "NONE";
  const remoteOs = lines[1];
  const remoteArch = lines[2];

  if (toolLine.startsWith("MY2SQL:")) {
    return { status: "ready", kind: "my2sql", command: toolLine.slice("MY2SQL:".length).trim() };
  }
  if (toolLine.startsWith("B2S:")) {
    return { status: "ready", kind: "binlog2sql", command: toolLine.slice("B2S:".length).trim() };
  }
  return { status: "need_install", remoteOs, remoteArch };
}

/** 本机下载 my2sql 并 SFTP 安装；失败则远端 curl 回退。 */
export async function installRemoteMy2sql(sshConnectionId: string): Promise<string> {
  try {
    return await unwrapCommand(
      commands.sshPoolDownloadInstallBinary(
        sshConnectionId,
        MY2SQL_DOWNLOAD_URL,
        MY2SQL_REMOTE_INSTALL_PATH,
      ),
    );
  } catch (localErr) {
    const quotedUrl = shellQuote(MY2SQL_DOWNLOAD_URL);
    const installCmd = [
      `mkdir -p "$HOME/.omnipanel/bin"`,
      `&& (curl -fsSL ${quotedUrl} -o "$HOME/.omnipanel/bin/my2sql" || wget -qO "$HOME/.omnipanel/bin/my2sql" ${quotedUrl})`,
      `&& chmod 755 "$HOME/.omnipanel/bin/my2sql"`,
      `&& printf %s "$HOME/.omnipanel/bin/my2sql"`,
    ].join(" ");
    const res = await sshExec(sshConnectionId, installCmd);
    const path = res.stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
    if (res.exitCode !== 0 || !path) {
      const detail =
        res.stderr.trim() ||
        (localErr instanceof Error ? localErr.message : String(localErr));
      throw new Error(`安装 my2sql 失败：${detail}`);
    }
    return path;
  }
}

function my2sqlConnectHost(
  connection: DbConnectionConfig,
  sshConnections: Connection[],
  sshConnectionId: string,
): string {
  const ssh = sshConnections.find((c) => c.id === sshConnectionId);
  const cfg = ssh ? parseSshConfig(ssh) : null;
  if (cfg && hostsMatch(connection.host, cfg.host, cfg.publicIp)) {
    return "127.0.0.1";
  }
  return connection.host.trim() || "127.0.0.1";
}

function detectDmlKind(sql: string): BinlogDmlKind {
  const head = sql.trim().slice(0, 12).toUpperCase();
  if (head.startsWith("INSERT")) return "INSERT";
  if (head.startsWith("UPDATE")) return "UPDATE";
  if (head.startsWith("DELETE")) return "DELETE";
  return "OTHER";
}

/** 按逗号拆分 SQL 列表，忽略引号 / 括号内的逗号。 */
function splitSqlList(input: string | null | undefined): string[] {
  if (input == null || input === "") return [];
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | "`" | null = null;
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      cur += c;
      if (c === "\\" && i + 1 < input.length) {
        cur += input[++i];
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "(") {
      depth += 1;
      cur += c;
      continue;
    }
    if (c === ")") {
      depth -= 1;
      cur += c;
      continue;
    }
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 按 AND 拆分 WHERE，忽略引号内内容。 */
function splitWhereAnd(input: string | null | undefined): string[] {
  if (input == null || input === "") return [];
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | "`" | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      cur += c;
      if (c === "\\" && i + 1 < input.length) {
        cur += input[++i];
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if (/^and\b/i.test(input.slice(i))) {
      out.push(cur.trim());
      cur = "";
      i += 2; // 跳过 AN，for 循环再 +1 跳过 D
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseAssign(expr: string): { col: string; value: string } | null {
  const m = expr
    .trim()
    .match(/^(?:`([^`]+)`|'([^']+)'|"([^"]+)"|([A-Za-z_][\w$]*))\s*=\s*([\s\S]+)$/);
  if (!m) return null;
  const rawCol = m[1] ?? m[2] ?? m[3] ?? m[4];
  if (!rawCol) return null;
  return { col: `\`${rawCol}\``, value: m[5].trim() };
}

/** 正向 DELETE 的 WHERE 谓词数量（用于判断是否只有主键）。 */
export function countDeleteWherePredicates(sql: string | null | undefined): number {
  if (!sql) return 0;
  const m = sql.trim().match(/^DELETE\s+FROM\s+(.+)\s+WHERE\s+([\s\S]+)$/i);
  if (!m) return 0;
  return splitWhereAnd(m[2]).filter(Boolean).length;
}

/** INSERT 列数（闪回还原 DELETE 时用于判断是否缺列）。 */
export function countInsertColumns(sql: string | null | undefined): number {
  if (!sql) return 0;
  const m = sql.trim().match(/^INSERT\s+INTO\s+.+?\s*\(([^)]+)\)\s*VALUES/i);
  if (!m) return 0;
  return splitSqlList(m[1]).length;
}

/**
 * 正向 DELETE 是否明显缺少行镜像（常见于 binlog_row_image=MINIMAL，
 * 或 2sql 仅输出主键 WHERE）。此类事件本地反转只能得到「只有主键的 INSERT」。
 */
export function isSparseDeleteForward(sql: string | null | undefined): boolean {
  return countDeleteWherePredicates(sql) <= 1;
}

/** 闪回 INSERT 是否仍只有极少列（说明 binlog 里就没有完整旧行）。 */
export function isSparseFlashbackInsert(sql: string | null | undefined): boolean {
  return countInsertColumns(sql) <= 1;
}

/** 选中事件是否都能本地反转（无需再跑 my2sql rollback）。 */
export function canBuildFlashbackLocally(events: BinlogTimelineEvent[]): boolean {
  return (
    events.length > 0 &&
    events.every((ev) => Boolean(invertForwardSql(ev.sql ?? "", ev.kind)))
  );
}

/** @deprecated 使用 canBuildFlashbackLocally；仅 DELETE/UPDATE 不再无条件走远程 */
export function selectionNeedsRemoteRollback(events: BinlogTimelineEvent[]): boolean {
  return !canBuildFlashbackLocally(events);
}

export const SPARSE_DELETE_FLASHBACK_HINT =
  "该 DELETE 的正向 SQL 几乎只有主键条件，说明 binlog 行镜像未包含完整列值（写入时多为 binlog_row_image=MINIMAL）。日志里没有其他字段，无法还原完整 INSERT。请将 binlog_row_image 设为 FULL 后，对新产生的删除再做闪回。";

export const INCOMPLETE_UPDATE_FLASHBACK_HINT =
  "该 UPDATE 的正向 SQL 中 WHERE 缺少被修改列的旧值，无法本地生成完整闪回；且 my2sql 未能从 binlog 生成回滚 SQL。请确认写入时 binlog_row_image=FULL。";

/**
 * 将时间线已解析的正向 SQL 反转为闪回 SQL。
 * - INSERT→DELETE：正向已含全部列，本地反转可靠
 * - DELETE→INSERT：仅当 WHERE 含多列（FULL 镜像）时才本地反转
 * - UPDATE：每个 SET 列须在 WHERE 中带有旧值（FULL）
 */
export function invertForwardSql(sql: string, kind?: BinlogDmlKind): string | null {
  const trimmed = (sql ?? "").trim().replace(/;+\s*$/, "");
  if (!trimmed) return null;
  const dml = kind && kind !== "OTHER" ? kind : detectDmlKind(trimmed);

  if (dml === "INSERT") {
    const m = trimmed.match(
      /^INSERT\s+INTO\s+(.+?)\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]+)\)$/i,
    );
    if (!m) return null;
    const table = m[1].trim();
    const cols = splitSqlList(m[2]);
    const vals = splitSqlList(m[3]);
    if (cols.length === 0 || cols.length !== vals.length) return null;
    const where = cols.map((c, i) => `${c}=${vals[i]}`).join(" AND ");
    return `DELETE FROM ${table} WHERE ${where} LIMIT 1`;
  }

  if (dml === "DELETE") {
    if (isSparseDeleteForward(trimmed)) {
      return null;
    }
    const m = trimmed.match(/^DELETE\s+FROM\s+(.+)\s+WHERE\s+([\s\S]+)$/i);
    if (!m) return null;
    const table = m[1].trim();
    const preds = splitWhereAnd(m[2]);
    const assigns = preds.map(parseAssign).filter((x): x is { col: string; value: string } => x != null);
    if (assigns.length === 0 || assigns.length !== preds.length) return null;
    const cols = assigns.map((a) => a.col).join(",");
    const vals = assigns.map((a) => a.value).join(",");
    return `INSERT INTO ${table}(${cols}) VALUES (${vals})`;
  }

  if (dml === "UPDATE") {
    // 表名用贪婪匹配，避免 `db`.`tbl` 被 .+? 截断导致整句失配
    const m = trimmed.match(/^UPDATE\s+(.+)\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)$/i);
    if (!m) return null;
    const table = m[1].trim();
    const setParts = splitSqlList(m[2]).map(parseAssign);
    const whereParts = splitWhereAnd(m[3]).map(parseAssign);
    if (setParts.some((x) => !x) || whereParts.some((x) => !x)) return null;
    const sets = setParts as Array<{ col: string; value: string }>;
    const wheres = whereParts as Array<{ col: string; value: string }>;
    const whereMap = new Map(wheres.map((w) => [w.col.replace(/`/g, "").toLowerCase(), w]));
    const setMap = new Map(sets.map((s) => [s.col.replace(/`/g, "").toLowerCase(), s]));

    // SET 中每个列都必须在 WHERE 里有旧值，否则无法还原
    const missingOld = sets.filter(
      (s) => !whereMap.has(s.col.replace(/`/g, "").toLowerCase()),
    );
    if (missingOld.length > 0) return null;

    const rollSet = sets.map((s) => {
      const key = s.col.replace(/`/g, "").toLowerCase();
      const old = whereMap.get(key)!;
      return `${s.col}=${old.value}`;
    });
    const rollWhere = wheres.map((w) => {
      const key = w.col.replace(/`/g, "").toLowerCase();
      const neu = setMap.get(key);
      return `${w.col}=${neu ? neu.value : w.value}`;
    });
    return `UPDATE ${table} SET ${rollSet.join(", ")} WHERE ${rollWhere.join(" AND ")}`;
  }

  return null;
}

/** 由选中时间线事件本地生成闪回 SQL（适合全部为 INSERT，或 DELETE 已含完整 WHERE）。 */
export function buildFlashbackSqlFromEvents(events: BinlogTimelineEvent[]): string {
  if (events.length === 0) {
    throw new Error("请先选中要闪回的变更事件");
  }
  const sparseDeletes = events.filter(
    (ev) => ev.kind === "DELETE" && isSparseDeleteForward(ev.sql),
  );
  if (sparseDeletes.length > 0) {
    throw new Error(SPARSE_DELETE_FLASHBACK_HINT);
  }

  const ordered = [...events].sort((a, b) => {
    if (a.binlogFile !== b.binlogFile) return b.binlogFile.localeCompare(a.binlogFile);
    return b.startPos - a.startPos;
  });
  const parts: string[] = [];
  const failed: string[] = [];
  for (const ev of ordered) {
    const inverted = invertForwardSql(ev.sql, ev.kind);
    if (!inverted) {
      failed.push(`${ev.binlogFile}:${ev.startPos} (${ev.kind})`);
      continue;
    }
    parts.push(
      `# datetime=${(ev.time ?? "").replace(" ", "_")} database=${ev.database} table=${ev.table} binlog=${ev.binlogFile} startpos=${ev.startPos} stoppos=${ev.stopPos}`,
    );
    parts.push(`${inverted};`);
  }
  if (parts.length === 0) {
    throw new Error(
      failed.some((f) => f.includes("DELETE"))
        ? SPARSE_DELETE_FLASHBACK_HINT
        : `无法从正向 SQL 生成闪回（${failed.slice(0, 3).join(", ")}）。请确认事件含完整 ROW 图像`,
    );
  }
  if (failed.length > 0) {
    parts.push(`# 以下 ${failed.length} 条未能自动反转: ${failed.join(", ")}`);
  }
  return parts.join("\n");
}

/**
 * 检查 rollback 输出是否仍缺列（相对选中的稀疏 DELETE）。
 * 若 my2sql 也只能吐出单列 INSERT，说明 binlog 本身无完整旧行。
 */
export function assertFlashbackCoversSparseDeletes(
  flashbackSql: string,
  selected: BinlogTimelineEvent[],
): void {
  const sparse = selected.filter(
    (ev) => ev.kind === "DELETE" && isSparseDeleteForward(ev.sql),
  );
  if (sparse.length === 0) return;

  const inserts = flashbackSql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => /^INSERT\b/i.test(s.replace(/^#.*$/gm, "").trim()));

  const stillSparse =
    inserts.length === 0 ||
    inserts.every((stmt) => {
      const body = stmt
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"))
        .join("\n");
      return isSparseFlashbackInsert(body);
    });

  if (stillSparse) {
    throw new Error(SPARSE_DELETE_FLASHBACK_HINT);
  }
}

function normalizeMy2sqlDatetime(raw: string): string {
  // my2sql: 2020-07-16_10:44:09 → 2020-07-16 10:44:09
  return raw.replace("_", " ").trim();
}

/**
 * 解析 my2sql -add-extraInfo 输出。
 * 格式示例：
 * # datetime=2020-07-16_10:44:09 database=db table=tb binlog=mysql-bin.000001 startpos=15552 stoppos=15773
 * UPDATE `db`.`tb` SET ...
 */
export function parseMy2sqlExtraInfoOutput(text: string): BinlogTimelineEvent[] {
  const events: BinlogTimelineEvent[] = [];
  const lines = text.split(/\r?\n/);
  let pendingMeta: {
    time: string;
    database: string;
    table: string;
    binlogFile: string;
    startPos: number;
    stopPos: number;
  } | null = null;
  let sqlBuf: string[] = [];

  const flush = () => {
    if (!pendingMeta || sqlBuf.length === 0) {
      pendingMeta = null;
      sqlBuf = [];
      return;
    }
    const sql = sqlBuf.join("\n").trim().replace(/;+\s*$/, "");
    if (!sql || sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      pendingMeta = null;
      sqlBuf = [];
      return;
    }
    const kind = detectDmlKind(sql);
    if (kind === "OTHER") {
      pendingMeta = null;
      sqlBuf = [];
      return;
    }
    const id = `${pendingMeta.binlogFile}:${pendingMeta.startPos}:${pendingMeta.stopPos}:${events.length}`;
    events.push({
      id,
      kind,
      time: pendingMeta.time,
      database: pendingMeta.database,
      table: pendingMeta.table,
      binlogFile: pendingMeta.binlogFile,
      startPos: pendingMeta.startPos,
      stopPos: pendingMeta.stopPos,
      summary: sql.replace(/\s+/g, " ").slice(0, 200),
      sql,
    });
    pendingMeta = null;
    sqlBuf = [];
  };

  for (const line of lines) {
    const metaMatch = line.match(
      /^#\s*datetime=(\S+)\s+database=(\S+)\s+table=(\S+)\s+binlog=(\S+)\s+startpos=(\d+)\s+stoppos=(\d+)/i,
    );
    if (metaMatch) {
      flush();
      pendingMeta = {
        time: normalizeMy2sqlDatetime(metaMatch[1]),
        database: metaMatch[2],
        table: metaMatch[3],
        binlogFile: metaMatch[4],
        startPos: Number.parseInt(metaMatch[5], 10),
        stopPos: Number.parseInt(metaMatch[6], 10),
      };
      continue;
    }
    if (!pendingMeta) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    sqlBuf.push(line);
  }
  flush();
  return events;
}

type My2sqlRunOptions = {
  connection: DbConnectionConfig;
  sshConnectionId: string;
  sshConnections: Connection[];
  toolCommand: string;
  workType: "2sql" | "rollback";
  startFile: string;
  stopFile?: string;
  startPos?: number;
  stopPos?: number;
  startDatetime?: string;
  stopDatetime?: string;
  databases?: string;
  tables?: string;
  logBinBasename?: string;
  preferReplMode?: boolean;
  addExtraInfo?: boolean;
};

async function runMy2sql(options: My2sqlRunOptions): Promise<string> {
  const {
    connection,
    sshConnectionId,
    sshConnections,
    toolCommand,
    workType,
    startFile,
    stopFile,
    startPos,
    stopPos,
    startDatetime,
    stopDatetime,
    databases,
    tables,
    logBinBasename,
    preferReplMode,
    addExtraInfo,
  } = options;

  const host = my2sqlConnectHost(connection, sshConnections, sshConnectionId);
  const port = connection.port || 3306;
  const user = connection.user;
  const password = connection.password;
  const outDir = `/tmp/omnipanel-my2sql-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const binPath = resolveMysqlbinlogPath(logBinBasename, startFile);

  // stop-pos 必须搭配 stop-file 才可靠生效（liuhr/my2sql#25）
  const effectiveStopFile =
    stopFile?.trim() ||
    (typeof stopPos === "number" && Number.isFinite(stopPos) ? startFile.trim() : "");

  const buildArgs = (useRepl: boolean) => {
    const modeArgs = useRepl
      ? [`-mode repl`, `-start-file ${shellQuote(startFile)}`]
      : [
          `-mode file`,
          `-local-binlog-file ${shellQuote(binPath)}`,
          `-start-file ${shellQuote(startFile)}`,
        ];
    return [
      shellQuote(toolCommand),
      `-user ${shellQuote(user)}`,
      `-password ${shellQuote(password)}`,
      `-host ${shellQuote(host)}`,
      `-port ${port}`,
      ...modeArgs,
      `-work-type ${workType}`,
      effectiveStopFile ? `-stop-file ${shellQuote(effectiveStopFile)}` : "",
      typeof startPos === "number" && Number.isFinite(startPos) ? `-start-pos ${startPos}` : "",
      typeof stopPos === "number" && Number.isFinite(stopPos) ? `-stop-pos ${stopPos}` : "",
      startDatetime?.trim() ? `-start-datetime ${shellQuote(startDatetime.trim())}` : "",
      stopDatetime?.trim() ? `-stop-datetime ${shellQuote(stopDatetime.trim())}` : "",
      databases?.trim() ? `-databases ${shellQuote(databases.trim())}` : "",
      tables?.trim() ? `-tables ${shellQuote(tables.trim())}` : "",
      addExtraInfo ? `-add-extraInfo` : "",
      `-output-dir ${shellQuote(outDir)}`,
    ]
      .filter(Boolean)
      .join(" ");
  };

  const runOnce = async (useRepl: boolean) => {
    const args = buildArgs(useRepl);
    // my2sql 最终文件名：
    // - rollback.N.sql / forward.N.sql
    // - 或 {db}.{table}.rollback.N.sql（按表拆分时）
    // 临时文件以「.」开头（.rollback.N.sql），必须排除。
    // my2sql 进度日志打 stdout，必须重定向，否则会与 SQL 混进前端。
    const logPath = `${shellQuote(outDir)}/run.log`;
    const cmd = [
      `rm -rf ${shellQuote(outDir)} && mkdir -p ${shellQuote(outDir)}`,
      `&& set +e`,
      `&& ${args} >${logPath} 2>&1`,
      `&& ec_my=$?`,
      `&& set -e`,
      // 只取非隐藏的 *.sql（排除 .rollback.* 临时文件）
      `&& sql_out=$(ls -1 ${shellQuote(outDir)}/*.sql 2>/dev/null | grep -v '/\\.[^/]*$' | head -n 80)`,
      `&& sql_bytes=0`,
      `&& if [ -n "$sql_out" ]; then sql_bytes=$(cat $sql_out 2>/dev/null | wc -c | tr -d ' '); fi`,
      // exit=0 但写出空文件时也视为失败（常见于 start-pos 落在 RowsEvent 上）
      // 诊断信息写到 stdout：部分 SSH 路径对 stderr ExtendedData 捕获不完整
      `&& if [ -z "$sql_out" ] || [ "\${sql_bytes:-0}" -lt 8 ] || [ "$ec_my" -ne 0 ]; then`,
      `  echo "my2sql 未写出 SQL 文件 (exit=$ec_my, bytes=\${sql_bytes:-0})";`,
      `  echo "----- my2sql log -----";`,
      `  tail -n 80 ${logPath};`,
      `  echo "----- output dir -----";`,
      `  ls -la ${shellQuote(outDir)};`,
      `  rm -rf ${shellQuote(outDir)};`,
      `  exit 1;`,
      `fi`,
      `&& cat $sql_out | head -c ${TIMELINE_OUTPUT_BYTES}`,
      `; ec=$?; rm -rf ${shellQuote(outDir)}; exit $ec`,
    ].join(" ");
    return sshExec(sshConnectionId, cmd);
  };

  let res = await runOnce(Boolean(preferReplMode));
  let output = stripMy2sqlLogNoise(res.stdout);

  if ((!output || res.exitCode !== 0) && !preferReplMode) {
    res = await runOnce(true);
    output = stripMy2sqlLogNoise(res.stdout);
  }

  if (!output || res.exitCode !== 0) {
    // 失败时保留 run.log 原文（含 [info]/error]），便于定位
    const detail = ((res.stderr ?? "").trim() || (res.stdout ?? "").trim()).slice(0, 2000);
    throw new Error(
      detail ||
        (workType === "rollback"
          ? "my2sql 未生成回滚 SQL（请确认时间范围、position 与 ROW/FULL）"
          : "my2sql 未解析出变更事件（请确认时间范围与筛选条件）"),
    );
  }

  if (workType === "rollback" && !/(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(output)) {
    throw new Error(
      "my2sql 未生成有效回滚 SQL（输出不含 DML）。请确认选中范围、ROW/FULL，或缩小时间窗后重试",
    );
  }
  return output;
}

/** 去掉 my2sql seelog 风格进度行，避免污染 SQL 结果。 */
function stripMy2sqlLogNoise(text: string): string {
  if (!text) return "";
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      // [2026/07/16 17:36:34] [info] events.go:270 ...
      if (
        /^\[\d{4}[/-]\d{2}[/-]\d{2}[\sT]\d{2}:\d{2}:\d{2}(?:\.\d+)?]\s*\[(info|error|warn|debug|trace)]/i.test(
          trimmed,
        )
      ) {
        return false;
      }
      if (/^\[(info|error|warn|debug|trace)]\s+/i.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

export type LoadBinlogTimelineParams = {
  connection: DbConnectionConfig;
  sshConnectionId: string;
  sshConnections: Connection[];
  tool: Extract<FlashbackToolResolution, { status: "ready" }>;
  startFile: string;
  stopFile?: string;
  startDatetime?: string;
  stopDatetime?: string;
  databases?: string;
  tables?: string;
  logBinBasename?: string;
  preferReplMode?: boolean;
};

/** 用 my2sql 2sql + extraInfo 加载变更时间线。 */
export async function loadBinlogTimeline(
  params: LoadBinlogTimelineParams,
): Promise<BinlogTimelineEvent[]> {
  if (params.tool.kind !== "my2sql") {
    throw new Error("变更时间线需要 my2sql；当前仅检测到 binlog2sql，请安装 my2sql");
  }
  const text = await runMy2sql({
    connection: params.connection,
    sshConnectionId: params.sshConnectionId,
    sshConnections: params.sshConnections,
    toolCommand: params.tool.command,
    workType: "2sql",
    startFile: params.startFile,
    stopFile: params.stopFile,
    startDatetime: params.startDatetime,
    stopDatetime: params.stopDatetime,
    databases: params.databases,
    tables: params.tables,
    logBinBasename: params.logBinBasename,
    preferReplMode: params.preferReplMode,
    addExtraInfo: true,
  });
  return parseMy2sqlExtraInfoOutput(text);
}

/** 默认时间片：30 分钟；长区间按片后台加载，优先最新片。 */
export const BINLOG_TIMELINE_CHUNK_MS = 30 * 60 * 1000;

function parseMysqlDatetime(value: string): Date | null {
  const trimmed = value.trim().replace("T", " ");
  const m = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!m) return null;
  const date = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? "0"),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatMysqlDatetime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 将起止时间切成固定时长窗口。
 * 返回顺序为时间正序；调用方可 reverse 后「最新优先」加载。
 */
export function splitDatetimeRange(
  startDatetime?: string,
  stopDatetime?: string,
  chunkMs: number = BINLOG_TIMELINE_CHUNK_MS,
): Array<{ startDatetime?: string; stopDatetime?: string }> {
  if (!startDatetime?.trim() || !stopDatetime?.trim()) {
    return [{ startDatetime, stopDatetime }];
  }
  const start = parseMysqlDatetime(startDatetime);
  const stop = parseMysqlDatetime(stopDatetime);
  if (!start || !stop || stop.getTime() <= start.getTime()) {
    return [{ startDatetime, stopDatetime }];
  }
  if (stop.getTime() - start.getTime() <= chunkMs) {
    return [{ startDatetime, stopDatetime }];
  }

  const chunks: Array<{ startDatetime: string; stopDatetime: string }> = [];
  let cursor = start.getTime();
  const endMs = stop.getTime();
  while (cursor < endMs) {
    const next = Math.min(cursor + chunkMs, endMs);
    chunks.push({
      startDatetime: formatMysqlDatetime(new Date(cursor)),
      stopDatetime: formatMysqlDatetime(new Date(next)),
    });
    cursor = next;
  }
  return chunks;
}

/** 合并时间线事件：按文件 + position 去重，再按时间/position 排序。 */
export function mergeTimelineEvents(
  existing: BinlogTimelineEvent[],
  incoming: BinlogTimelineEvent[],
): BinlogTimelineEvent[] {
  const map = new Map<string, BinlogTimelineEvent>();
  for (const ev of existing) {
    map.set(`${ev.binlogFile}:${ev.startPos}:${ev.stopPos}:${ev.kind}`, ev);
  }
  for (const ev of incoming) {
    map.set(`${ev.binlogFile}:${ev.startPos}:${ev.stopPos}:${ev.kind}`, ev);
  }
  return [...map.values()].sort((a, b) => {
    if (a.binlogFile !== b.binlogFile) return a.binlogFile.localeCompare(b.binlogFile);
    if (a.startPos !== b.startPos) return a.startPos - b.startPos;
    if (a.time !== b.time) return a.time.localeCompare(b.time);
    return a.id.localeCompare(b.id);
  });
}

export type LoadBinlogTimelineChunkedParams = LoadBinlogTimelineParams & {
  chunkMs?: number;
  /** 是否最新时间片优先（默认 true，便于快速看到近期变更） */
  newestFirst?: boolean;
  onChunk?: (payload: {
    events: BinlogTimelineEvent[];
    merged: BinlogTimelineEvent[];
    chunkIndex: number;
    chunkTotal: number;
    done: boolean;
  }) => void;
  shouldCancel?: () => boolean;
};

/**
 * 按时间片加载变更时间线：首片返回后即可展示，其余在后台继续。
 * 返回最终合并结果；若中途 shouldCancel，返回当前已合并内容。
 */
export async function loadBinlogTimelineChunked(
  params: LoadBinlogTimelineChunkedParams,
): Promise<BinlogTimelineEvent[]> {
  const {
    chunkMs = BINLOG_TIMELINE_CHUNK_MS,
    newestFirst = true,
    onChunk,
    shouldCancel,
    ...base
  } = params;

  const windows = splitDatetimeRange(base.startDatetime, base.stopDatetime, chunkMs);
  const ordered = newestFirst ? [...windows].reverse() : windows;
  let merged: BinlogTimelineEvent[] = [];

  for (let i = 0; i < ordered.length; i++) {
    if (shouldCancel?.()) return merged;
    const win = ordered[i];
    let chunkEvents: BinlogTimelineEvent[] = [];
    try {
      chunkEvents = await loadBinlogTimeline({
        ...base,
        startDatetime: win.startDatetime,
        stopDatetime: win.stopDatetime,
      });
    } catch (e) {
      // 单片失败不阻断后续；首片失败则抛出
      if (i === 0) throw e;
      onChunk?.({
        events: [],
        merged,
        chunkIndex: i + 1,
        chunkTotal: ordered.length,
        done: i === ordered.length - 1,
      });
      continue;
    }
    if (shouldCancel?.()) return merged;
    merged = mergeTimelineEvents(merged, chunkEvents);
    onChunk?.({
      events: chunkEvents,
      merged,
      chunkIndex: i + 1,
      chunkTotal: ordered.length,
      done: i === ordered.length - 1,
    });
  }

  return merged;
}

export type GenerateFlashbackSqlParams = {
  connection: DbConnectionConfig;
  sshConnectionId: string;
  sshConnections: Connection[];
  tool: Extract<FlashbackToolResolution, { status: "ready" }>;
  startFile: string;
  stopFile?: string;
  startPos?: number;
  stopPos?: number;
  startDatetime?: string;
  stopDatetime?: string;
  databases?: string;
  tables?: string;
  logBinBasename?: string;
  /** docker 场景优先用 repl 模式，避免容器内路径在宿主机不可见 */
  preferReplMode?: boolean;
  /** 为 rollback 附带 extraInfo，便于按选中事件裁剪输出 */
  addExtraInfo?: boolean;
};

/** 生成闪回（反向）SQL 文本。 */
export async function generateFlashbackSql(
  params: GenerateFlashbackSqlParams,
): Promise<string> {
  const {
    connection,
    sshConnectionId,
    sshConnections,
    tool,
    startFile,
    stopFile,
    startPos,
    stopPos,
    startDatetime,
    stopDatetime,
    databases,
    tables,
    logBinBasename,
    preferReplMode,
    addExtraInfo,
  } = params;

  if (tool.kind === "my2sql") {
    return runMy2sql({
      connection,
      sshConnectionId,
      sshConnections,
      toolCommand: tool.command,
      workType: "rollback",
      startFile,
      stopFile,
      startPos,
      stopPos,
      startDatetime,
      stopDatetime,
      databases,
      tables,
      logBinBasename,
      preferReplMode,
      addExtraInfo: Boolean(addExtraInfo),
    });
  }

  // binlog2sql --flashback（兼容回退，不支持时间线）
  const host = my2sqlConnectHost(connection, sshConnections, sshConnectionId);
  const port = connection.port || 3306;
  const args = [
    tool.command,
    `--flashback`,
    `-h${shellQuote(host)}`,
    `-P${port}`,
    `-u${shellQuote(connection.user)}`,
    `-p${shellQuote(connection.password)}`,
    databases?.trim() ? `-d${shellQuote(databases.trim())}` : "",
    tables?.trim() ? `-t${shellQuote(tables.trim())}` : "",
    `--start-file=${shellQuote(startFile)}`,
    stopFile?.trim() ? `--stop-file=${shellQuote(stopFile.trim())}` : "",
    typeof startPos === "number" ? `--start-position=${startPos}` : "",
    typeof stopPos === "number" ? `--stop-position=${stopPos}` : "",
    startDatetime?.trim() ? `--start-datetime=${shellQuote(startDatetime.trim())}` : "",
    stopDatetime?.trim() ? `--stop-datetime=${shellQuote(stopDatetime.trim())}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const res = await sshExec(sshConnectionId, `${args} 2>&1 | head -c ${TIMELINE_OUTPUT_BYTES}`);
  const sql = res.stdout.trim();
  if (!sql) {
    throw new Error(res.stderr.trim() || "binlog2sql 未生成回滚 SQL");
  }
  // 过滤掉明显非 SQL 的错误行（2>&1 可能把错误混进 stdout）
  if (!/(INSERT|UPDATE|DELETE)\b/i.test(sql) && /error|fail|traceback/i.test(sql)) {
    throw new Error(sql.slice(0, 500));
  }
  return sql;
}

/** 从选中事件推导闪回范围。
 * 注意：extraInfo 的 startpos/stoppos 不能直接当作 my2sql 的 -start-pos/-stop-pos
 *（liuhr/my2sql#52，会 exit=0 且不产出语句）。
 * 与时间线加载一致：只传文件 + 事件时间窗（±2s），再用 extraInfo 裁剪到选中行。
 * 不用 start-pos=4 扫整文件，避免大 binlog 末端事件极慢。
 */
export function resolveSelectionRange(events: BinlogTimelineEvent[]): {
  startFile: string;
  stopFile: string;
  startDatetime: string;
  stopDatetime: string;
} | null {
  if (events.length === 0) return null;
  const sorted = [...events].sort((a, b) => {
    if (a.binlogFile !== b.binlogFile) return a.binlogFile.localeCompare(b.binlogFile);
    return a.startPos - b.startPos;
  });
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const times = sorted
    .map((ev) => parseMysqlDatetime(ev.time))
    .filter((d): d is Date => d != null)
    .map((d) => d.getTime());
  const padMs = 2_000;
  let startDatetime: string;
  let stopDatetime: string;
  if (times.length > 0) {
    const minT = Math.min(...times);
    const maxT = Math.max(...times);
    startDatetime = formatMysqlDatetime(new Date(minT - padMs));
    stopDatetime = formatMysqlDatetime(new Date(maxT + padMs));
  } else {
    startDatetime = first.time;
    stopDatetime = last.time;
  }
  return {
    startFile: first.binlogFile,
    stopFile: last.binlogFile,
    startDatetime,
    stopDatetime,
  };
}

/** 按选中事件的 position 过滤 rollback 输出（保留 extraInfo 注释块或紧邻 DML）。 */
export function filterRollbackSqlBySelection(
  sql: string,
  selected: BinlogTimelineEvent[],
): string {
  if (!sql?.trim() || !selected?.length) return sql ?? "";
  const wantedExact = new Set(
    selected.map((ev) => `${ev.binlogFile}:${ev.startPos}:${ev.stopPos}`),
  );
  const wantedStart = new Set(selected.map((ev) => `${ev.binlogFile}:${ev.startPos}`));
  const lines = sql.split(/\r?\n/);
  const kept: string[] = [];
  let keepBlock = false;
  for (const line of lines) {
    const meta = line.match(
      /^#\s*datetime=\S+\s+database=\S+\s+table=\S+\s+binlog=(\S+)\s+startpos=(\d+)\s+stoppos=(\d+)/i,
    );
    if (meta) {
      const file = meta[1];
      const start = meta[2];
      const stop = meta[3];
      keepBlock =
        wantedExact.has(`${file}:${start}:${stop}`) ||
        wantedStart.has(`${file}:${start}`);
      if (keepBlock) kept.push(line);
      continue;
    }
    if (keepBlock) kept.push(line);
  }
  const filtered = kept.join("\n").trim();
  // 无 extraInfo 时无法精确裁剪，退回原文
  return filtered || sql;
}

/** 执行闪回 SQL（多语句按分号粗分后逐条执行）。 */
export async function executeFlashbackSql(
  connection: DbConnectionConfig,
  sql: string,
): Promise<{ statements: number; errors: string[] }> {
  const parts = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#") && !s.startsWith("--"));
  const errors: string[] = [];
  let ok = 0;
  for (const stmt of parts) {
    const runSql = stmt.endsWith(";") ? stmt : `${stmt};`;
    try {
      await unwrapCommand(
        commands.dbExecuteQuery(ipcConn(connection), runSql, makeQueryRunId(), null, null),
      );
      ok += 1;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      if (errors.length >= 5) break;
    }
  }
  return { statements: ok, errors };
}
