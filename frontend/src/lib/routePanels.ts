import {
  DASHBOARD_PATH,
  isDashboardPath,
  isPluginsPath,
  isWorkspacePath,
  moduleKeyFromPath,
  type ModuleKey,
} from "./paths";

/** 含 dockview / 需保活的模块：叠层路由，禁止 display:none */
export const OVERLAY_MODULE_KEYS = [
  "terminal",
  "ssh",
  "docker",
  "database",
  "files",
  "server",
  "protocol",
  "workflow",
  "knowledge",
  "tasks",
  "cloud",
] as const satisfies readonly ModuleKey[];

export type OverlayModuleKey = (typeof OVERLAY_MODULE_KEYS)[number];

export function isOverlayModuleKey(key: string | null): key is OverlayModuleKey {
  return key != null && (OVERLAY_MODULE_KEYS as readonly string[]).includes(key);
}

export function isOverlayModulePath(pathname: string): boolean {
  return isOverlayModuleKey(moduleKeyFromPath(pathname));
}

/** 看板 / 工程工作区 — 走轻量 shell 路由 */
export function isShellRoutePath(pathname: string): boolean {
  return isDashboardPath(pathname) || isWorkspacePath(pathname) || isPluginsPath(pathname);
}

/**
 * 叠层模块初始挂载：仅当前路由对应模块。
 * 运行时挂载由 overlayKeepAlive「当前 + 最近 1」控制；禁止 idle 全量挂壳。
 */
export function createInitialOverlayMounted(
  pathname: string,
): Record<OverlayModuleKey, boolean> {
  const mounted = Object.fromEntries(
    OVERLAY_MODULE_KEYS.map((key) => [key, false]),
  ) as Record<OverlayModuleKey, boolean>;
  const key = moduleKeyFromPath(pathname);
  if (isOverlayModuleKey(key)) {
    mounted[key] = true;
  }
  return mounted;
}

/**
 * @deprecated 勿在首帧调用。
 * 若需要「逻辑上全 false 的空表」请用 createInitialOverlayMounted("")；
 * chunk 预热请用 moduleWarmup.scheduleIdleOverlayShellWarm（不再挂壳）。
 */
export function createOverlayMountedAll(): Record<OverlayModuleKey, boolean> {
  return createInitialOverlayMounted("");
}

export { DASHBOARD_PATH };
