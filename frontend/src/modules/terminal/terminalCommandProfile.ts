import { isInteractiveTerminalCommandFallback } from "./interactiveCommands";

export type CommandProfileKind = "batch" | "progress" | "streaming" | "interactive";

export type CommandExecutionSource = "用户" | "AI";

export interface CommandExecutionProfile {
  kind: CommandProfileKind;
  timeoutMs: number;
  outputIdleMs: number;
  promoteInlineOnCr: boolean;
  allowAiExecution: boolean;
  rejectReason?: string;
  suggestedAlternatives?: string[];
}

export interface TerminalToolResultPayload {
  command: string;
  exitCode: number | null;
  status: string;
  cwd: string;
  output: string;
  progressTail?: string;
  durationMs?: number;
  profileKind?: CommandProfileKind;
  emptyOutput?: boolean;
  diagnostic?: string;
  doNotRetrySameCommand?: boolean;
  suggestedAlternatives?: string[];
}

const BATCH_TIMEOUT_MS = 15_000;
const BATCH_IDLE_MS = 600;
const PROGRESS_TIMEOUT_MS = 1_800_000;
const PROGRESS_IDLE_MS = 3_000;

const PROGRESS_COMMAND_BASES = new Set([
  "npm",
  "pnpm",
  "yarn",
  "docker",
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "pip",
  "pip3",
  "cargo",
  "go",
  "curl",
  "wget",
  "brew",
  "gem",
  "composer",
  "snap",
  "flatpak",
  "pacman",
  "zypper",
]);

const INTERACTIVE_COMMAND_BASES = new Set([
  "claude",
  "hermes",
  "vim",
  "vi",
  "nvim",
  "less",
  "more",
  "top",
  "htop",
  "btop",
  "ssh",
  "python",
  "python3",
  "node",
  "psql",
  "mysql",
  "redis-cli",
  "ipython",
  "irb",
  "ruby",
]);

function commandBaseName(command: string): string {
  return (
    command
      .trim()
      .split(/\s+/)[0]
      ?.replace(/^.*[/\\]/, "")
      .replace(/\.exe$/i, "")
      .toLowerCase() ?? ""
  );
}

function tokenize(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function isStreamingCommand(command: string): boolean {
  const tokens = tokenize(command);
  if (tokens.length === 0) return false;
  const base = commandBaseName(command);

  if (base === "tail" && tokens.includes("-f")) return true;
  if (base === "journalctl" && tokens.includes("-f")) return true;
  if (base === "watch") return true;
  if (base === "ping" && !tokens.includes("-c") && !tokens.includes("/")) return true;

  return false;
}

function isInteractiveCommand(command: string): boolean {
  const base = commandBaseName(command);
  if (INTERACTIVE_COMMAND_BASES.has(base)) return true;
  return isInteractiveTerminalCommandFallback(command);
}

function isProgressCommand(command: string): boolean {
  return PROGRESS_COMMAND_BASES.has(commandBaseName(command));
}

function streamingAlternatives(command: string): string[] {
  const tokens = tokenize(command);
  const base = commandBaseName(command);
  if (base === "tail" && tokens.includes("-f")) {
    const file = tokens[tokens.length - 1];
    if (file && !file.startsWith("-")) {
      return [`tail -n 100 ${file}`];
    }
    return ["tail -n 100 <file>"];
  }
  if (base === "journalctl") {
    return ["journalctl -n 100 --no-pager", "journalctl -n 100 -u <service> --no-pager"];
  }
  if (base === "watch") {
    return ["<command>  # 单次执行，不要用 watch"];
  }
  if (base === "ping") {
    const target = tokens[1];
    return target ? [`ping -c 4 ${target}`] : ["ping -c 4 <host>"];
  }
  return [];
}

function interactiveAlternatives(command: string): string[] {
  const base = commandBaseName(command);
  switch (base) {
    case "top":
    case "htop":
    case "btop":
      return [
        "top -bn1 | head -20",
        "ps aux --sort=-%cpu | head -15",
        "free -h && df -h",
      ];
    case "less":
    case "more":
    case "vim":
    case "vi":
    case "nvim":
      return ["请在 Command Bar 手动执行该交互式命令"];
    case "claude":
    case "hermes":
      return ["请使用终端内 AI 块（# 提问）或侧栏助手，不要通过终端工具启动 AI CLI"];
    case "python":
    case "python3":
    case "node":
    case "ipython":
      return ["python -c '<script>'", "node -e '<script>'"];
    case "mysql":
    case "psql":
    case "redis-cli":
      return ["mysql -e '<sql>'", "psql -c '<sql>'", "redis-cli --raw <command>"];
    default:
      return ["请改用非交互式批处理命令"];
  }
}

function buildRejectedProfile(
  kind: "streaming" | "interactive",
  command: string,
  reason: string,
  alternatives: string[],
): CommandExecutionProfile {
  return {
    kind,
    timeoutMs: 0,
    outputIdleMs: 0,
    promoteInlineOnCr: false,
    allowAiExecution: false,
    rejectReason: reason,
    suggestedAlternatives: alternatives,
  };
}

export function resolveCommandProfile(
  command: string,
  source: CommandExecutionSource,
): CommandExecutionProfile {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      kind: "batch",
      timeoutMs: BATCH_TIMEOUT_MS,
      outputIdleMs: BATCH_IDLE_MS,
      promoteInlineOnCr: false,
      allowAiExecution: true,
    };
  }

  if (source === "AI") {
    if (isStreamingCommand(trimmed)) {
      return buildRejectedProfile(
        "streaming",
        trimmed,
        "流式命令不会结束，AI 工具无法等待其完成。请改用有限输出的替代命令。",
        streamingAlternatives(trimmed),
      );
    }
    if (isInteractiveCommand(trimmed)) {
      return buildRejectedProfile(
        "interactive",
        trimmed,
        "交互式/TUI 命令不能通过 AI 终端工具执行。请改用批处理替代命令，或由用户在 Command Bar 手动运行。",
        interactiveAlternatives(trimmed),
      );
    }
  }

  if (isProgressCommand(trimmed)) {
    return {
      kind: "progress",
      timeoutMs: PROGRESS_TIMEOUT_MS,
      outputIdleMs: PROGRESS_IDLE_MS,
      promoteInlineOnCr: true,
      allowAiExecution: true,
    };
  }

  return {
    kind: "batch",
    timeoutMs: source === "AI" ? BATCH_TIMEOUT_MS : 60_000,
    outputIdleMs: BATCH_IDLE_MS,
    promoteInlineOnCr: false,
    allowAiExecution: true,
  };
}

export function buildProfileRejectPayload(
  profile: CommandExecutionProfile,
  command: string,
): TerminalToolResultPayload {
  return {
    command: command.trim(),
    exitCode: null,
    status: "rejected_by_policy",
    cwd: "",
    output: profile.rejectReason ?? "该命令不允许通过 AI 终端工具执行。",
    profileKind: profile.kind,
    doNotRetrySameCommand: true,
    suggestedAlternatives: profile.suggestedAlternatives,
    diagnostic:
      "请使用 suggestedAlternatives 中的替代命令重试，不要重复调用相同的交互式/流式命令。",
  };
}

export function serializeToolResultPayload(payload: TerminalToolResultPayload): string {
  return JSON.stringify(payload, null, 2);
}

/** 用户 Command Bar 是否应进入 full-terminal（与 AI profile 无关） */
export function shouldUseFullTerminalForUser(command: string): boolean {
  return isInteractiveCommand(command);
}
