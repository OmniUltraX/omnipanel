/**
 * 快捷启动「/」斜杠命令：与 ssh/db 前缀解耦，便于扩展。
 */
import { fuzzyMatchModelName } from "../fetchProviderModels";
import type { DashboardCatalogEntry } from "../dashboardCatalogSync";

export type SlashCommandId = "model" | "dash";

export type ParsedSlashQuery =
  | { kind: "slash-catalog"; raw: string; filter: string }
  | { kind: "slash-model"; raw: string; filter: string }
  | { kind: "slash-dashboard"; raw: string; filter: string };

export type SlashCatalogEntry = {
  id: SlashCommandId;
  /** 选中后写入输入框的文本 */
  insertQuery: string;
  /** 额外匹配别名（如 dashboard → dash） */
  aliases?: readonly string[];
};

/** 已注册斜杠命令（顺序即目录展示顺序） */
export const SLASH_COMMAND_CATALOG: readonly SlashCatalogEntry[] = [
  { id: "model", insertQuery: "/model" },
  { id: "dash", insertQuery: "/dash", aliases: ["dashboard"] },
] as const;

const DASH_TOKENS = new Set(["dash", "dashboard"]);

/**
 * 若输入以 `/` 开头则解析为斜杠命令；否则返回 null（交回前缀 / plain）。
 * - `/` 或 `/mo` → 命令目录（按命令名过滤）
 * - `/model` / `/model gpt` → 模型列表
 * - `/dash` | `/dashboard` → 看板列表
 */
export function parseSlashLaunchQuery(rawInput: string): ParsedSlashQuery | null {
  const raw = rawInput;
  const trimmed = rawInput.trim();
  if (!trimmed.startsWith("/")) return null;

  const body = trimmed.slice(1);
  if (!body.trim()) {
    return { kind: "slash-catalog", raw, filter: "" };
  }

  const spaceIdx = body.search(/\s/);
  const cmdToken = (spaceIdx < 0 ? body : body.slice(0, spaceIdx)).toLowerCase();
  const argFilter = spaceIdx < 0 ? "" : body.slice(spaceIdx).trim();

  if (cmdToken === "model") {
    return { kind: "slash-model", raw, filter: argFilter };
  }
  if (DASH_TOKENS.has(cmdToken)) {
    return { kind: "slash-dashboard", raw, filter: argFilter };
  }

  // 未知或未写完的命令名 → 目录模糊过滤
  return { kind: "slash-catalog", raw, filter: cmdToken };
}

function catalogNames(entry: SlashCatalogEntry): string[] {
  return [entry.id, ...(entry.aliases ?? [])];
}

export function matchSlashCatalog(filter: string): SlashCatalogEntry[] {
  const q = filter.trim().toLowerCase();
  if (!q) return [...SLASH_COMMAND_CATALOG];
  return SLASH_COMMAND_CATALOG.filter((entry) =>
    catalogNames(entry).some(
      (name) => name.startsWith(q) || fuzzyMatchModelName(name, q),
    ),
  );
}

export type SlashModelRow = {
  id: string;
  selectionId: string;
  label: string;
  subtitle: string;
  current: boolean;
  score: number;
};

export type SlashDashboardRow = {
  id: string;
  tabId: string;
  label: string;
  kind: "builtin" | "custom";
  widgetCount?: number;
  current: boolean;
  score: number;
};

function scoreHaystack(haystack: string, needle: string): number | null {
  if (!needle) return 10;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h === n) return 100;
  if (h.startsWith(n)) return 80;
  if (h.includes(n)) return 50;
  if (fuzzyMatchModelName(haystack, needle)) return 35;
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

/** 列出已启用的 CLI 模型，支持模糊过滤。 */
export function buildSlashModelRows(
  models: Array<{ value: string; label: string; subtitle?: string }>,
  filter: string,
  currentSelectionId: string | null,
): SlashModelRow[] {
  const needle = filter.trim();
  const rows: SlashModelRow[] = [];

  for (const model of models) {
    const label = model.label;
    const subtitle = model.subtitle ?? "";
    const score = bestScore(scoreHaystack(label, needle), scoreHaystack(subtitle, needle));
    if (score == null) continue;

    rows.push({
      id: `slash-model:${model.value}`,
      selectionId: model.value,
      label,
      subtitle,
      current: currentSelectionId === model.value,
      score,
    });
  }

  rows.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });

  return rows;
}

/** 解析当前助手场景配置到合法 CLI selectionId（可能为 null）。 */
export function resolveSlashModelCurrentId(
  models: Array<{ value: string }>,
  configuredId: string | null,
): string | null {
  if (configuredId && models.some((m) => m.value === configuredId)) {
    return configuredId;
  }
  return models[0]?.value ?? null;
}

/**
 * 看板列表行。`resolveLabel` 用于内置 board 的本地化名。
 */
export function buildSlashDashboardRows(
  entries: DashboardCatalogEntry[],
  filter: string,
  activeTabId: string | null | undefined,
  resolveLabel: (entry: DashboardCatalogEntry) => string,
): SlashDashboardRow[] {
  const needle = filter.trim();
  const rows: SlashDashboardRow[] = [];

  for (const entry of entries) {
    const label = resolveLabel(entry);
    const score = bestScore(
      scoreHaystack(label, needle),
      scoreHaystack(entry.tabId, needle),
      entry.label ? scoreHaystack(entry.label, needle) : null,
    );
    if (score == null) continue;
    rows.push({
      id: `slash-dash:${entry.tabId}`,
      tabId: entry.tabId,
      label,
      kind: entry.kind,
      widgetCount: entry.widgetCount,
      current: activeTabId === entry.tabId,
      score,
    });
  }

  rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "builtin" ? -1 : 1;
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });

  return rows;
}
