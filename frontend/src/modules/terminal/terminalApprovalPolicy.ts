import { checkCommand } from "../../lib/commandGuard";
import {
  segmentTokens,
  splitCommandSegments,
  stripHarmlessRedirects,
} from "./terminalCommandFingerprint";
import {
  isCommandWhitelisted,
  type CommandWhitelistScope,
} from "./terminalCommandWhitelist";

export type TerminalApprovalMode = "strict" | "view" | "loose";

export const DEFAULT_TERMINAL_APPROVAL_MODE: TerminalApprovalMode = "view";

export {
  commandApprovalKey,
  commandApprovalKeys,
  stripHarmlessRedirects,
} from "./terminalCommandFingerprint";

const READ_ONLY_VERBS = new Set([
  "alias",
  "awk",
  "basename",
  "cal",
  "cat",
  "cd",
  "column",
  "curl",
  "date",
  "df",
  "diff",
  "dirname",
  "dir",
  "du",
  "echo",
  "env",
  "export",
  "file",
  "find",
  "free",
  "get",
  "getent",
  "grep",
  "groups",
  "head",
  "help",
  "history",
  "host",
  "hostname",
  "id",
  "ifconfig",
  "ip",
  "jobs",
  "jq",
  "last",
  "less",
  "ll",
  "locate",
  "ls",
  "lsblk",
  "lscpu",
  "lsof",
  "man",
  "more",
  "mount",
  "nc",
  "netstat",
  "nslookup",
  "passwd",
  "pgrep",
  "ping",
  "printenv",
  "ps",
  "pwd",
  "readlink",
  "realpath",
  "rg",
  "route",
  "sed",
  "seq",
  "set",
  "sort",
  "ss",
  "stat",
  "strings",
  "systemctl",
  "tail",
  "test",
  "top",
  "tr",
  "tree",
  "type",
  "uname",
  "uniq",
  "unset",
  "uptime",
  "w",
  "watch",
  "wc",
  "whatis",
  "whereis",
  "which",
  "who",
  "whoami",
  "xargs",
  "zcat",
]);

const DOCKER_READ_SUBCOMMANDS = new Set([
  "ps",
  "images",
  "logs",
  "inspect",
  "stats",
  "top",
  "port",
  "history",
  "version",
  "info",
]);

const KUBECTL_READ_SUBCOMMANDS = new Set([
  "get",
  "describe",
  "logs",
  "top",
  "explain",
  "api-resources",
  "api-versions",
  "version",
  "cluster-info",
]);

const GIT_READ_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "remote",
  "tag",
  "stash",
  "blame",
  "shortlog",
  "rev-parse",
  "describe",
]);

/** 写入文件的重定向；不含 2>/dev/null、2>&1 等无害形式 */
const WRITE_REDIRECT_RE = /(?:^|[\s;|&])(?:\d*)>{1,2}\s*(?!\/dev\/null\b|&\d+\b)\S+/;
const WRITE_PIPE_RE = /\|\s*(?:tee|dd|sh|bash|zsh|python|node)\b/i;

function isReadOnlySegment(segment: string): boolean {
  const tokens = segmentTokens(segment);
  const verb = tokens[0]?.toLowerCase() ?? "";
  if (!verb) return true;

  if (verb === "docker") {
    const sub = tokens[1]?.toLowerCase() ?? "";
    return DOCKER_READ_SUBCOMMANDS.has(sub);
  }

  if (verb === "kubectl" || verb === "k") {
    const sub = tokens[1]?.toLowerCase() ?? "";
    return KUBECTL_READ_SUBCOMMANDS.has(sub);
  }

  if (verb === "git") {
    const sub = tokens[1]?.toLowerCase() ?? "";
    return GIT_READ_SUBCOMMANDS.has(sub);
  }

  if (verb === "systemctl") {
    const sub = tokens[1]?.toLowerCase() ?? "";
    return ["status", "is-active", "is-enabled", "list-units", "list-timers", "show"].includes(sub);
  }

  return READ_ONLY_VERBS.has(verb);
}

/** 是否为查看类 / 非修改类命令（查看模式下免审批） */
export function isReadOnlyTerminalCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;

  const normalized = stripHarmlessRedirects(trimmed);
  if (!normalized) return true;
  if (WRITE_REDIRECT_RE.test(normalized) || WRITE_PIPE_RE.test(normalized)) return false;

  const danger = checkCommand(trimmed);
  if (!danger.safe && ["high", "critical"].includes(danger.level)) {
    return false;
  }

  const segments = splitCommandSegments(normalized);
  return segments.every((segment) => isReadOnlySegment(segment));
}

/**
 * 是否要求对 AI 自动执行的终端命令做人工确认。
 * 仅用于 AI 工具链路；用户在命令栏手动执行不走此策略。
 * @param scope 会话白名单作用域（AI 会话 / 终端会话）
 */
export function shouldRequireTerminalApproval(
  command: string,
  mode: TerminalApprovalMode,
  scope?: CommandWhitelistScope | null,
): boolean {
  if (mode === "loose") return false;
  if (isCommandWhitelisted(command, scope)) return false;
  if (mode === "strict") return true;
  return !isReadOnlyTerminalCommand(command);
}
