/** 连接类资源（SSH / DB / Docker / Files / Server 等统一 connections 表 + 双轨 DB id） */
export const CONNECTION_TAG_KINDS = ["connection"] as const;

export const KNOWLEDGE_TAG_KINDS = ["knowledge"] as const;

export const PROTOCOL_TAG_KINDS = [
  "http_request",
  "http_collection",
  "http_environment",
] as const;

const SYSTEM_TAG_KEYS = new Set(["os", "kernel", "arch", "db", "engine", "panel"]);

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

/** 保存时合并系统标签，避免覆盖自动采集结果 */
export function mergeConnectionTags(
  userTags: string[],
  existingTags: string[] | undefined | null,
): string[] {
  const system = (existingTags ?? []).filter(isSystemConnectionTag);
  const seen = new Set(system.map((t) => t.toLowerCase()));
  const merged = [...system];
  for (const tag of userTags) {
    const key = tag.trim().toLowerCase();
    if (!key || seen.has(key) || isSystemConnectionTag(tag)) continue;
    seen.add(key);
    merged.push(tag.trim());
  }
  return merged;
}
