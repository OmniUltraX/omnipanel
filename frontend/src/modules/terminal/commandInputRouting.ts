import type { TerminalBlock } from "../../stores/blocksStore";
import { isSilentHistorySyncCommand } from "./commandBar/shellHistorySync";
import { normalizeBlockCommand } from "./terminalOutputText";
import { isInteractiveTerminalCommandFallback } from "./interactiveCommands";

/** 首字符为 CJK（含汉字、假名、谚文）等自然语言输入 */
const CJK_FIRST_CHAR_RE =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const SHELL_ERROR_SIGNAL_RE =
  /(?:command not found|not recognized as an internal or external command|no such file or directory|permission denied|syntax error|operation not permitted|cannot access|can't access|fatal:|segmentation fault|未找到命令|找不到命令|不是内部或外部命令|没有那个文件|权限不够|语法错误|您的意思是)/i;

const ENGLISH_NL_COMMAND_RE =
  /^(?:how|what|why|when|where|who|help|please|can you|could you|i need|tell me|show me|explain|analyze|analyse|list|check|find)\b/i;

/** 常见 shell 动词：这些开头即使带空格也视为命令而非自然语言 */
const KNOWN_SHELL_VERBS = new Set([
  "apt",
  "apt-get",
  "brew",
  "cargo",
  "cat",
  "cd",
  "chmod",
  "chown",
  "cmake",
  "cp",
  "curl",
  "docker",
  "dnf",
  "echo",
  "find",
  "git",
  "go",
  "grep",
  "journalctl",
  "kubectl",
  "ls",
  "make",
  "man",
  "mkdir",
  "mv",
  "node",
  "npm",
  "pnpm",
  "pip",
  "python",
  "rm",
  "rsync",
  "scp",
  "sed",
  "ssh",
  "sudo",
  "systemctl",
  "tail",
  "tar",
  "touch",
  "wget",
  "yarn",
  "yum",
]);

function firstToken(command: string): string {
  return command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** 英文自然语言问句（提交前预处理，偏保守） */
export function looksLikeEnglishQuestionInput(input: string): boolean {
  const cmd = input.trim();
  if (!cmd || !/\s/.test(cmd)) return false;
  if (/^[|&;><`$]/.test(cmd)) return false;
  if (!ENGLISH_NL_COMMAND_RE.test(cmd)) return false;
  const verb = firstToken(cmd);
  if (KNOWN_SHELL_VERBS.has(verb)) return false;
  return true;
}

/** 输入是否应直接走 AI（无需先执行 shell） */
export function shouldRouteInputToAi(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("#") || trimmed.startsWith("/agent ")) return false;
  if (trimmed.startsWith("!!")) return false;

  const first = [...trimmed][0];
  if (!first) return false;
  if (CJK_FIRST_CHAR_RE.test(first)) return true;
  return looksLikeEnglishQuestionInput(trimmed);
}

/** 命令文本是否像自然语言而非典型 shell */
export function looksLikeNaturalLanguageCommand(command: string): boolean {
  const cmd = normalizeBlockCommand(command);
  if (!cmd) return false;
  if (CJK_FIRST_CHAR_RE.test(cmd)) return true;
  return looksLikeEnglishQuestionInput(cmd);
}

export function hasShellErrorSignals(output: string): boolean {
  const text = output.trim();
  if (!text) return false;
  return SHELL_ERROR_SIGNAL_RE.test(text);
}

/** shell 块结束后是否应自动触发 AI */
export function shouldTriggerAiAfterShell(block: TerminalBlock): boolean {
  const cmd = normalizeBlockCommand(block.command);
  if (!cmd || block.kind === "ai") return false;
  if (block.status === "running") return false;
  if (isSilentHistorySyncCommand(cmd)) return false;
  if (isInteractiveTerminalCommandFallback(cmd)) return false;

  const exitCode = block.exitCode ?? 0;
  const output = block.output.trim();

  if (exitCode !== 0 && exitCode !== 130 && exitCode !== 141) {
    return true;
  }

  if (hasShellErrorSignals(output)) {
    return true;
  }

  return false;
}

export function buildPostShellAiQuery(block: TerminalBlock): string {
  const cmd = normalizeBlockCommand(block.command);
  if (looksLikeNaturalLanguageCommand(cmd)) {
    return cmd;
  }

  const output = block.output.trim().slice(-2000);
  return [
    "命令执行失败，请分析原因并给出可执行的修复建议。",
    "",
    `命令：\`${cmd}\``,
    `退出码：${block.exitCode ?? "未知"}`,
    "",
    "输出：",
    "```",
    output || "(无输出)",
    "```",
  ].join("\n");
}
