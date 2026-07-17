const PREFIX = "[docker_stats]";

/** 开发模式下输出容器 stats 拉取调试信息（DevTools Console）。 */
export function debugStats(message: string, data?: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  if (data !== undefined) {
    console.debug(PREFIX, message, data);
    return;
  }
  console.debug(PREFIX, message);
}

/** 超时 / 失败时用 warn，便于在 Console 里过滤。 */
export function warnStats(message: string, data?: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  if (data !== undefined) {
    console.warn(PREFIX, message, data);
    return;
  }
  console.warn(PREFIX, message);
}
