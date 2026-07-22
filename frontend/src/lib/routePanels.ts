import {
  DASHBOARD_PATH,
  MODULE_PATHS,
  isDashboardPath,
  isWorkspacePath,
  moduleKeyFromPath,
  type ModuleKey,
} from "./paths";

/** 含 dockview / 需保活的模块：叠层路由，禁止 display:none */
export const OVERLAY_MODULE_KEYS = [
  "terminal",
  "docker",
  "database",
  "files",
  "server",
  "protocol",
  "workflow",
  "knowledge",
  "tasks",
] as const satisfies readonly ModuleKey[];

export type OverlayModuleKey = (typeof OVERLAY_MODULE_KEYS)[number];

export function isOverlayModuleKey(key: string | null): key is OverlayModuleKey {
  return key != null && (OVERLAY_MODULE_KEYS as readonly string[]).includes(key);
}

export function isOverlayModulePath(pathname: string): boolean {
  return isOverlayModuleKey(moduleKeyFromPath(pathname));
}

/** 看板 / 工程工作区 / SSH 重定向 — 走轻量 shell 路由 */
export function isShellRoutePath(pathname: string): boolean {
  return (
    isDashboardPath(pathname) ||
    isWorkspacePath(pathname) ||
    pathname === MODULE_PATHS.ssh
  );
}

/**
 * 叠层模块按需挂载：仅挂载当前路由对应模块。
 * 禁止启动时全量挂载，否则首页会同步拉起终端/数据库等重型面板，主线程卡死数秒。
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

/** @deprecated 使用 createInitialOverlayMounted；保留以免外部误用全量挂载 */
export function createOverlayMountedAll(): Record<OverlayModuleKey, boolean> {
  return createInitialOverlayMounted("");
}

export { DASHBOARD_PATH };
