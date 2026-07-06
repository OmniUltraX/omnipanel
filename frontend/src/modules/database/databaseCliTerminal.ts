import { findTerminalPane } from "../../stores/terminalStore";

export const DB_CLI_EMBEDDED_PREFIX = "db-cli:";

const DATABASE_CLI_PURPOSES = new Set(["MySQL CLI", "Redis CLI"]);

/** 数据库连接信息面板的嵌入式 CLI 终端（mysql / redis-cli），不应注入 shell 集成脚本。 */
export function isDatabaseCliTerminalSession(
  sessionId: string,
  purpose?: string | null,
): boolean {
  if (sessionId.startsWith(DB_CLI_EMBEDDED_PREFIX)) {
    return true;
  }
  return Boolean(purpose && DATABASE_CLI_PURPOSES.has(purpose));
}

export function isDatabaseCliTerminalPane(sessionId: string): boolean {
  const pane = findTerminalPane(sessionId);
  return isDatabaseCliTerminalSession(sessionId, pane?.purpose);
}

export function dbCliEmbeddedPaneId(connectionId: string): string {
  return `${DB_CLI_EMBEDDED_PREFIX}${connectionId}`;
}
