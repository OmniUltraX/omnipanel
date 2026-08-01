import type { TerminalSessionType } from "@/stores/terminalStore";
import type { LocalShellSpec } from "@/stores/terminalTypes";

export type TerminalShellFamily = "posix" | "powershell" | "cmd";

/**
 * 根据会话类型、shell 标签与显式 shellSpec 推断命令拼接方式。
 *
 * 优先级：shellSpec.kind（最权威，建 tab 时由后端 ShellSpec 写入）>
 * shellLabel 关键字 > local+Windows 兜底。
 *
 * 关键：WSL 的 pane.type === "local" 且运行在 Windows 上，但它的 shell 是 bash/posix，
 * 绝不能走 Windows 兜底的 "powershell" 分支，否则 autoLs 会拼成
 * `cd '...'; if ($?) { ls }`（PowerShell 语法）发到 bash 报语法错。
 */
export function resolveTerminalShellFamily(
  sessionType: TerminalSessionType,
  shellLabel?: string | null,
  shellSpec?: LocalShellSpec | null,
): TerminalShellFamily {
  if (shellSpec) {
    if (shellSpec.kind === "wsl") return "posix";
    if (shellSpec.kind === "powershell" || shellSpec.kind === "powershell5") return "powershell";
    if (shellSpec.kind === "cmd") return "cmd";
    if (shellSpec.kind === "bash" || shellSpec.kind === "zsh" || shellSpec.kind === "fish") {
      return "posix";
    }
  }
  const label = (shellLabel ?? "").trim().toLowerCase();
  if (/powershell|pwsh/.test(label)) return "powershell";
  if (label === "cmd" || label === "cmd.exe") return "cmd";
  // WSL label 兜底（如 "Ubuntu (WSL)"），避免命中下方 Windows → powershell 兜底
  if (/\bwsl\b/.test(label)) return "posix";
  if (sessionType === "local" && typeof navigator !== "undefined" && /win/i.test(navigator.userAgent)) {
    return "powershell";
  }
  return "posix";
}

/** 按 shell 适配列表子命令（PowerShell / cmd 与 Unix ls 不同） */
export function adaptAutoLsCommandForShell(
  lsCommand: string,
  shell: TerminalShellFamily,
): string {
  const normalized = lsCommand.trim() || "ls";
  if (shell === "powershell") {
    if (/^ls(?:\s+-a|\s+--all)\b/i.test(normalized)) {
      return "Get-ChildItem -Force";
    }
    return normalized;
  }
  if (shell === "cmd") {
    if (/^ls\b/i.test(normalized)) {
      return normalized.replace(/^ls\b/i, "dir");
    }
    return /^dir\b/i.test(normalized) ? normalized : "dir";
  }
  return normalized;
}

/** 将 cd 与列表命令拼成一条（按 shell 选择连接符） */
export function joinCdWithListCommand(
  cdCommand: string,
  listCommand: string,
  shell: TerminalShellFamily,
): string {
  const cd = cdCommand.trim();
  const ls = listCommand.trim();
  switch (shell) {
    case "powershell":
      return `${cd}; if ($?) { ${ls} }`;
    case "cmd":
      return `${cd} && ${ls}`;
    default:
      return `${cd} && ${ls}`;
  }
}

/** 从复合命令中提取列表子命令 */
export function extractListCommandFromCompound(command: string): string | null {
  const cmd = command.trim();
  const andMatch = /\s&&\s+(.+)$/s.exec(cmd);
  if (andMatch) return andMatch[1]!.trim();
  const psMatch = /;\s*if\s*\(\$\?\)\s*\{\s*(.+)\s*\}\s*$/s.exec(cmd);
  if (psMatch) return psMatch[1]!.trim();
  return null;
}
