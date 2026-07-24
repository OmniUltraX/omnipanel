/**
 * cross-dock / dockview 转移调试日志。
 * 默认关闭（含 DEV），避免 Performance「控制台任务」占满主线程。
 * 开启：localStorage.setItem("omnipanel-cross-dock-debug", "1")
 */
export const CROSS_DOCK_DEBUG =
  typeof localStorage !== "undefined" &&
  localStorage.getItem("omnipanel-cross-dock-debug") === "1";

export function crossDockDebugInfo(message: string, ...args: unknown[]): void {
  if (!CROSS_DOCK_DEBUG) return;
  // eslint-disable-next-line no-console
  console.info(message, ...args);
}

export function crossDockDebugWarn(message: string, ...args: unknown[]): void {
  if (!CROSS_DOCK_DEBUG) return;
  // eslint-disable-next-line no-console
  console.warn(message, ...args);
}

export function crossDockDebugError(message: string, ...args: unknown[]): void {
  // 错误路径仍默认输出；仅 info/warn 需 flag
  if (!CROSS_DOCK_DEBUG && !import.meta.env.DEV) return;
  // eslint-disable-next-line no-console
  console.error(message, ...args);
}
