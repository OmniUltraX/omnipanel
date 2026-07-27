import { checkCommand } from "../../lib/commandGuard";

export type TerminalApprovalMode = "strict" | "view" | "loose";

export const DEFAULT_TERMINAL_APPROVAL_MODE: TerminalApprovalMode = "view";

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

const WRITE_REDIRECT_RE = /(?:^|[\s;])(?:\d*>>?)(?!\d)/;
const WRITE_PIPE_RE = /\|\s*(?:tee|dd|sh|bash|zsh|python|node)\b/i;

function stripLeadingShellModifiers(segment: string): string {
  let rest = segment.trim();
  for (let i = 0; i < 4; i += 1) {
    const next = rest
      .replace(/^(?:sudo|time|nohup|command)\s+/i, "")
      .replace(/^env\s+(?:\S+=\S+\s+)*/i, "")
      .trim();
    if (next === rest) break;
    rest = next;
  }
  return rest;
}

function splitCommandSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isReadOnlySegment(segment: string): boolean {
  const normalized = stripLeadingShellModifiers(segment);
  if (!normalized) return true;

  const tokens = normalized.split(/\s+/);
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

/** 是否为查看类 / 非修改类命令（宽松模式下免审批） */
export function isReadOnlyTerminalCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;
  if (WRITE_REDIRECT_RE.test(trimmed) || WRITE_PIPE_RE.test(trimmed)) return false;

  const danger = checkCommand(trimmed);
  if (!danger.safe && ["high", "critical"].includes(danger.level)) {
    return false;
  }

  const segments = splitCommandSegments(trimmed);
  return segments.every((segment) => isReadOnlySegment(segment));
}

/**
 * 是否要求对 AI 自动执行的终端命令做人工确认。
 * 仅用于 AI 工具链路；用户在命令栏手动执行不走此策略。
 */
export function shouldRequireTerminalApproval(
  command: string,
  mode: TerminalApprovalMode,
): boolean {
  if (mode === "loose") return false;
  if (mode === "strict") return true;
  return !isReadOnlyTerminalCommand(command);
}
