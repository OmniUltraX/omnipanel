/**
 * 快捷启动建议生成：按 DetectedEntity 产出多条候选动作，注入最近连接上下文。
 */

import type { Connection } from "../../ipc/bindings";
import type { QuickLaunchRecentEntry } from "../../stores/quickLauncherRecentStore";
import type { QuickLauncherAction } from "../quickLauncher";
import {
  detectEntities,
  isDestructiveSql,
  type DetectedEntity,
  type EntityKind,
} from "./detectText";

export interface SuggestedAction {
  /** 列表去重 / 频次统计用 */
  actionKey: string;
  label: string;
  subtitle?: string;
  score: number;
  dangerous?: boolean;
  action: QuickLauncherAction;
  /** 来源实体类型（展示标签） */
  entityKind: EntityKind;
}

export interface SuggestionContext {
  connections: Connection[];
  recentEntries: QuickLaunchRecentEntry[];
  /** actionKey → 使用次数，用于 recencyBoost */
  actionUseCounts?: Record<string, number>;
  /** 建议条数上限 */
  maxSuggestions?: number;
}

function sshHostOf(conn: Connection): string {
  try {
    const cfg = conn.config ? (JSON.parse(conn.config) as Record<string, unknown>) : {};
    return typeof cfg.host === "string" ? cfg.host.trim().toLowerCase() : "";
  } catch {
    return "";
  }
}

function dbDefaultDatabase(conn: Connection): string {
  try {
    const cfg = conn.config ? (JSON.parse(conn.config) as Record<string, unknown>) : {};
    return typeof cfg.database === "string" ? cfg.database.trim() : "";
  } catch {
    return "";
  }
}

function baseScore(kind: EntityKind): number {
  switch (kind) {
    case "sql":
      return 90;
    case "ipv4":
    case "ipv6":
    case "hostPort":
      return 85;
    case "url":
    case "gitUrl":
      return 80;
    case "domain":
      return 75;
    case "shellCommand":
      return 70;
    case "json":
      return 65;
    case "filePath":
      return 60;
    case "naturalLanguage":
      return 50;
    case "plain":
    default:
      return 40;
  }
}

function withBoost(
  score: number,
  actionKey: string,
  actionUseCounts?: Record<string, number>,
): number {
  const uses = actionUseCounts?.[actionKey] ?? 0;
  return score + Math.min(uses * 2, 20);
}

function recentDbTargets(
  recent: QuickLaunchRecentEntry[],
  connections: Connection[],
  limit = 3,
): Array<{ connectionId: string; database?: string; label: string }> {
  const byId = new Map(connections.filter((c) => c.kind === "database").map((c) => [c.id, c]));
  const out: Array<{ connectionId: string; database?: string; label: string }> = [];
  const seen = new Set<string>();

  for (const entry of [...recent].sort((a, b) => {
    if (b.useCount !== a.useCount) return b.useCount - a.useCount;
    return b.lastUsedAt - a.lastUsedAt;
  })) {
    const t = entry.target;
    if (t.type === "ssh-connection") continue;
    const conn = byId.get(t.connectionId);
    if (!conn) continue;
    const database =
      t.type === "db-database" || t.type === "db-table"
        ? t.database
        : dbDefaultDatabase(conn) || undefined;
    const key = `${t.connectionId}:${database ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = database
      ? `${conn.name} · ${database}`
      : conn.name || entry.label;
    out.push({ connectionId: t.connectionId, database, label });
    if (out.length >= limit) break;
  }

  // 最近为空时回退到连接列表前几项
  if (out.length === 0) {
    for (const conn of byId.values()) {
      const database = dbDefaultDatabase(conn) || undefined;
      out.push({
        connectionId: conn.id,
        database,
        label: database ? `${conn.name} · ${database}` : conn.name,
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}

function matchSshByHost(connections: Connection[], host: string): Connection[] {
  const h = host.toLowerCase();
  return connections.filter((c) => c.kind === "ssh" && sshHostOf(c) === h);
}

type Provider = (
  entity: DetectedEntity,
  ctx: SuggestionContext,
  text: string,
) => SuggestedAction[];

const providers: Partial<Record<EntityKind, Provider>> = {
  ipv4: (entity, ctx) => {
    const host = entity.payload.host ?? "";
    if (!host) return [];
    const actions: SuggestedAction[] = [];
    const pingKey = `term:ping:${host}`;
    actions.push({
      actionKey: pingKey,
      label: `Ping ${host}`,
      subtitle: "终端",
      score: withBoost(baseScore("ipv4") * entity.confidence, pingKey, ctx.actionUseCounts),
      entityKind: "ipv4",
      action: { kind: "run-terminal", command: `ping ${host}`, execute: true },
    });
    for (const conn of matchSshByHost(ctx.connections, host).slice(0, 2)) {
      const key = `ssh:${conn.id}`;
      actions.push({
        actionKey: key,
        label: `连接到 ${conn.name}`,
        subtitle: "SSH",
        score: withBoost(baseScore("ipv4") * entity.confidence + 5, key, ctx.actionUseCounts),
        entityKind: "ipv4",
        action: { kind: "ssh-connection", connectionId: conn.id },
      });
    }
    return actions;
  },

  ipv6: (entity, ctx) => {
    const host = entity.payload.host ?? "";
    if (!host) return [];
    const pingKey = `term:ping6:${host}`;
    return [
      {
        actionKey: pingKey,
        label: `Ping ${host}`,
        subtitle: "终端",
        score: withBoost(baseScore("ipv6") * entity.confidence, pingKey, ctx.actionUseCounts),
        entityKind: "ipv6",
        action: { kind: "run-terminal", command: `ping ${host}`, execute: true },
      },
    ];
  },

  hostPort: (entity, ctx) => {
    const host = entity.payload.host ?? "";
    const port = entity.payload.port ?? "";
    if (!host || !port) return [];
    const actions: SuggestedAction[] = [];
    const telnetKey = `term:telnet:${host}:${port}`;
    actions.push({
      actionKey: telnetKey,
      label: `探测 ${host}:${port}`,
      subtitle: "终端",
      score: withBoost(baseScore("hostPort") * entity.confidence, telnetKey, ctx.actionUseCounts),
      entityKind: "hostPort",
      action: {
        kind: "run-terminal",
        command: `Test-NetConnection ${host} -Port ${port}`,
        execute: true,
      },
    });
    const curlKey = `term:curl:${host}:${port}`;
    actions.push({
      actionKey: curlKey,
      label: `curl ${host}:${port}`,
      subtitle: "终端 · 预填",
      score: withBoost(baseScore("hostPort") * entity.confidence - 5, curlKey, ctx.actionUseCounts),
      entityKind: "hostPort",
      action: {
        kind: "run-terminal",
        command: `curl -v http://${host}:${port}/`,
        execute: false,
      },
    });
    for (const conn of matchSshByHost(ctx.connections, host).slice(0, 2)) {
      const key = `ssh:${conn.id}`;
      actions.push({
        actionKey: key,
        label: `连接到 ${conn.name}`,
        subtitle: "SSH",
        score: withBoost(baseScore("hostPort") * entity.confidence + 5, key, ctx.actionUseCounts),
        entityKind: "hostPort",
        action: { kind: "ssh-connection", connectionId: conn.id },
      });
    }
    return actions;
  },

  domain: (entity, ctx) => {
    const host = entity.payload.host ?? "";
    if (!host) return [];
    const actions: SuggestedAction[] = [];
    const pingKey = `term:ping:${host}`;
    actions.push({
      actionKey: pingKey,
      label: `Ping ${host}`,
      subtitle: "终端",
      score: withBoost(baseScore("domain") * entity.confidence, pingKey, ctx.actionUseCounts),
      entityKind: "domain",
      action: { kind: "run-terminal", command: `ping ${host}`, execute: true },
    });
    const nsKey = `term:nslookup:${host}`;
    actions.push({
      actionKey: nsKey,
      label: `nslookup ${host}`,
      subtitle: "终端",
      score: withBoost(baseScore("domain") * entity.confidence - 3, nsKey, ctx.actionUseCounts),
      entityKind: "domain",
      action: { kind: "run-terminal", command: `nslookup ${host}`, execute: true },
    });
    const openKey = `url:https://${host}`;
    actions.push({
      actionKey: openKey,
      label: `在浏览器打开 ${host}`,
      subtitle: "浏览器",
      score: withBoost(baseScore("domain") * entity.confidence - 5, openKey, ctx.actionUseCounts),
      entityKind: "domain",
      action: { kind: "open-url", url: `https://${host}`, target: "browser" },
    });
    for (const conn of matchSshByHost(ctx.connections, host).slice(0, 2)) {
      const key = `ssh:${conn.id}`;
      actions.push({
        actionKey: key,
        label: `连接到 ${conn.name}`,
        subtitle: "SSH",
        score: withBoost(baseScore("domain") * entity.confidence + 5, key, ctx.actionUseCounts),
        entityKind: "domain",
        action: { kind: "ssh-connection", connectionId: conn.id },
      });
    }
    return actions;
  },

  url: (entity, ctx) => {
    const url = entity.payload.url ?? "";
    if (!url) return [];
    const actions: SuggestedAction[] = [];
    const browserKey = `url:browser:${url}`;
    actions.push({
      actionKey: browserKey,
      label: "在浏览器打开",
      subtitle: url.slice(0, 48),
      score: withBoost(baseScore("url") * entity.confidence, browserKey, ctx.actionUseCounts),
      entityKind: "url",
      action: { kind: "open-url", url, target: "browser" },
    });
    const httpKey = `url:http:${url}`;
    actions.push({
      actionKey: httpKey,
      label: "在协议调试中打开",
      subtitle: "HTTP",
      score: withBoost(baseScore("url") * entity.confidence - 2, httpKey, ctx.actionUseCounts),
      entityKind: "url",
      action: { kind: "open-url", url, target: "http" },
    });
    const curlKey = `term:curl:${url}`;
    actions.push({
      actionKey: curlKey,
      label: "curl（预填）",
      subtitle: "终端",
      score: withBoost(baseScore("url") * entity.confidence - 5, curlKey, ctx.actionUseCounts),
      entityKind: "url",
      action: { kind: "run-terminal", command: `curl -v "${url}"`, execute: false },
    });
    return actions;
  },

  gitUrl: (entity, ctx) => {
    const url = entity.payload.url ?? "";
    if (!url) return [];
    const key = `term:git-clone:${url}`;
    return [
      {
        actionKey: key,
        label: "git clone",
        subtitle: "终端 · 预填",
        score: withBoost(baseScore("gitUrl") * entity.confidence, key, ctx.actionUseCounts),
        entityKind: "gitUrl",
        action: { kind: "run-terminal", command: `git clone ${url}`, execute: false },
      },
    ];
  },

  sql: (entity, ctx) => {
    const sql = entity.payload.sql ?? "";
    if (!sql) return [];
    const destructive = entity.payload.destructive === "1" || isDestructiveSql(sql);
    const actions: SuggestedAction[] = [];
    const targets = recentDbTargets(ctx.recentEntries, ctx.connections, 3);

    for (const target of targets) {
      const key = `sql:exec:${target.connectionId}:${target.database ?? ""}`;
      actions.push({
        actionKey: key,
        label: `在 ${target.label} 执行`,
        subtitle: destructive ? "写操作 · 请确认" : "数据库",
        score: withBoost(
          baseScore("sql") * entity.confidence - (destructive ? 15 : 0),
          key,
          ctx.actionUseCounts,
        ),
        dangerous: destructive,
        entityKind: "sql",
        action: {
          kind: "run-sql",
          connectionId: target.connectionId,
          database: target.database,
          sql,
          mode: "execute",
        },
      });
    }

    // 草稿：优先第一个最近连接，否则仍给一条无连接提示用的 draft（需至少一个连接）
    const draftTarget = targets[0];
    if (draftTarget) {
      const draftKey = `sql:draft:${draftTarget.connectionId}`;
      actions.push({
        actionKey: draftKey,
        label: "新建 SQL 草稿（不执行）",
        subtitle: draftTarget.label,
        score: withBoost(baseScore("sql") * entity.confidence - 8, draftKey, ctx.actionUseCounts),
        entityKind: "sql",
        action: {
          kind: "run-sql",
          connectionId: draftTarget.connectionId,
          database: draftTarget.database,
          sql,
          mode: "draft",
        },
      });
    }

    const aiKey = "ai:explain-sql";
    actions.push({
      actionKey: aiKey,
      label: "问 AI 解释这段 SQL",
      subtitle: "AI",
      score: withBoost(baseScore("sql") * entity.confidence - 10, aiKey, ctx.actionUseCounts),
      entityKind: "sql",
      action: {
        kind: "ask-ai",
        prompt: `请解释以下 SQL 的作用，并指出潜在风险：\n\n\`\`\`sql\n${sql.slice(0, 6000)}\n\`\`\``,
      },
    });

    return actions;
  },

  json: (entity, ctx, text) => {
    const json = entity.payload.json ?? text;
    const actions: SuggestedAction[] = [];
    const noteKey = "note:json";
    actions.push({
      actionKey: noteKey,
      label: "存为笔记",
      subtitle: "知识库",
      score: withBoost(baseScore("json") * entity.confidence, noteKey, ctx.actionUseCounts),
      entityKind: "json",
      action: {
        kind: "save-note",
        title: "剪贴板 JSON",
        content: "```json\n" + json.slice(0, 50_000) + "\n```",
      },
    });
    const aiKey = "ai:explain-json";
    actions.push({
      actionKey: aiKey,
      label: "问 AI 解释",
      subtitle: "AI",
      score: withBoost(baseScore("json") * entity.confidence - 5, aiKey, ctx.actionUseCounts),
      entityKind: "json",
      action: {
        kind: "ask-ai",
        prompt: `请分析以下 JSON 结构并总结字段含义：\n\n\`\`\`json\n${json.slice(0, 6000)}\n\`\`\``,
      },
    });
    return actions;
  },

  filePath: (entity, ctx) => {
    const path = entity.payload.path ?? "";
    if (!path) return [];
    const actions: SuggestedAction[] = [];
    const openKey = `path:open:${path}`;
    actions.push({
      actionKey: openKey,
      label: "在文件模块打开",
      subtitle: path,
      score: withBoost(baseScore("filePath") * entity.confidence, openKey, ctx.actionUseCounts),
      entityKind: "filePath",
      action: { kind: "open-path", path },
    });
    const cdKey = `term:cd:${path}`;
    actions.push({
      actionKey: cdKey,
      label: "终端 cd（预填）",
      subtitle: "终端",
      score: withBoost(baseScore("filePath") * entity.confidence - 5, cdKey, ctx.actionUseCounts),
      entityKind: "filePath",
      action: {
        kind: "run-terminal",
        command: `cd "${path}"`,
        execute: false,
      },
    });
    return actions;
  },

  shellCommand: (entity, ctx) => {
    const command = entity.payload.command ?? "";
    if (!command) return [];
    const runKey = `term:run:${command}`;
    const draftKey = `term:draft:${command}`;
    return [
      {
        actionKey: runKey,
        label: "在终端执行",
        subtitle: command.slice(0, 40),
        score: withBoost(baseScore("shellCommand") * entity.confidence, runKey, ctx.actionUseCounts),
        entityKind: "shellCommand",
        action: { kind: "run-terminal", command, execute: true },
      },
      {
        actionKey: draftKey,
        label: "预填到终端（不执行）",
        subtitle: "终端",
        score: withBoost(
          baseScore("shellCommand") * entity.confidence - 5,
          draftKey,
          ctx.actionUseCounts,
        ),
        entityKind: "shellCommand",
        action: { kind: "run-terminal", command, execute: false },
      },
    ];
  },

  naturalLanguage: (entity, ctx) => {
    const text = entity.payload.text ?? "";
    if (!text) return [];
    return universalTextActions(text, entity.kind, entity.confidence, ctx);
  },

  plain: (entity, ctx) => {
    const text = entity.payload.text ?? "";
    if (!text) return [];
    return universalTextActions(text, entity.kind, entity.confidence, ctx);
  },
};

function universalTextActions(
  text: string,
  kind: EntityKind,
  confidence: number,
  ctx: SuggestionContext,
): SuggestedAction[] {
  const title = text.replace(/\s+/g, " ").slice(0, 40);
  const aiKey = "ai:ask";
  const noteKey = "note:save";
  const todoKey = "todo:create";
  return [
    {
      actionKey: aiKey,
      label: "询问 AI",
      subtitle: "AI",
      score: withBoost(baseScore(kind) * confidence + 5, aiKey, ctx.actionUseCounts),
      entityKind: kind,
      action: { kind: "ask-ai", prompt: text.slice(0, 8000) },
    },
    {
      actionKey: noteKey,
      label: "存为笔记",
      subtitle: "知识库",
      score: withBoost(baseScore(kind) * confidence, noteKey, ctx.actionUseCounts),
      entityKind: kind,
      action: { kind: "save-note", title: title || "剪贴板笔记", content: text.slice(0, 50_000) },
    },
    {
      actionKey: todoKey,
      label: "加到待办",
      subtitle: "任务",
      score: withBoost(baseScore(kind) * confidence - 3, todoKey, ctx.actionUseCounts),
      entityKind: kind,
      action: { kind: "create-todo", title: title || "待办" },
    },
  ];
}

function dedupeByActionKey(actions: SuggestedAction[]): SuggestedAction[] {
  const map = new Map<string, SuggestedAction>();
  for (const a of actions) {
    const prev = map.get(a.actionKey);
    if (!prev || a.score > prev.score) map.set(a.actionKey, a);
  }
  return [...map.values()];
}

/**
 * 根据文本与上下文构建建议动作列表。
 */
export function buildSuggestions(text: string, ctx: SuggestionContext): SuggestedAction[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const entities = detectEntities(trimmed);
  const all: SuggestedAction[] = [];

  for (const entity of entities) {
    const provider = providers[entity.kind];
    if (!provider) continue;
    all.push(...provider(entity, ctx, trimmed));
  }

  // 结构化命中时仍补充保底 AI / 笔记（若尚未包含）
  const hasUniversal = all.some(
    (a) => a.action.kind === "ask-ai" || a.action.kind === "save-note",
  );
  if (!hasUniversal) {
    all.push(...universalTextActions(trimmed, "plain", 0.35, ctx));
  }

  const max = ctx.maxSuggestions ?? 5;
  return dedupeByActionKey(all)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.label.localeCompare(b.label, "zh-CN");
    })
    .slice(0, max);
}

/** 导出供 UI 展示实体标签 */
export function primaryEntityKind(text: string): EntityKind | null {
  const entities = detectEntities(text.trim());
  if (entities.length === 0) return null;
  return [...entities].sort((a, b) => b.confidence - a.confidence)[0]!.kind;
}
