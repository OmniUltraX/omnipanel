/**
 * 当前终端 PTY 执行工具（与 SSH 连接池 exec 分离）。
 *
 * - `omni_terminal_exec`：写当前/指定 Tab 的 PTY，继承 cwd/环境，生成可见命令块
 * - `omni_ssh_exec`：指定 SSH 主机的非交互 exec 通道，不碰当前终端 Tab
 */
export const TERMINAL_EXEC_TOOL_NAME = "omni_terminal_exec";
export const SSH_EXEC_TOOL_NAME = "omni_ssh_exec";

/** 历史「当前终端执行」别名 → omni_terminal_exec */
export const TERMINAL_PTY_EXEC_ALIASES = [
  "omni_terminal_run_terminal_command",
  "run_terminal_command",
] as const;

const PTY_EXEC_NAMES = new Set<string>([
  TERMINAL_EXEC_TOOL_NAME,
  ...TERMINAL_PTY_EXEC_ALIASES,
]);

export function isTerminalPtyExecTool(toolName: string): boolean {
  return PTY_EXEC_NAMES.has(toolName);
}

export function normalizeTerminalPtyExecToolName(toolName: string): string {
  if (isTerminalPtyExecTool(toolName)) return TERMINAL_EXEC_TOOL_NAME;
  return toolName;
}

function commandFromUnknown(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

/** 从已解析的 args 取命令（兼容 command / cmd）。 */
export function parseTerminalExecCommandFromArgs(
  args: Record<string, unknown>,
): string {
  return (
    commandFromUnknown(args.command) ||
    commandFromUnknown(args.cmd) ||
    commandFromUnknown(args.script)
  );
}

/** 从工具 arguments JSON 取命令（兼容 command / cmd）。 */
export function parseTerminalExecCommand(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    return parseTerminalExecCommandFromArgs(parsed);
  } catch {
    return "";
  }
}

export function argsHaveResourceId(argsJson: string): boolean {
  try {
    const parsed = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    return typeof parsed.resource_id === "string" && Boolean(parsed.resource_id.trim());
  } catch {
    return false;
  }
}
