const PREFIX = "[docker-compose]";

/** 开发模式下输出 Compose 文件读写调试信息。 */
export function debugCompose(message: string, data?: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  if (data !== undefined) {
    console.debug(PREFIX, message, data);
    return;
  }
  console.debug(PREFIX, message);
}
