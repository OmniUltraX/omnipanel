/** 连接类资源（SSH / DB / Docker / Files / Server 等统一 connections 表 + 双轨 DB id） */
export const CONNECTION_TAG_KINDS = ["connection"] as const;

export const KNOWLEDGE_TAG_KINDS = ["knowledge"] as const;

export const PROTOCOL_TAG_KINDS = [
  "http_request",
  "http_collection",
  "http_environment",
] as const;

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

/** 系统采集标签（不在用户编辑器中展示） */
export function isSystemConnectionTag(tag: string): boolean {
  const trimmed = tag.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("sys/")) return true;
  const sep = trimmed.indexOf(":");
  if (sep <= 0) return false;
  return SYSTEM_TAG_KEYS.has(trimmed.slice(0, sep).trim().toLowerCase());
}

/** 编辑器展示的用户标签 */
export function userConnectionTags(tags: string[] | undefined | null): string[] {
  return (tags ?? []).filter((tag) => !isSystemConnectionTag(tag));
}

/** `creator:名称` 与 `sys/creator/名称` 都是创建者，返回名称。 */
export function creatorTagValue(tag: string): string | null {
  const text = tag.trim();
  const lower = text.toLowerCase();
  if (lower.startsWith("creator:")) {
    const value = text.slice("creator:".length).trim();
    return value || null;
  }
  if (lower.startsWith("sys/creator/")) {
    const value = text.slice("sys/creator/".length).trim();
    return value || null;
  }
  return null;
}

/** 创建者只留第一条，完全相同的标签只留一条。 */
export function canonicalConnectionTags(tags: readonly string[]): string[] {
  return uniqueConnectionTags(tags.filter((tag) => tag.trim()));
}

function canonicalSystemTag(tag: string): string | null {
  const text = tag.trim();
  const lower = text.toLowerCase();
  let key = "";
  let value = "";
  if (lower.startsWith("sys/")) {
    const rest = text.slice("sys/".length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    key = rest.slice(0, slash).trim().toLowerCase();
    value = rest.slice(slash + 1).trim();
  } else {
    const colon = text.indexOf(":");
    if (colon <= 0) return null;
    key = text.slice(0, colon).trim().toLowerCase();
    value = text.slice(colon + 1).trim();
  }
  if (!value || !SYSTEM_TAG_KEYS.has(key)) return null;
  return `sys/${key}/${value}`;
}

function uniqueConnectionTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const system: string[] = [];
  const users: string[] = [];
  let keptCreator = false;
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) continue;
    const systemTag = canonicalSystemTag(tag);
    if (systemTag) {
      if (systemTag.startsWith("sys/creator/")) {
        if (keptCreator) continue;
        keptCreator = true;
      }
      const key = systemTag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      system.push(systemTag);
      continue;
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    users.push(tag);
  }
  system.sort((left, right) => left.localeCompare(right));
  return [...system, ...users];
}

/** 保存时合并系统标签，避免覆盖自动采集结果 */
export function mergeConnectionTags(
  userTags: string[],
  existingTags: string[] | undefined | null,
): string[] {
  const system = (existingTags ?? []).filter(isSystemConnectionTag);
  const users = userTags.filter((tag) => {
    const text = tag.trim();
    return text && !isSystemConnectionTag(text);
  });
  return uniqueConnectionTags([...system, ...users]);
}
