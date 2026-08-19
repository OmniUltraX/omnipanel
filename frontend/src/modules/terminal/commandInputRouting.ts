import type { TerminalBlock } from "../../stores/blocksStore";
import { isSilentHistorySyncCommand } from "./commandBar/shellHistorySync";
import { normalizeBlockCommand } from "./terminalOutputText";
import { isInteractiveTerminalCommandFallback } from "./interactiveCommands";

/** 首字符为 CJK（含汉字、假名、谚文）等自然语言输入 */
const CJK_FIRST_CHAR_RE =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 任意位置出现 CJK（用于「命令 + 中文后缀」混合输入检测，需先剥引号） */
const CJK_ANYWHERE_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 中文意图短语：出现这些几乎一定是自然语言，而非纯命令 */
const NL_INTENT_PHRASES = [
  "帮我",
  "帮我执行",
  "执行一下",
  "看一下",
  "查一下",
  "分析一下",
  "检查一下",
  "处理一下",
  "跑一下",
  "试一下",
  "给我",
  "请帮我",
  "能不能",
  "可以吗",
  "怎么样",
  "如何",
  "为什么",
  "是什么",
  "什么意思",
  "帮我看看",
  "帮我看",
  "帮我查",
  "帮我分析",
  "帮我检查",
  "帮我处理",
  "帮我跑",
  "帮我试",
  "上面这个",
  "这个命令",
  "这条命令",
  "刚才那个",
  "上一个命令",
];

/** 交互式程序提示（apt/pip/systemctl 等的 Y/n 确认），是程序输出而非用户输入 */
const INTERACTIVE_PROMPT_RE =
  /\[(?:y\/n|n\/y|Y\/N|yes\/no|no\/yes|o\/k|ok\/cancel|Ok\/Cancel)\]|\(yes\/no\)|\(y\/n\)|press(?:\s+any\s+key|\s+enter|\s+q)?\s+to\s+continue|do\s+you\s+want\s+to\s+continue|continue\?/i;

const SHELL_ERROR_SIGNAL_RE =
  /(?:command not found|not recognized as an internal or external command|no such file or directory|permission denied|syntax error|operation not permitted|cannot access|can't access|cannot find path|fatal:|segmentation fault|未找到命令|找不到命令|不是内部或外部命令|没有那个文件|权限不够|语法错误|您的意思是|找不到路径|因为该路径不存在|CategoryInfo|FullyQualifiedErrorId|ObjectNotFound|ItemNotFoundException|PathNotFound|SetLocationCommand|NativeCommandError|ParserError|所在位置\s*行:|终止错误)/i;

/** 英文自然语言（含常见祈使）；与 KNOWN_SHELL_VERBS 冲突时以 shell 为准 */
const ENGLISH_NL_COMMAND_RE =
  /^(?:how|what|why|when|where|who|help|please|can you|could you|would you|do you|i need|tell me|show me|explain|analyze|analyse|list|check|find|install|setup|configure|fix|debug|troubleshoot|is there|are there)\b/i;

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

/** 剥掉引号内容（双引号/单引号/反引号），启发式不处理转义嵌套 */
function stripQuotedContent(input: string): string {
  return input
    .replace(/`[^`]*`/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/'[^']*'/g, "");
}

/** 引号外是否含 CJK（真命令的中文几乎都在引号内：echo/git commit -m 等） */
function hasCjkOutsideQuotes(input: string): boolean {
  return CJK_ANYWHERE_RE.test(stripQuotedContent(input));
}

/** 引号外是否含中文意图短语 */
function hasNlIntentPhrase(input: string): boolean {
  const unquoted = stripQuotedContent(input);
  return NL_INTENT_PHRASES.some((p) => unquoted.includes(p));
}

/** 以 CJK 开头但更像路径/脚本，不应进 AI */
function looksLikeCjkShellPath(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (/\s/.test(trimmed)) return false;
  if (/^[.\/~]/.test(trimmed)) return true;
  if (/\.(sh|bash|zsh|py|js|ts|mjs|cjs|exe|bat|cmd|ps1)$/i.test(trimmed)) return true;
  return false;
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

  // 交互式程序提示（apt/pip 的 [Y/n] 等）是程序输出，不是用户输入，禁止判 NL
  if (INTERACTIVE_PROMPT_RE.test(trimmed)) return false;

  const first = [...trimmed][0];
  if (!first) return false;

  if (CJK_FIRST_CHAR_RE.test(first)) {
    if (looksLikeCjkShellPath(trimmed)) return false;
    return true;
  }

  // 「命令 + 中文后缀」混合输入：引号外有中文 或 含意图短语 → NL
  // 例：ls -s -a 上面这个命令帮我执行一下 → AI
  // 但纯 CJK 路径/脚本名（./备份.sh、脚本.py）仍判命令
  if (looksLikeCjkShellPath(trimmed)) return false;
  if (hasCjkOutsideQuotes(trimmed) || hasNlIntentPhrase(trimmed)) return true;

  const verb = firstToken(trimmed);
  if (KNOWN_SHELL_VERBS.has(verb)) return false;

  return looksLikeEnglishQuestionInput(trimmed);
}

/** 命令文本是否像自然语言而非典型 shell */
export function looksLikeNaturalLanguageCommand(command: string): boolean {
  const cmd = normalizeBlockCommand(command);
  if (!cmd) return false;
  return shouldRouteInputToAi(cmd);
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
