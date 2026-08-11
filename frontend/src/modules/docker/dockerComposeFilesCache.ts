import type { DockerComposeProjectFiles } from "../../ipc/bindings";
import { debugCompose } from "./dockerComposeDebug";

/** 按「连接 + 项目」持久化的 compose/.env 内容缓存（SWR 用）。 */
export type ComposeFilesCacheEntry = {
  connectionId: string;
  project: string;
  workingDir: string | null;
  configFile: string | null;
  files: DockerComposeProjectFiles;
  fetchedAt: number;
};

const STORAGE_KEY = "omnipanel.docker.composeFiles.v1";
/** 新鲜：激活面板时可跳过远端拉取 */
export const COMPOSE_FILES_FRESH_TTL_MS = 60_000;
/** 过期但仍可展示：SWR 先渲染再后台刷新 */
export const COMPOSE_FILES_STALE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 40;
/** 单条内容上限（字符），防止 localStorage 爆 */
const MAX_CONTENT_CHARS = 400_000;

const memoryCache = new Map<string, ComposeFilesCacheEntry>();
let storageHydrated = false;

export function composeFilesProjectCacheKey(connectionId: string, project: string): string {
  return `${connectionId}::${project.trim()}`;
}

function hydrateFromStorage(): void {
  if (storageHydrated) return;
  storageHydrated = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { entries?: ComposeFilesCacheEntry[] };
    const now = Date.now();
    for (const entry of parsed.entries ?? []) {
      if (!entry?.connectionId || !entry?.project || !entry?.files) continue;
      if (now - entry.fetchedAt > COMPOSE_FILES_STALE_MAX_AGE_MS) continue;
      memoryCache.set(composeFilesProjectCacheKey(entry.connectionId, entry.project), entry);
    }
    debugCompose("composeFilesCache hydrate", { count: memoryCache.size });
  } catch {
    // ignore corrupt storage
  }
}

function persistToStorage(): void {
  try {
    const entries = [...memoryCache.values()]
      .sort((a, b) => b.fetchedAt - a.fetchedAt)
      .slice(0, MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries }));
  } catch {
    // quota / private mode：忽略，内存缓存仍可用
  }
}

function contentTooLarge(files: DockerComposeProjectFiles): boolean {
  return files.composeContent.length + files.envContent.length > MAX_CONTENT_CHARS;
}

export function isComposeFilesCacheFresh(entry: ComposeFilesCacheEntry, now = Date.now()): boolean {
  return now - entry.fetchedAt < COMPOSE_FILES_FRESH_TTL_MS;
}

export function isComposeFilesCacheUsable(entry: ComposeFilesCacheEntry, now = Date.now()): boolean {
  return now - entry.fetchedAt < COMPOSE_FILES_STALE_MAX_AGE_MS;
}

export function peekComposeFilesCache(
  connectionId: string,
  project: string,
): ComposeFilesCacheEntry | undefined {
  hydrateFromStorage();
  const entry = memoryCache.get(composeFilesProjectCacheKey(connectionId, project));
  if (!entry) return undefined;
  if (!isComposeFilesCacheUsable(entry)) {
    memoryCache.delete(composeFilesProjectCacheKey(connectionId, project));
    persistToStorage();
    return undefined;
  }
  return entry;
}

export function writeComposeFilesCache(
  connectionId: string,
  project: string,
  files: DockerComposeProjectFiles,
  paths?: { workingDir?: string | null; configFile?: string | null },
): void {
  hydrateFromStorage();
  if (contentTooLarge(files)) {
    debugCompose("composeFilesCache 跳过写入：内容过大", {
      connectionId,
      project,
      composeBytes: files.composeContent.length,
      envBytes: files.envContent.length,
    });
    return;
  }
  const key = composeFilesProjectCacheKey(connectionId, project);
  const entry: ComposeFilesCacheEntry = {
    connectionId,
    project: project.trim(),
    workingDir: paths?.workingDir ?? files.workingDir ?? null,
    configFile: paths?.configFile ?? null,
    files,
    fetchedAt: Date.now(),
  };
  memoryCache.set(key, entry);
  // 超额时删最旧
  if (memoryCache.size > MAX_ENTRIES) {
    const sorted = [...memoryCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    const removeCount = memoryCache.size - MAX_ENTRIES;
    for (let i = 0; i < removeCount; i += 1) {
      memoryCache.delete(sorted[i]![0]);
    }
  }
  persistToStorage();
}

export function invalidateComposeFilesCache(connectionId: string, project?: string): void {
  hydrateFromStorage();
  if (project) {
    memoryCache.delete(composeFilesProjectCacheKey(connectionId, project));
  } else {
    const prefix = `${connectionId}::`;
    for (const key of memoryCache.keys()) {
      if (key.startsWith(prefix)) memoryCache.delete(key);
    }
  }
  persistToStorage();
}
