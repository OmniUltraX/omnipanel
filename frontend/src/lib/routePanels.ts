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



/** 叠层模块全部常驻挂载（仅 visibility 切换），切换零重载 */

export function createOverlayMountedAll(): Record<OverlayModuleKey, boolean> {

  return Object.fromEntries(

    OVERLAY_MODULE_KEYS.map((key) => [key, true]),

  ) as Record<OverlayModuleKey, boolean>;

}



/** @deprecated 使用 createOverlayMountedAll */

export function createInitialOverlayMounted(

  _pathname?: string,

): Record<OverlayModuleKey, boolean> {

  return createOverlayMountedAll();

}



export { DASHBOARD_PATH };


