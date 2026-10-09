/** 常用模型只留最近选过的，避免把整份目录都钉到顶部。 */
export const RECENT_MODEL_LIMIT = 6;

export function normalizeRecentModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length >= RECENT_MODEL_LIMIT) break;
  }
  return out;
}

/** 把刚选中的模型放到最前，同 id 只保留一次。 */
export function rememberRecentModelIds(current: readonly string[], id: string): string[] {
  const next = id.trim();
  if (!next) return normalizeRecentModelIds(current);
  return normalizeRecentModelIds([next, ...current]);
}

type Grouped<T> = T & { group?: string };

/**
 * 常用在前，且不在下方目录里再出现一次。
 * 下面已经没有别的模型时不挂分组，避免只有一项还多一行标题。
 */
export function withRecentModelGroup<T extends { value: string }>(
  options: readonly T[],
  recentIds: readonly string[],
  groupLabel: string,
): Grouped<T>[] {
  const byValue = new Map(options.map((opt) => [opt.value, opt]));
  const pinned: Grouped<T>[] = [];
  const seen = new Set<string>();
  for (const id of recentIds) {
    const opt = byValue.get(id);
    if (!opt || seen.has(id)) continue;
    seen.add(id);
    pinned.push({ ...opt, group: groupLabel });
    if (pinned.length >= RECENT_MODEL_LIMIT) break;
  }
  const rest = options.filter((opt) => !seen.has(opt.value));
  if (pinned.length === 0 || rest.length === 0) {
    return options.map((opt) => ({ ...opt }));
  }
  return [...pinned, ...rest];
}
