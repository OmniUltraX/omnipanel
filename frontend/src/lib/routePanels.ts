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
 * 叠层模块初始挂载：仅当前路由对应模块。
 * 禁止在启动首帧同步将全部模块置 true（会阻塞 LCP）；
 * 全量 ShellReady 应走 idle/`startTransition` 的 `scheduleIdleOverlayShellWarm`。
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
 * 全量挂壳请用 moduleWarmup.scheduleIdleOverlayShellWarm。
 */
export function createOverlayMountedAll(): Record<OverlayModuleKey, boolean> {
  return createInitialOverlayMounted("");
}

export { DASHBOARD_PATH };
