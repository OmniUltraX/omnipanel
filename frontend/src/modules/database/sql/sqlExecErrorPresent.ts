export interface SqlErrorUnderline {
  from: number;
  to: number;
}

export interface SqlRepairNote {
  /** 这次解读属于哪条结果，切换历史或重新执行后不再显示。 */
  sessionId: string;
  text: string;
  sql: string | null;
}

let repairNote: SqlRepairNote | null = null;
const repairListeners = new Set<() => void>();

export function setSqlRepairNote(note: SqlRepairNote | null) {
  repairNote = note;
  for (const listener of repairListeners) listener();
}

export function subscribeSqlRepairNote(listener: () => void): () => void {
  repairListeners.add(listener);
  return () => repairListeners.delete(listener);
}

export function readSqlRepairNote(): SqlRepairNote | null {
  return repairNote;
}

let applyRepair: ((sql: string) => void) | null = null;

export function registerSqlRepairApply(apply: (sql: string) => void): () => void {
  applyRepair = apply;
  return () => {
    if (applyRepair === apply) applyRepair = null;
  };
}

export function applySqlRepair(sql: string) {
  applyRepair?.(sql);
  setSqlRepairNote(null);
}

const WRAP_MARK = "__omnipanel_wrap__";

function stripLeadingComments(sql: string): string {
  let rest = sql.trimStart();
  for (;;) {
    if (rest.startsWith("--")) {
      const lineEnd = rest.indexOf("\n");
      rest = lineEnd >= 0 ? rest.slice(lineEnd + 1).trimStart() : "";
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      rest = end >= 0 ? rest.slice(end + 2).trimStart() : "";
      continue;
    }
    break;
  }
  return rest;
}

export function parseDropDatabaseStatement(
  sql: string,
): { name: string; ifExists: boolean } | null {
  const head = stripLeadingComments(sql.trim().replace(/;+\s*$/, ""));
  const match = head.match(
    /^drop\s+(?:database|schema)\s+(if\s+exists\s+)?(?:`([^`]+)`|"([^"]+)"|'([^']+)'|([A-Za-z0-9_$]+))/i,
  );
  if (!match) {
    return null;
  }
  const name = match[2] ?? match[3] ?? match[4] ?? match[5];
  if (!name) {
    return null;
  }
  return { name, ifExists: Boolean(match[1]) };
}

function isPostgresDbType(dbType?: string): boolean {
  const t = dbType?.trim().toLowerCase() ?? "";
  return t === "postgres" || t === "postgresql" || t === "pg";
}

function isDatabaseInUseError(raw: string): boolean {
  const lower = raw.toLowerCase();
  return (
    lower.includes("being accessed by other users") ||
    lower.includes("is being accessed by other users") ||
    lower.includes("database is being accessed") ||
    lower.includes("55006")
  );
}

function formatPgDropDatabaseForceSql(name: string, ifExists: boolean): string {
  const quoted = `"${name.replace(/"/g, '""')}"`;
  return `DROP DATABASE ${ifExists ? "IF EXISTS " : ""}${quoted} WITH (FORCE);`;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 列出正在连接指定库的会话（可在 SQL 编辑器单独执行第一段查看占用方）。 */
export function buildListSessionsOnDatabaseSql(dbName: string, dbType?: string): string {
  const lit = sqlStringLiteral(dbName);
  if (isPostgresDbType(dbType)) {
    return [
      `-- 谁连着库 ${dbName}：pid、用户、客户端 IP、应用名、状态、当前 SQL`,
      "SELECT pid,",
      "       usename AS user_name,",
      "       application_name,",
      "       client_addr::text AS client_addr,",
      "       backend_start,",
      "       state,",
      "       left(query, 300) AS query",
      "FROM pg_stat_activity",
      `WHERE datname = ${lit}`,
      "  AND pid <> pg_backend_pid()",
      "ORDER BY backend_start;",
    ].join("\n");
  }
  const engine = dbType?.trim().toLowerCase() ?? "";
  if (engine === "mysql" || engine === "mariadb") {
    return [
      `-- 谁连着库 ${dbName}：连接 ID、用户、来源、状态、当前 SQL`,
      "SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, LEFT(INFO, 300) AS INFO",
      "FROM information_schema.PROCESSLIST",
      `WHERE DB = ${lit}`,
      "ORDER BY TIME DESC;",
    ].join("\n");
  }
  return [
    `-- 请在「连接信息 → 连接」进程列表中搜索 ${dbName}，查看占用该库的连接`,
    `-- 或执行当前引擎对应的会话列表查询后筛选库名 ${dbName}`,
  ].join("\n");
}

function buildDropDatabaseInUseRepairSql(
  dbName: string,
  ifExists: boolean,
  dbType?: string,
): string {
  const listSql = buildListSessionsOnDatabaseSql(dbName, dbType);
  if (isPostgresDbType(dbType)) {
    const dropSql = formatPgDropDatabaseForceSql(dbName, ifExists);
    return [
      listSql,
      "",
      "-- 确认无重要任务后，PG 13+ 可强制断开其它会话并删库（执行前仍会要求删库确认）",
      dropSql,
    ].join("\n");
  }
  if (dbType?.trim().toLowerCase() === "mysql" || dbType?.trim().toLowerCase() === "mariadb") {
    return [
      listSql,
      "",
      "-- 在进程列表中 Kill 掉占用该库的连接后，再执行：",
      `DROP DATABASE ${ifExists ? "IF EXISTS " : ""}\`${dbName.replace(/`/g, "``")}\`;`,
    ].join("\n");
  }
  return listSql;
}

const CONNECTION_PROCESS_HINT =
  "也可在左侧打开该连接 →「连接信息」→「连接」页，在进程列表中搜索库名，查看客户端地址与应用名，并可终止指定连接。";

export interface BuiltinSqlExecRepair {
  hint: string;
  sql: string;
}

/** 常见删库失败：给出可执行的修复 SQL，避免再走 AI 解读。 */
export function tryBuiltinSqlExecRepair(
  sql: string,
  rawError: string,
  dbType?: string,
): BuiltinSqlExecRepair | null {
  if (!isDatabaseInUseError(rawError)) {
    return null;
  }
  const drop = parseDropDatabaseStatement(sql);
  if (!drop) {
    return null;
  }
  if (/\bwith\s*\(\s*force\s*\)/i.test(sql) && isPostgresDbType(dbType)) {
    return {
      hint:
        `已使用 WITH (FORCE) 仍无法删除「${drop.name}」：可能有权限不足、复制槽/订阅仍绑定该库，或 PostgreSQL 版本不支持 FORCE。` +
        `请先执行下方 SQL 第一段查看占用会话。${CONNECTION_PROCESS_HINT}`,
      sql: buildListSessionsOnDatabaseSql(drop.name, dbType),
    };
  }
  const repairSql = buildDropDatabaseInUseRepairSql(drop.name, drop.ifExists, dbType);
  const pgExtra = isPostgresDbType(dbType)
    ? "第二段为 PG 13+ 的 WITH (FORCE) 删库；也可只在进程列表里终止连接后再 DROP。"
    : "确认占用方后断开连接，再执行脚本末尾的 DROP。";
  return {
    hint:
      `数据库「${drop.name}」仍有其它会话，无法直接删除。` +
      `点击下方「应用修改」会插入：① 查询谁在连这个库（pid/用户/客户端/应用名/SQL）；② 删库步骤。` +
      pgExtra +
      CONNECTION_PROCESS_HINT,
    sql: repairSql,
  };
}

/** 把分页包装从报错里剥掉。包装自己造成的冲突改成人话，不再甩给用户原文。 */
export function presentSqlExecError(raw: string): string {
  if (!raw.includes(WRAP_MARK)) {
    if (isDatabaseInUseError(raw)) {
      const cause = raw.includes(":")
        ? raw.split(":").slice(-1)[0]?.trim() ?? raw
        : raw;
      return (
        `无法删除数据库：仍有其它会话正在使用该库。\n${cause}\n\n` +
        `不知道是谁在连？点击语句旁「修复」→「应用修改」，先执行脚本里第一段 SELECT 查看 pid、客户端 IP、应用名与 SQL。` +
        `\n${CONNECTION_PROCESS_HINT}\n` +
        `PostgreSQL 13+ 也可在确认后执行 DROP DATABASE … WITH (FORCE)。`
      );
    }
    return raw;
  }
  return "分页包装和语句末尾的 LIMIT 撞上了。语句本身已有行数限制，已改为不再套一层子查询。重新执行即可。";
}

function unwrapSentSql(sent: string): string {
  const marker = `) AS ${WRAP_MARK}`;
  const start = sent.indexOf("SELECT * FROM (");
  const end = sent.indexOf(marker);
  if (start < 0 || end < 0 || end <= start) return sent;
  return sent.slice(start + "SELECT * FROM (".length, end);
}

/** MySQL `near '…'` 对得上用户原文时返回区间；片段只存在于包装里则不标。 */
export function sqlErrorUnderline(userSql: string, rawError: string): SqlErrorUnderline | null {
  const near = rawError.match(/near '([^']+)'/i);
  if (!near?.[1]) return null;
  const snippet = near[1];
  if (snippet.includes(WRAP_MARK)) return null;
  const source = unwrapSentSql(userSql);
  const at = source.indexOf(snippet);
  if (at < 0) return null;
  const base = userSql.indexOf(source);
  const from = (base < 0 ? 0 : base) + at;
  return { from, to: from + snippet.length };
}
