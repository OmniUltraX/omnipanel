/** 剥离 ANSI/OSC 等控制序列，用于 Block 纯文本采集 */
import type { TerminalBlock } from "../../stores/blocksStore";

export function stripTerminalControlSequences(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r(?!\n)/g, "");
}

export function decodeTerminalBytes(bytes: Uint8Array): string {
  return stripTerminalControlSequences(new TextDecoder().decode(bytes));
}

/** 保留 OSC，供 shell 历史同步等协议解析使用 */
export function decodeTerminalBytesRaw(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
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
const WRAPPED_PROMPT_SUFFIX_RE = /^[[(]?[A-Za-z0-9._-]+@[A-Za-z0-9._-]+.*(?:[\])}]|[#$>])$/;
const MAX_WRAPPED_PROMPT_LINES = 24;

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

/** 剥离尾部被窄 PTY 硬折行的 shell prompt（如 [ro/ot@.../]#）。 */
function stripTrailingPromptLines(lines: string[]): string[] {
  const minStart = Math.max(0, lines.length - MAX_WRAPPED_PROMPT_LINES);
  for (let start = minStart; start < lines.length; start += 1) {
    const compact = lines
      .slice(start)
      .join("")
      .replace(/\s+/g, "");
    if (compact.includes("@") && WRAPPED_PROMPT_SUFFIX_RE.test(compact)) {
      return lines.slice(0, start);
    }
  }

  let end = lines.length;
  while (end > 0 && PROMPT_LINE_RE.test(lines[end - 1]?.trim() ?? "")) {
    end -= 1;
  }

  return lines.slice(0, end);
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

  return stripTrailingPromptLines(filtered).join("\n").trim();
}

/** 判断采集到的输出是否仅为 PTY 命令回显（尚未产生真实结果） */
export function isEchoOnlyTerminalOutput(raw: string, command: string): boolean {
  const sent = normalizeBlockCommand(command);
  if (!sent || !raw.trim()) return true;

  const cleaned = extractCommandOutput(raw, command);
  if (cleaned.length > 0) return false;

  const stripped = stripTerminalControlSequences(raw).trim();
  if (!stripped) return true;

  const strippedNorm = stripped.replace(/\s+/g, " ");
  const sentNorm = sent.replace(/\s+/g, " ");
  if (strippedNorm === sentNorm) return true;
  if (strippedNorm.startsWith(sentNorm)) {
    const tail = strippedNorm.slice(sentNorm.length).trim();
    return tail.length === 0 || /^\d+$/.test(tail);
  }
  return false;
}

export function isMeaningfulTerminalBlock(
  block: TerminalBlock,
  command: string,
): boolean {
  const blockCmd = normalizeBlockCommand(block.command);
  const sent = normalizeBlockCommand(command);
  const commandMatches =
    blockCmd.length > 0 && (blockCmd === sent || blockCmd.includes(sent) || sent.includes(blockCmd));

  if (block.output.trim().length > 0) {
    if (isEchoOnlyTerminalOutput(block.output, block.command || command)) {
      return block.status !== "running";
    }
    return true;
  }

  if (block.status === "completed" || block.status === "failed") {
    return commandMatches;
  }

  return false;
}
