/** 全局资源标签键名约定（存为 `key:value` 字符串）。 */
export const RESOURCE_TAG_KEYS = {
  /** 远程系统发行版，如 Ubuntu 24.04.2 LTS */
  os: "os",
  /** 内核版本 */
  kernel: "kernel",
  /** 架构，如 x86_64 */
  arch: "arch",
} as const;

export type ResourceTagKey = keyof typeof RESOURCE_TAG_KEYS | string;

export function formatResourceTag(key: string, value: string): string {
  return `${key}:${value.trim()}`;
}

export function parseResourceTag(tag: string): { key: string; value: string } {
  const idx = tag.indexOf(":");
  if (idx <= 0) return { key: "custom", value: tag };
  return { key: tag.slice(0, idx), value: tag.slice(idx + 1) };
}

export function getResourceTagValue(
  tags: string[] | undefined,
  key: string,
): string | null {
  if (!tags?.length) return null;
  const prefix = `${key}:`;
  const hit = tags.find((t) => t.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

export function upsertResourceTag(
  tags: string[] | undefined,
  key: string,
  value: string,
): string[] {
  const trimmed = value.trim();
  const prefix = `${key}:`;
  const rest = (tags ?? []).filter((t) => !t.startsWith(prefix));
  if (trimmed) rest.push(formatResourceTag(key, trimmed));
  return rest;
}

/** 保序去重（区分大小写，按原串去重）。 */
export function uniqueTags(tags: string[] | undefined | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags ?? []) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/** 展示用：去重 + 已知键优先，其余按原序。 */
export function sortTagsForDisplay(tags: string[]): string[] {
  const knownOrder = Object.values(RESOURCE_TAG_KEYS);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const tag of tags) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    unique.push(tag);
  }
  return unique.sort((a, b) => {
    const ak = parseResourceTag(a).key;
    const bk = parseResourceTag(b).key;
    const ai = knownOrder.indexOf(ak as (typeof knownOrder)[number]);
    const bi = knownOrder.indexOf(bk as (typeof knownOrder)[number]);
    const ar = ai === -1 ? 99 : ai;
    const br = bi === -1 ? 99 : bi;
    if (ar !== br) return ar - br;
    return a.localeCompare(b);
  });
}
