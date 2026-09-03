import type { Connection } from "../ipc/bindings";
import type { DbConnectionConfig } from "../modules/database/api";
import type { SchemaCacheSnapshot } from "../modules/database/schema/schemaCache";
import type { QuickLaunchRecentEntry } from "../stores/quickLauncherRecentStore";

/**
 * 内核保留前缀。其余前缀由 activated 插件经 Runtime Loader 登记
 * （如 addon-everything 的 `es`），列表随启用状态实时增减。
 */
export const QUICK_LAUNCH_COMMAND_PREFIXES = ["ssh", "db"] as const;
export type QuickLaunchCommandPrefix = string;

/** 快捷启动查询归类 */
export type QuickLaunchQueryKind = "plain" | QuickLaunchCommandPrefix;

export type ParsedQuickLaunchQuery =
  | { kind: "plain"; raw: string; filter: string }
  | { kind: "ssh"; raw: string; filter: string }
  | {
      kind: "db";
      raw: string;
      filter: string;
      databaseHint?: string;
      tableHint?: string;
    }
  | { kind: "es"; raw: string; filter: string }
  | {
      kind: "module";
      raw: string;
      filter: string;
      prefix: string;
      pluginId: string;
      moduleKey: string;
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
    }
  | {
      type: "everything-path";
      id: string;
      path: string;
      label: string;
      subtitle: string;
      score: number;
    }
  | {
      type: "module-service";
      id: string;
      connectionId: string;
      pluginId: string;
      moduleKey: string;
      prefix: string;
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

export type LauncherProvider = {
  prefix: string;
  parse: (raw: string, filter: string) => ParsedQuickLaunchQuery;
};

const launcherProviders: LauncherProvider[] = [];

export function registerLauncherProvider(provider: LauncherProvider): void {
  const idx = launcherProviders.findIndex((p) => p.prefix === provider.prefix);
  if (idx >= 0) launcherProviders[idx] = provider;
  else launcherProviders.push(provider);
}

/** deactivate 时卸除插件前缀；内核 ssh/db 不受影响。 */
export function unregisterLauncherProvider(prefix: string): void {
  const idx = launcherProviders.findIndex((p) => p.prefix === prefix);
  if (idx >= 0) launcherProviders.splice(idx, 1);
}

export function listLauncherPrefixes(): string[] {
  const fromProviders = launcherProviders.map((p) => p.prefix);
  const merged = new Set<string>([...QUICK_LAUNCH_COMMAND_PREFIXES, ...fromProviders]);
  return [...merged];
}

registerLauncherProvider({
  prefix: "ssh",
  parse: (raw, filter) => ({ kind: "ssh", raw, filter }),
});
registerLauncherProvider({
  prefix: "db",
  parse: (raw, filter) => buildDbQuery(raw, filter),
});

/** 解析用户输入：先走统一前缀语法，未命中则为 plain（逻辑留空）。 */
export function parseQuickLaunchQuery(rawInput: string): ParsedQuickLaunchQuery {
  const raw = rawInput;
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { kind: "plain", raw, filter: "" };
  }

  // 长前缀优先，避免未来短前缀误吃长前缀（如 dock vs docker）
  const prefixes = listLauncherPrefixes().sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    const hit = matchQuickLaunchPrefix(trimmed, prefix);
    if (!hit) continue;
    const provider = launcherProviders.find((p) => p.prefix === prefix);
    if (provider) return provider.parse(raw, hit.filter);
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

/** 从连接 config 提取弱化描述，便于区分同名资源。 */
export function connectionDetailHint(conn: Connection): string {
  try {
    const cfg = conn.config
      ? (JSON.parse(conn.config) as Record<string, unknown>)
      : {};
    const host = typeof cfg.host === "string" ? cfg.host.trim() : "";
    const port = typeof cfg.port === "number" && cfg.port > 0 ? cfg.port : null;
    const user = typeof cfg.user === "string" ? cfg.user.trim() : "";
    const database = typeof cfg.database === "string" ? cfg.database.trim() : "";
    const dbType = typeof cfg.db_type === "string" ? cfg.db_type.trim() : "";
    const hostPort = host ? (port ? `${host}:${port}` : host) : "";

    if (conn.kind === "ssh") {
      if (user && hostPort) return `${user}@${hostPort}`;
      if (hostPort) return hostPort;
    }

    if (conn.kind === "database") {
      const parts = [dbType, hostPort, database].filter(Boolean);
      if (parts.length > 0) return parts.join(" · ");
    }
  } catch {
    /* ignore */
  }
  return (conn.group ?? "").trim();
}

/** 库 / 表行：用所属连接名 + 主机区分同名库表。 */
function dbResourceHint(conn: Connection): string {
  let hostPort = "";
  try {
    const cfg = conn.config
      ? (JSON.parse(conn.config) as Record<string, unknown>)
      : {};
    const host = typeof cfg.host === "string" ? cfg.host.trim() : "";
    const port = typeof cfg.port === "number" && cfg.port > 0 ? cfg.port : null;
    if (host) hostPort = port ? `${host}:${port}` : host;
  } catch {
    /* ignore */
  }
  if (conn.name && hostPort) return `${conn.name} · ${hostPort}`;
  return conn.name || hostPort || connectionDetailHint(conn);
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
): "ssh" | "database" | "files" | "module" {
  if (row.type === "ssh-connection") return "ssh";
  if (row.type === "everything-path") return "files";
  if (row.type === "module-service") return "module";
  return "database";
}

/**
 * 将选中项补全为可写入输入框的查询串。
 * 尽量保留当前前缀写法（`ssh+` / `ssh ` / `db+` / `db `）。
 */
export function rowToInsertQuery(row: QuickLaunchMatchRow, currentQuery: string): string {
  const trimmed = currentQuery.trim();
  const lower = trimmed.toLowerCase();

  if (row.type === "everything-path") {
    return `es ${row.path}`;
  }

  if (row.type === "module-service") {
    return `${row.prefix} ${row.label}`;
  }

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
        subtitle: connectionDetailHint(conn),
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
        subtitle: connectionDetailHint(conn),
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
        subtitle: dbResourceHint(conn),
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
      subtitle: dbResourceHint(conn),
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
}): QuickLaunchMatchRow[] {
  const { query, connections, schema } = options;

  if (query.kind === "plain") {
    return [];
  }

  if (query.kind === "ssh") {
    return matchSshConnections(connections, query.filter);
  }

  if (query.kind === "es") {
    return [];
  }

  if (query.kind === "module") {
    return matchModuleServices(connections, query);
  }

  return matchDbTargets(connections, schema, query);
}

function matchModuleServices(
  connections: Connection[],
  query: Extract<ParsedQuickLaunchQuery, { kind: "module" }>,
): QuickLaunchMatchRow[] {
  const rows: QuickLaunchMatchRow[] = [];
  for (const conn of connections) {
    if (conn.kind !== "service") continue;
    let pluginId = "";
    try {
      const cfg = conn.config ? (JSON.parse(conn.config) as { pluginId?: unknown }) : {};
      pluginId = typeof cfg.pluginId === "string" ? cfg.pluginId : "";
    } catch {
      pluginId = "";
    }
    if (pluginId !== query.pluginId) continue;
    const score = bestScore(
      scoreText(conn.name, query.filter),
      scoreText(connectionSearchBlob(conn), query.filter),
    );
    if (score == null) continue;
    rows.push({
      type: "module-service",
      id: `module:${conn.id}`,
      connectionId: conn.id,
      pluginId,
      moduleKey: query.moduleKey,
      prefix: query.prefix,
      label: conn.name,
      subtitle: connectionDetailHint(conn),
      score,
    });
  }
  return sortAndLimit(rows);
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
      // label 后弱化展示 host，区分同名 SSH
      subtitle: connectionDetailHint(conn),
      score,
    });
  }
  return sortAndLimit(rows);
}

function matchDbTargets(
  connections: Connection[],
  schema: SchemaCacheSnapshot,
  query: Extract<ParsedQuickLaunchQuery, { kind: "db" }>,
): QuickLaunchMatchRow[] {
  const { filter, databaseHint, tableHint } = query;
  const dbConns = connections.filter((c) => c.kind === "database");
  const rows: QuickLaunchMatchRow[] = [];

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
            subtitle: dbResourceHint(conn),
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
        subtitle: dbResourceHint(conn),
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
