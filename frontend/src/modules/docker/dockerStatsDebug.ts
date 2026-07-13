const PREFIX = "[docker-stats]";

/** 输出容器 stats 调试信息（使用 console.log，默认日志级别可见）。控制台过滤 `docker-stats`。 */
export function debugDockerStats(message: string, data?: Record<string, unknown>): void {
  if (data !== undefined) {
    console.log(PREFIX, message, data);
    return;
  }
  console.log(PREFIX, message);
}

export function normalizeStatsId(id: string): string {
  return id.trim().toLowerCase().replace(/^sha256:/, "");
}
