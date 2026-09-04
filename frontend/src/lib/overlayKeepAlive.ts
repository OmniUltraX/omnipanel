import {
  isOverlayModuleKey,
  OVERLAY_MODULE_KEYS,
  type OverlayModuleKey,
} from "./routePanels";
import { moduleKeyFromPath, pluginModuleKeyFromPath } from "./paths";
import type { WorkspaceDockTab } from "../stores/workspaceBottomDockStore";

/** 叠层内核模块或插件模块的保活 id */
export type KeepAliveModuleId = OverlayModuleKey | `plugin:${string}`;

/** 当前 + 最近 N 个（不含当前） */
export const OVERLAY_KEEP_ALIVE_RECENT_LIMIT = 1;

export interface OverlayKeepAliveState {
  current: KeepAliveModuleId | null;
  /** MRU 在前，不含 current */
  recent: KeepAliveModuleId[];
}

export function isKeepAliveModuleId(id: string): id is KeepAliveModuleId {
  if (isOverlayModuleKey(id)) return true;
  return id.startsWith("plugin:") && id.length > "plugin:".length;
}

export function keepAliveIdFromPath(pathname: string): KeepAliveModuleId | null {
  const key = moduleKeyFromPath(pathname);
  if (isOverlayModuleKey(key)) return key;
  const plugin = pluginModuleKeyFromPath(pathname);
  if (plugin) return `plugin:${plugin}`;
  return null;
}

export function pluginKeyFromKeepAliveId(id: KeepAliveModuleId): string | null {
  return id.startsWith("plugin:") ? id.slice("plugin:".length) : null;
}

export function createInitialKeepAliveState(
  pathname: string,
): OverlayKeepAliveState {
  return {
    current: keepAliveIdFromPath(pathname),
    recent: [],
  };
}

/**
 * 路由切换时推进保活窗口：当前模块 + 最近 RECENT_LIMIT 个。
 * pinned 始终保留（如工作区底部仍挂着数据库镜像 Tab）。
 */
export function touchOverlayKeepAlive(
  prev: OverlayKeepAliveState,
  nextCurrent: KeepAliveModuleId | null,
): OverlayKeepAliveState {
  if (prev.current === nextCurrent) {
    return prev;
  }

  let recent = prev.recent.filter((id) => id !== nextCurrent);
  if (prev.current != null && prev.current !== nextCurrent) {
    recent = [prev.current, ...recent.filter((id) => id !== prev.current)];
  }
  recent = recent.slice(0, OVERLAY_KEEP_ALIVE_RECENT_LIMIT);

  return { current: nextCurrent, recent };
}

/** 应挂载的保活集合 = current ∪ recent ∪ pinned */
export function resolveOverlayKeepAliveMounted(
  state: OverlayKeepAliveState,
  pinned: ReadonlySet<KeepAliveModuleId> = new Set(),
): Set<KeepAliveModuleId> {
  const mounted = new Set<KeepAliveModuleId>(pinned);
  if (state.current) mounted.add(state.current);
  for (const id of state.recent) mounted.add(id);
  return mounted;
}

export function overlayMountedRecordFromKeepAlive(
  mounted: ReadonlySet<KeepAliveModuleId>,
): Record<OverlayModuleKey, boolean> {
  return Object.fromEntries(
    OVERLAY_MODULE_KEYS.map((key) => [key, mounted.has(key)]),
  ) as Record<OverlayModuleKey, boolean>;
}

export function pluginKeysFromKeepAlive(
  mounted: ReadonlySet<KeepAliveModuleId>,
): string[] {
  const keys: string[] = [];
  for (const id of mounted) {
    const plugin = pluginKeyFromKeepAliveId(id);
    if (plugin) keys.push(plugin);
  }
  return keys;
}

/**
 * 工作区底部仍依赖某模块时，该模块必须常驻（否则镜像/payload Tab 会失效）。
 */
export function collectPinnedKeepAliveIds(
  tabsByWorkspace: Record<string, WorkspaceDockTab[] | undefined>,
): Set<KeepAliveModuleId> {
  const pinned = new Set<KeepAliveModuleId>();
  for (const tabs of Object.values(tabsByWorkspace)) {
    for (const tab of tabs ?? []) {
      if (
        (tab.kind === "mirrored" && tab.originScope === "database") ||
        (tab.kind === "payload" && tab.payload?.module === "database")
      ) {
        pinned.add("database");
      }
      if (
        (tab.kind === "mirrored" && tab.originScope === "terminal") ||
        (tab.kind === "payload" && tab.payload?.module === "terminal")
      ) {
        pinned.add("terminal");
      }
    }
  }
  return pinned;
}
