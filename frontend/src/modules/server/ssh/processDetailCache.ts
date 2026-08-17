import type { SshProcessDetail } from "@/ipc/bindings";

const MAX_ENTRIES = 64;
const cache = new Map<string, SshProcessDetail>();

function cacheKey(resourceId: string, pid: number): string {
  return `${resourceId}:${pid}`;
}

export function getCachedProcessDetail(
  resourceId: string,
  pid: number,
): SshProcessDetail | undefined {
  return cache.get(cacheKey(resourceId, pid));
}

export function setCachedProcessDetail(
  resourceId: string,
  pid: number,
  detail: SshProcessDetail,
): void {
  const key = cacheKey(resourceId, pid);
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, detail);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

export function clearCachedProcessDetail(resourceId: string, pid: number): void {
  cache.delete(cacheKey(resourceId, pid));
}

export function resolveProcessCommandLine(
  detail: SshProcessDetail | null | undefined,
  listCommand?: string | null,
): string {
  const line = detail?.commandLine?.trim();
  if (line) return line;
  if (detail?.args?.length) {
    return detail.args.join(" ");
  }
  return listCommand?.trim() ?? "";
}
