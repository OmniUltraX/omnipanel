/** 全局资源标签。系统标签存成树路径 `sys/os/Ubuntu`，旧的 `os:Ubuntu` 仍能读。 */
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

const SYSTEM_TAG_KEYS = new Set([
  "os",
  "kernel",
  "arch",
  "db",
  "engine",
  "panel",
  "creator",
  "origin",
]);

export function parseResourceTag(tag: string): { key: string; value: string } {
  const text = tag.trim();
  const lower = text.toLowerCase();
  if (lower.startsWith("sys/")) {
    const rest = text.slice("sys/".length);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      const key = rest.slice(0, slash).trim().toLowerCase();
      const value = rest.slice(slash + 1).trim();
      if (key && value) return { key, value };
    }
  }
  const idx = text.indexOf(":");
  if (idx <= 0) return { key: "custom", value: text };
  return {
    key: text.slice(0, idx).trim().toLowerCase(),
    value: text.slice(idx + 1).trim(),
  };
}

function storedTag(key: string, value: string): string {
  const name = key.trim().toLowerCase();
  if (SYSTEM_TAG_KEYS.has(name)) return `sys/${name}/${value.trim()}`;
  return formatResourceTag(key, value);
}

export function getResourceTagValue(
  tags: string[] | undefined,
  key: string,
): string | null {
  if (!tags?.length) return null;
  const needle = key.trim().toLowerCase();
  for (const tag of tags) {
    const parsed = parseResourceTag(tag);
    if (parsed.key === needle && parsed.value) return parsed.value;
  }
  return null;
}

export function upsertResourceTag(
  tags: string[] | undefined,
  key: string,
  value: string,
): string[] {
  const trimmed = value.trim();
  const needle = key.trim().toLowerCase();
  const rest = (tags ?? []).filter((tag) => parseResourceTag(tag).key !== needle);
  if (trimmed) rest.push(storedTag(key, trimmed));
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
