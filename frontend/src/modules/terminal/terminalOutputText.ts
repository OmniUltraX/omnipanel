/** 剥离 ANSI/OSC 等控制序列，用于 Block 纯文本采集 */
import type { TerminalBlock } from "../../stores/blocksStore";

export function stripTerminalControlSequences(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export function decodeTerminalBytes(bytes: Uint8Array): string {
  return stripTerminalControlSequences(new TextDecoder().decode(bytes));
}

/** Ctrl+C(130) 与 SIGPIPE(141) 不按普通失败处理 */
export function resolveBlockStatus(exitCode: number): TerminalBlockStatus {
  if (exitCode === 0 || exitCode === 130 || exitCode === 141) {
    return "completed";
  }
  return "failed";
}

export type TerminalBlockStatus = "running" | "completed" | "failed";

const PROMPT_LINE_RE = /^[^\n]*[$#>]\s*$/;
const PROMPT_WITH_CMD_RE = /^[^\n]*[$#>]\s+/;

/** 从块记录或 OSC 读行中取出纯命令文本 */
export function normalizeBlockCommand(command: string): string {
  const trimmed = command.trim();
  const withoutPrompt = trimmed.replace(PROMPT_WITH_CMD_RE, "").trim();
  if (withoutPrompt) return withoutPrompt;
  return trimmed.replace(/^[^#$>]*[$#>]\s*/, "").trim();
}

/** 判断是否为命令回显残片（逐字回显时可能只剩 l、s 等） */
function isCommandEchoFragment(line: string, sent: string): boolean {
  const compact = line.replace(/\s+/g, "");
  const sentCompact = sent.replace(/\s+/g, "");
  if (!compact || !sentCompact) return false;
  if (compact === sentCompact) return true;
  if (sentCompact.startsWith(compact) && compact.length < sentCompact.length) return true;
  if (sentCompact.endsWith(compact) && compact.length < sentCompact.length) return true;
  return false;
}

/** 剥离开头若干行中的回显残片 */
function stripLeadingEchoLines(lines: string[], sent: string): string[] {
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }
    if (isCommandEchoFragment(line, sent)) {
      index += 1;
      continue;
    }
    if (line.startsWith(sent)) {
      const rest = line.slice(sent.length).trim();
      if (rest) {
        return [rest, ...lines.slice(index + 1)];
      }
      index += 1;
      continue;
    }
    break;
  }
  return lines.slice(index);
}

/**
 * 剥离 PTY 回显的命令（含逐字符回显：l + s + 输出）。
 */
export function stripLeadingCommandEcho(raw: string, command: string): string {
  const sent = command.trim();
  if (!sent || !raw) return raw;

  let i = 0;
  let j = 0;
  while (i < raw.length && j < sent.length) {
    const ch = raw[i];
    if (ch === sent[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (ch === "\n" || ch === " " || ch === "\t") {
      i += 1;
      continue;
    }
    break;
  }

  if (j === sent.length) {
    while (i < raw.length && (raw[i] === "\n" || raw[i] === " " || raw[i] === "\t")) {
      i += 1;
    }
    return raw.slice(i);
  }

  return raw;
}

/** 从终端原始输出中剥离命令回显与提示符，保留命令结果 */
export function extractCommandOutput(raw: string, command: string): string {
  const sent = normalizeBlockCommand(command);
  if (!sent) return raw.trim();

  let text = stripLeadingCommandEcho(stripTerminalControlSequences(raw), sent);
  const sentNorm = sent.replace(/\s+/g, " ");

  const lines = stripLeadingEchoLines(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    sent,
  );

  const filtered: string[] = [];
  let skippingPrefix = true;

  for (const line of lines) {
    if (PROMPT_LINE_RE.test(line)) continue;

    const withoutPrompt = line.replace(PROMPT_WITH_CMD_RE, "").trim();
    const lineNorm = withoutPrompt.replace(/\s+/g, " ");

    if (lineNorm === sentNorm || line.replace(/\s+/g, " ") === sentNorm) continue;

    if (skippingPrefix) {
      if (sent.startsWith(lineNorm) && lineNorm.length < sent.length) continue;
      if (lineNorm.startsWith(sentNorm)) {
        const rest = lineNorm.slice(sentNorm.length).trim();
        if (rest) filtered.push(rest);
        skippingPrefix = false;
        continue;
      }
      skippingPrefix = false;
    }

    filtered.push(withoutPrompt || line);
  }

  return filtered.join("\n").trim();
}

export function isMeaningfulTerminalBlock(
  block: TerminalBlock,
  command: string,
): boolean {
  if (block.output.trim().length > 0) return true;
  const blockCmd = block.command
    .trim()
    .replace(/^[^#$>]*[$#>]\s*/, "")
    .replace(/\s+/g, " ");
  const sent = command.trim().replace(/\s+/g, " ");
  return blockCmd.length > 0 && (blockCmd === sent || blockCmd.includes(sent));
}
