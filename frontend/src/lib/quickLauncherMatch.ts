import type { Connection } from "../ipc/bindings";
import type { DbConnectionConfig } from "../modules/database/api";
import type { SchemaCacheSnapshot } from "../modules/database/schema/schemaCache";
import type { QuickLaunchRecentEntry } from "../stores/quickLauncherRecentStore";

/**
 * 已注册的命令前缀。
 * 统一语法（与 ssh 对齐，后续前缀照抄）：
 * - `prefix`           → 列出该类全部目标
 * - `prefix+filter`    → 按 filter 边输入边过滤
 * - `prefix filter`    → 同上（空格形式）
 */
export const QUICK_LAUNCH_COMMAND_PREFIXES = ["ssh", "db"] as const;
export type QuickLaunchCommandPrefix = (typeof QUICK_LAUNCH_COMMAND_PREFIXES)[number];

/** 快捷启动查询归类 */
export type QuickLaunchQueryKind = "plain" | QuickLaunchCommandPrefix;

export type ParsedQuickLaunchQuery =
  | { kind: "plain"; raw: string; filter: string }
  | { kind: "ssh"; raw: string; filter: string }
  | {
      kind: "db";
      raw: string;
      filter: string;
      /** filter 为 `库.xxx` 时的库名（进入表匹配模式） */
      databaseHint?: string;
      /** `库.xxx` 中的表名过滤；空字符串表示该库下全部表 */
      tableHint?: string;
    };

/** 列表行（匹配结果） */
export type QuickLaunchMatchRow =
  | {
      type: "ssh-connection";
      id: string;
      connectionId: string;
      label: string;
      subtitle: string;
      score: number;
    }
  | {
      type: "db-connection";
      id: string;
      connectionId: string;
      label: string;
      subtitle: string;
      score: number;
    }
  | {
      type: "db-database";
      id: string;
      connectionId: string;
      database: string;
      label: string;
      subtitle: string;
      score: number;
    }
  | {
      type: "db-table";
      id: string;
      connectionId: string;
      database: string;
      table: string;
      label: string;
      subtitle: string;
      score: number;
    };

const MAX_RESULTS = 12;

/**
 * 匹配统一前缀语法：`prefix` | `prefix+filter` | `prefix filter`。
 * 返回 null 表示不是该前缀；filter 为空表示「列出全部」。
 */
export function matchQuickLaunchPrefix(
  trimmed: string,
  prefix: string,
): { filter: string } | null {
  const lower = trimmed.toLowerCase();
  const p = prefix.toLowerCase();
  if (!p) return null;
  if (lower === p) {
    return { filter: "" };
  }
  if (lower.startsWith(`${p}+`)) {
    return { filter: trimmed.slice(p.length + 1).trim() };
  }
  if (lower.startsWith(`${p} `) || lower.startsWith(`${p}\t`)) {
    return { filter: trimmed.slice(p.length).trim() };
  }
  return null;
}

/** 各前缀 → 结构化查询。新增前缀时在此登记即可。 */
const PREFIX_QUERY_BUILDERS: Record<
  QuickLaunchCommandPrefix,
  (raw: string, filter: string) => ParsedQuickLaunchQuery
> = {
  ssh: (raw, filter) => ({ kind: "ssh", raw, filter }),
  db: (raw, filter) => buildDbQuery(raw, filter),
};

/** 解析用户输入：先走统一前缀语法，未命中则为 plain（逻辑留空）。 */
export function parseQuickLaunchQuery(rawInput: string): ParsedQuickLaunchQuery {
  const raw = rawInput;
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { kind: "plain", raw, filter: "" };
  }

  // 长前缀优先，避免未来短前缀误吃长前缀（如 dock vs docker）
  const prefixes = [...QUICK_LAUNCH_COMMAND_PREFIXES].sort(
    (a, b) => b.length - a.length,
  );
  for (const prefix of prefixes) {
    const hit = matchQuickLaunchPrefix(trimmed, prefix);
    if (!hit) continue;
    return PREFIX_QUERY_BUILDERS[prefix](raw, hit.filter);
  }

  // 第一类：无规则字符串（逻辑留空）
  return { kind: "plain", raw, filter: trimmed };
}

/** db 域：在统一 filter 之上解析可选的 `库.表` 提示。 */
function buildDbQuery(
  raw: string,
  filter: string,
): Extract<ParsedQuickLaunchQuery, { kind: "db" }> {
  if (!filter) {
    return { kind: "db", raw, filter: "" };
  }
  // 单 token 且含 `.` → `库` / `库.` / `库.xxx`（表名可空，表示该库下全部表）
  if (!/\s/.test(filter) && filter.includes(".")) {
    const dot = filter.indexOf(".");
    const databaseHint = filter.slice(0, dot).trim();
    const tableHint = filter.slice(dot + 1).trim();
    if (databaseHint) {
      return { kind: "db", raw, filter, databaseHint, tableHint };
    }
  }
  return { kind: "db", raw, filter };
}

function scoreText(haystack: string, needle: string): number | null {
  if (!needle) return 10;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (!n) return 10;
  if (h === n) return 100;
  if (h.startsWith(n)) return 80;
  if (h.includes(n)) return 50;
  return null;
}

function bestScore(...scores: Array<number | null>): number | null {
  let best: number | null = null;
  for (const s of scores) {
    if (s == null) continue;
    if (best == null || s > best) best = s;
  }
  return best;
}

function connectionSearchBlob(conn: Connection): string {
  return [conn.name, conn.group ?? "", conn.config ?? "", ...(conn.tags ?? [])].join(" ");
}

/**
 * 数据库连接存在独立存储（db_list_connections），不在统一 conn_list。
 * 转为 Connection 形态供快捷启动匹配 / 最近记录复用。
 */
export function dbConnectionToQuickLaunchConnection(conn: DbConnectionConfig): Connection {
  return {
    id: conn.id,
    kind: "database",
    name: conn.name,
    group: conn.group,
    config: JSON.stringify({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      database: conn.database,
      db_type: conn.db_type,
    }),
  };
}

/** 合并统一连接与数据库专用连接（去重：同 id 以数据库源为准）。 */
export function mergeQuickLaunchConnections(
  unified: Connection[],
  dbConnections: Connection[],
): Connection[] {
  const byId = new Map<string, Connection>();
  for (const conn of unified) {
    if (conn.kind === "database") continue;
    byId.set(conn.id, conn);
  }
  for (const conn of dbConnections) {
    byId.set(conn.id, conn);
  }
  return [...byId.values()];
}

/** 匹配行所属模块（展示用） */
export function quickLaunchRowModule(
  row: Pick<QuickLaunchMatchRow, "type">,
): "ssh" | "database" {
  return row.type === "ssh-connection" ? "ssh" : "database";
}

/**
 * 将选中项补全为可写入输入框的查询串。
 * 尽量保留当前前缀写法（`ssh+` / `ssh ` / `db+` / `db `）。
 */
export function rowToInsertQuery(row: QuickLaunchMatchRow, currentQuery: string): string {
  const trimmed = currentQuery.trim();
  const lower = trimmed.toLowerCase();

  if (row.type === "ssh-connection") {
    if (lower.startsWith("ssh+")) {
      return `ssh+${row.label}`;
    }
    return `ssh ${row.label}`;
  }

  const dbToken =
    row.type === "db-connection"
      ? row.label
      : row.type === "db-database"
        ? row.database
        : `${row.database}.${row.table}`;

  if (lower.startsWith("db+")) {
    return `db+${dbToken}`;
  }
  return `db ${dbToken}`;
}

/**
 * 空输入时的最近打开列表。
 * 排序已由调用方按「次数 ↓、时间 ↓」完成；此处做连接存活过滤与行映射。
 */
export function buildQuickLaunchRecentRows(options: {
  entries: QuickLaunchRecentEntry[];
  connections: Connection[];
  /** 副标题：连接上下文（时间改由列表右侧单独展示） */
  labels: {
    database: (connName: string, dbName: string) => string;
    table: (connName: string, dbName: string, tableName: string) => string;
  };
}): QuickLaunchMatchRow[] {
  const byId = new Map(options.connections.map((c) => [c.id, c]));
  const rows: QuickLaunchMatchRow[] = [];

  for (const entry of options.entries) {
    const { target } = entry;
    const conn = byId.get(target.connectionId);
    if (!conn) continue;

    if (target.type === "ssh-connection") {
      if (conn.kind !== "ssh") continue;
      rows.push({
        type: "ssh-connection",
        id: entry.key,
        connectionId: target.connectionId,
        label: conn.name || entry.label,
        subtitle: "",
        score: entry.useCount,
      });
      continue;
    }

    if (conn.kind !== "database") continue;

    if (target.type === "db-connection") {
      rows.push({
        type: "db-connection",
        id: entry.key,
        connectionId: target.connectionId,
        label: conn.name || entry.label,
        subtitle: "",
        score: entry.useCount,
      });
      continue;
    }

    if (target.type === "db-database") {
      rows.push({
        type: "db-database",
        id: entry.key,
        connectionId: target.connectionId,
        database: target.database,
        label: target.database,
        subtitle: options.labels.database(conn.name, target.database),
        score: entry.useCount,
      });
      continue;
    }

    rows.push({
      type: "db-table",
      id: entry.key,
      connectionId: target.connectionId,
      database: target.database,
      table: target.table,
      label: `${target.database}.${target.table}`,
      subtitle: options.labels.table(conn.name, target.database, target.table),
      score: entry.useCount,
    });
  }

  return rows.slice(0, MAX_RESULTS);
}

/**
 * 按解析结果构建匹配列表。
 * - plain：暂不返回任何结果（空输入的最近列表由 buildQuickLaunchRecentRows 负责）
 * - ssh / db（及后续前缀）：各自域内边输入边过滤
 */
export function buildQuickLaunchMatches(options: {
  query: ParsedQuickLaunchQuery;
  connections: Connection[];
  schema: SchemaCacheSnapshot;
  labels: {
    sshConnection: string;
    dbConnection: string;
    database: (connName: string, dbName: string) => string;
    table: (connName: string, dbName: string, tableName: string) => string;
  };
}): QuickLaunchMatchRow[] {
  const { query, connections, schema, labels } = options;

  if (query.kind === "plain") {
    return [];
  }

  if (query.kind === "ssh") {
    return matchSshConnections(connections, query.filter);
  }

  return matchDbTargets(connections, schema, query, labels);
}

function matchSshConnections(
  connections: Connection[],
  filter: string,
): QuickLaunchMatchRow[] {
  const rows: QuickLaunchMatchRow[] = [];
  for (const conn of connections) {
    if (conn.kind !== "ssh") continue;
    const score = bestScore(
      scoreText(conn.name, filter),
      scoreText(conn.group ?? "", filter),
      scoreText(connectionSearchBlob(conn), filter),
    );
    if (score == null) continue;
    rows.push({
      type: "ssh-connection",
      id: `ssh:${conn.id}`,
      connectionId: conn.id,
      label: conn.name,
      // 模块名改由列表左侧展示，连接级不再重复副标题
      subtitle: "",
      score,
    });
  }
  return sortAndLimit(rows);
}

function matchDbTargets(
  connections: Connection[],
  schema: SchemaCacheSnapshot,
  query: Extract<ParsedQuickLaunchQuery, { kind: "db" }>,
  labels: {
    dbConnection: string;
    database: (connName: string, dbName: string) => string;
    table: (connName: string, dbName: string, tableName: string) => string;
  },
): QuickLaunchMatchRow[] {
  const { filter, databaseHint, tableHint } = query;
  const dbConns = connections.filter((c) => c.kind === "database");
  const rows: QuickLaunchMatchRow[] = [];
  void labels.dbConnection;

  // `库.xxx`：只匹配该库下的表（xxx 为空则列出该库全部表）
  const isTableMode = databaseHint != null && databaseHint.length > 0;

  for (const conn of dbConns) {
    const entry = schema.connections[conn.id];
    const databases = entry?.databases ?? [];
    for (const db of databases) {
      const dbName = db.name;

      if (isTableMode) {
        const dbOk = scoreText(dbName, databaseHint);
        if (dbOk == null) continue;

        const tables = [...(db.tables ?? []), ...(db.views ?? [])];
        for (const table of tables) {
          const tableName = table.name;
          // tableHint 为空：该库下全部表；否则按表名过滤
          const tbOk = tableHint
            ? scoreText(tableName, tableHint)
            : 10;
          if (tbOk == null) continue;
          rows.push({
            type: "db-table",
            id: `db-table:${conn.id}:${dbName}:${tableName}`,
            connectionId: conn.id,
            database: dbName,
            table: tableName,
            label: `${dbName}.${tableName}`,
            subtitle: labels.table(conn.name, dbName, tableName),
            score: Math.min(dbOk, tbOk) + 20,
          });
        }
        continue;
      }

      // 默认：匹配各连接下的数据库名称（不匹配连接名）
      const dbScore = scoreText(dbName, filter);
      if (dbScore == null) continue;
      rows.push({
        type: "db-database",
        id: `db-database:${conn.id}:${dbName}`,
        connectionId: conn.id,
        database: dbName,
        label: dbName,
        subtitle: labels.database(conn.name, dbName),
        score: dbScore,
      });
    }
  }

  return sortAndLimit(rows);
}

function sortAndLimit(rows: QuickLaunchMatchRow[]): QuickLaunchMatchRow[] {
  return rows
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.label.localeCompare(b.label);
    })
    .slice(0, MAX_RESULTS);
}
