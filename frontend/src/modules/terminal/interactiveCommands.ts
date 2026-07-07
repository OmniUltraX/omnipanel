/**
 * 交互式命令白名单 —— 仅用于 AI 自动分析等策略避让。
 *
 * Warp 命令运行期统一展示 live xterm，不再通过白名单切换原生模式。
 */

const INTERACTIVE_COMMAND_NAMES = new Set([
  "python",
  "python3",
  "ipython",
  "node",
  "irb",
  "ruby",
]);

const INTERACTIVE_WRAPPERS = new Set(["npx", "bunx", "pnpx", "pnpm", "uv", "uvx"]);

function commandBaseName(token: string): string {
  return token.replace(/^.*[/\\]/, "").replace(/\.exe$/i, "").toLowerCase();
}

/** 这些命令通常需要人工交互，避免结束后被 AI 失败分析误处理。 */
export function isInteractiveTerminalCommandFallback(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  const tokens = trimmed.split(/\s+/);
  let candidate = tokens[0] ?? "";
  if (tokens.length >= 2 && INTERACTIVE_WRAPPERS.has(candidate.toLowerCase())) {
    candidate = tokens[1] ?? candidate;
  }

  return INTERACTIVE_COMMAND_NAMES.has(commandBaseName(candidate));
}
