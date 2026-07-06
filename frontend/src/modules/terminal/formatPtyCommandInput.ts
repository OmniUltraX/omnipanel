import type { TerminalShellFamily } from "./terminalAutoLsShell";

/** PowerShell 多行包装命令前缀，用于输出剥离 */
export const OMNIPANEL_PS_IEX_RUNNER_RE =
  /^iex\s*\(\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\(/i;

export function isMultilineTerminalCommand(cmd: string): boolean {
  return /[\r\n]/.test(cmd.replace(/\r\n/g, "\n"));
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * PowerShell：整段脚本 base64 + iex 一次提交，保证 OSC 133 只产生一个命令边界。
 * 逐行 \r 会让每行 assignment 都触发 PostCommand，Block Feed 在首行后就停止采集。
 */
function formatPowerShellMultiline(normalized: string): string {
  const payload = utf8ToBase64(normalized);
  return `iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')))\r`;
}

/**
 * 将命令栏/AI 提交的文本格式化为交互式 PTY 可执行的输入。
 */
export function formatPtyCommandInput(
  cmd: string,
  shell: TerminalShellFamily = "posix",
): string {
  const normalized = cmd.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.includes("\n")) {
    return `${normalized}\r`;
  }

  if (shell === "powershell") {
    return formatPowerShellMultiline(normalized.trimEnd());
  }

  // bash/fish 等多行块语法仍需逐行回车
  return normalized
    .split("\n")
    .map((line) => `${line}\r`)
    .join("");
}
