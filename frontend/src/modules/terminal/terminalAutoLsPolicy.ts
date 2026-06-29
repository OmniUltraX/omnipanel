import { normalizeBlockCommand } from "./terminalOutputText";
import { isInternalHistoryCommand } from "./commandBar/internalHistoryCommands";
import {
  adaptAutoLsCommandForShell,
  joinCdWithListCommand,
  type TerminalShellFamily,
} from "./terminalAutoLsShell";

const AUTO_LS_BASES = new Set(["ls", "dir", "ll", "la", "l", "get-childitem", "gci"]);

/** 校验并归一化自动 ls 子命令（默认 ls） */
export function normalizeAutoLsCommand(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "ls";
  if (/[;&|><`{}\n\r]/.test(trimmed)) return "ls";
  const base = trimmed.split(/\s+/)[0] ?? "";
  const baseLower = base.toLowerCase();
  if (
    !AUTO_LS_BASES.has(baseLower) &&
    !baseLower.endsWith("/ls") &&
    !baseLower.endsWith("\\ls")
  ) {
    return "ls";
  }
  return trimmed;
}

/** 判断是否为单独的 cd 命令（不含 &&、;、管道等） */
export function isCdOnlyCommand(command: string): boolean {
  const cmd = normalizeBlockCommand(command).trim();
  if (!cmd || isInternalHistoryCommand(cmd)) return false;
  if (!/^cd(?:\s+|$)/i.test(cmd)) return false;
  if (/[;&|]/.test(cmd)) return false;
  return true;
}

/** 展示用：去掉自动拼接的列表后缀 */
export function stripAutoLsSuffix(command: string): string {
  const cmd = normalizeBlockCommand(command).trim();

  const psMatch = /^(cd(?:\s+.+)?)\s*;\s*if\s*\(\$\?\)\s*\{.+}\s*$/is.exec(cmd);
  if (psMatch && isCdOnlyCommand(psMatch[1]!.trim())) {
    return psMatch[1]!.trim();
  }

  const andMatch = /^(cd(?:\s+.+)?)\s*&&\s+.+$/is.exec(cmd);
  if (andMatch && isCdOnlyCommand(andMatch[1]!.trim())) {
    return andMatch[1]!.trim();
  }

  return cmd;
}

/** 展示/完成语义上的 cd 导航（含自动拼接 ls 的复合命令） */
export function isCdNavigationCommand(command: string): boolean {
  const display = stripAutoLsSuffix(normalizeBlockCommand(command).trim());
  return isCdOnlyCommand(display);
}

/** 将单独 cd 与 ls 子命令拼成一条 */
export function buildCdWithAutoLs(
  command: string,
  lsCommand: string,
  shell: TerminalShellFamily = "posix",
): string {
  if (!isCdOnlyCommand(command)) return command;
  const adapted = adaptAutoLsCommandForShell(normalizeAutoLsCommand(lsCommand), shell);
  return joinCdWithListCommand(command, adapted, shell);
}
