/**
 * 系统应用目录：后端枚举 + 前端模糊匹配（plain 查询混排）。
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../isTauriRuntime";
import type { QuickLaunchMatchRow } from "../quickLauncherMatch";

export type SystemAppEntry = {
  id: string;
  name: string;
  path: string;
  source: string;
  /** 可搜索别名（如 calc）；缺省按空数组处理 */
  aliases?: string[];
};

const MAX_APP_RESULTS = 8;
const CACHE_TTL_MS = 5 * 60_000;

let cachedApps: SystemAppEntry[] = [];
let cachedAt = 0;
let inflight: Promise<SystemAppEntry[]> | null = null;

/** appId → data URL；null 表示已请求但无图标 */
const iconCache = new Map<string, string | null>();
const iconInflight = new Map<string, Promise<void>>();

function scoreText(haystack: string, needle: string): number | null {
  if (!needle) return 10;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (!n) return 10;
  if (h === n) return 100;
  if (h.startsWith(n)) return 80;
  if (h.includes(n)) return 50;
  // 子序列：n o t e → notepad
  let hi = 0;
  for (let ni = 0; ni < n.length; ni += 1) {
    const ch = n[ni];
    let found = false;
    while (hi < h.length) {
      if (h[hi] === ch) {
        found = true;
        hi += 1;
        break;
      }
      hi += 1;
    }
    if (!found) return null;
  }
  return 35;
}

export async function listSystemApps(options?: {
  forceRefresh?: boolean;
}): Promise<SystemAppEntry[]> {
  if (!isTauriRuntime()) return [];
  const force = options?.forceRefresh === true;
  const now = Date.now();
  if (!force && cachedApps.length > 0 && now - cachedAt < CACHE_TTL_MS) {
    return cachedApps;
  }
  if (!force && inflight) return inflight;

  inflight = (async () => {
    try {
      const apps = await invoke<SystemAppEntry[]>("list_system_apps", {
        forceRefresh: force,
      });
      cachedApps = Array.isArray(apps) ? apps : [];
      cachedAt = Date.now();
      return cachedApps;
    } catch (e) {
      console.warn("[quickLauncher] list_system_apps failed", e);
      return cachedApps;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

export async function launchSystemApp(id: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const trimmed = id.trim();
  if (!trimmed) return;
  await invoke("launch_system_app", { id: trimmed });
}

/** 已缓存的图标 URL（无则 undefined；明确失败为 null）。 */
export function getCachedSystemAppIcon(appId: string): string | null | undefined {
  if (!iconCache.has(appId)) return undefined;
  return iconCache.get(appId) ?? null;
}

/**
 * 按需拉取图标。返回合并后的 appId → data URL（仅成功项）。
 * 已缓存 / 失败的不会重复请求。
 */
export async function ensureSystemAppIcons(
  appIds: string[],
): Promise<Record<string, string>> {
  if (!isTauriRuntime()) return {};
  const need: string[] = [];
  for (const id of appIds) {
    const key = id.trim();
    if (!key) continue;
    if (iconCache.has(key)) continue;
    if (iconInflight.has(key)) continue;
    need.push(key);
  }

  if (need.length > 0) {
    const task = (async () => {
      try {
        const map = await invoke<Record<string, string>>("get_system_app_icons", {
          ids: need,
        });
        for (const id of need) {
          const url = map?.[id];
          iconCache.set(id, typeof url === "string" && url.length > 0 ? url : null);
        }
      } catch (e) {
        console.warn("[quickLauncher] get_system_app_icons failed", e);
        for (const id of need) {
          if (!iconCache.has(id)) iconCache.set(id, null);
        }
      } finally {
        for (const id of need) iconInflight.delete(id);
      }
    })();
    for (const id of need) iconInflight.set(id, task);
    await task;
  }

  // 等其它并发请求
  const pending = appIds
    .map((id) => iconInflight.get(id.trim()))
    .filter((p): p is Promise<void> => !!p);
  if (pending.length > 0) {
    await Promise.all(pending);
  }

  const out: Record<string, string> = {};
  for (const id of appIds) {
    const url = iconCache.get(id.trim());
    if (url) out[id.trim()] = url;
  }
  return out;
}

/** 按名称 / 别名模糊匹配系统应用，生成快捷面板行。 */
export function matchSystemApps(
  apps: SystemAppEntry[],
  filter: string,
): QuickLaunchMatchRow[] {
  const needle = filter.trim();
  if (!needle || apps.length === 0) return [];

  const rows: QuickLaunchMatchRow[] = [];
  for (const app of apps) {
    const texts = [app.name, ...(app.aliases ?? [])];
    let best: number | null = null;
    for (const text of texts) {
      const score = scoreText(text, needle);
      if (score == null) continue;
      if (best == null || score > best) best = score;
    }
    if (best == null) continue;
    rows.push({
      type: "system-app",
      id: `app:${app.id}`,
      appId: app.id,
      path: app.path,
      label: app.name,
      // 不展示绝对路径；类型标签由列表左侧图标 /「应用」文案承担
      subtitle: "",
      score: best,
    });
  }

  return rows
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.label.localeCompare(b.label);
    })
    .slice(0, MAX_APP_RESULTS);
}
