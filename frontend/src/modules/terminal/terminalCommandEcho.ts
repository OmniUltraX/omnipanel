import {
  buildCdWithAutoLs,
  isCdOnlyCommand,
  stripAutoLsSuffix,
} from "./terminalAutoLsPolicy";
import type { TerminalShellFamily } from "./terminalAutoLsShell";
import { normalizeBlockCommand } from "./terminalOutputText";

const AUTO_LS_PS_SUFFIX_LINE = /^\s*;?\s*if\s*\(\$\?\)\s*\{[^}]*\}\s*$/i;
const AUTO_LS_PS_SUFFIX_INLINE = /\s*;\s*if\s*\(\$\?\)\s*\{[^}]*\}\s*$/i;
const AUTO_LS_AND_SUFFIX_INLINE = /\s*&&\s+(?:ls|dir|Get-ChildItem|gci)\b[^\r\n]*$/i;
const PS_PROMPT_LINE_RE = /^PS\s+[A-Za-z]:[^>]*>\s*$/i;
const PS_DIR_HEADER_LINE_RE = /^(?:目录|Directory):\s*[A-Za-z]:/i;

const SHELL_VARIANTS: TerminalShellFamily[] = ["posix", "powershell", "cmd"];

/** 合并 feed capture 预注册命令与 OSC 读行，避免折行导致命令被截短覆盖。 */
export function mergeCapturedBlockCommand(existing: string, read: string): string {
  const a = normalizeBlockCommand(existing).trim();
  const b = normalizeBlockCommand(read).trim();
  if (!b) return a;
  if (!a) return b;
  if (a === b) return a;
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;
  return b.length > a.length ? b : a;
}

/** 收集可能出现在 PTY 回显中的命令变体（含自动拼接的列表后缀）。 */
export function collectEchoCommandVariants(command: string): string[] {
  const sent = normalizeBlockCommand(command).trim();
  if (!sent) return [];

  const variants = new Set<string>([sent]);
  const display = stripAutoLsSuffix(sent).trim();
  if (display) variants.add(display);

  if (isCdOnlyCommand(sent)) {
    for (const shell of SHELL_VARIANTS) {
      for (const lsCommand of ["ls", "ls -a", "Get-ChildItem -Force", "dir"]) {
        const compound = buildCdWithAutoLs(sent, lsCommand, shell);
        if (compound !== sent) variants.add(compound);
      }
    }
  }

  return [...variants].sort((left, right) => right.length - left.length);
}

export function stripAutoLsEchoArtifacts(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(AUTO_LS_PS_SUFFIX_INLINE, "")
        .replace(AUTO_LS_AND_SUFFIX_INLINE, "")
        .trimEnd(),
    )
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (AUTO_LS_PS_SUFFIX_LINE.test(trimmed)) return false;
      if (/^if\s*\(\$\?\)\s*\{/.test(trimmed)) return false;
      if (/^\{\s*$/.test(trimmed) || /^\}\s*$/.test(trimmed)) return false;
      return true;
    })
    .join("\n");
}

export function looksLikeShellCommandEchoLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/if\s*\(\$\?\)/i.test(trimmed)) return true;
  if (/^\s*cd\b/i.test(trimmed) && /;\s*if\s*\(\$\?\)/i.test(trimmed)) return true;
  if (/^PS\s+[A-Za-z]:/i.test(trimmed)) return true;
  if (/^\{\s*$/.test(trimmed) || /^\}\s*;?\s*$/.test(trimmed)) return true;
  return false;
}

/** 判断文本是否像 shell 命令回显，而非目录列表。 */
export function looksLikeShellCommandEcho(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length > 0 && lines.every(looksLikeShellCommandEchoLine)) {
    return true;
  }

  if (/^\s*cd\b/i.test(trimmed) && /if\s*\(\$\?\)/i.test(trimmed)) {
    return true;
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const shellish = tokens.filter(
    (token) =>
      /^(cd|if|ls|dir|gci|PS|\{|\}|;)$/i.test(token) ||
      token === "($?)" ||
      /\(\$\?\)/.test(token),
  ).length;
  return shellish >= 3 && /[;&|]/.test(trimmed);
}

/** 剥离后仅剩提示符、命令回显或空目录列表头时视为无实质输出 */
export function isResidualShellNoise(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return true;
  return lines.every(
    (line) =>
      looksLikeShellCommandEchoLine(line) ||
      PS_PROMPT_LINE_RE.test(line) ||
      PS_DIR_HEADER_LINE_RE.test(line) ||
      /^----+\s+----/.test(line) ||
      /^Mode\s+LastWriteTime/i.test(line),
  );
}

export function isResidualEchoTail(tail: string): boolean {
  const norm = tail.replace(/\s+/g, " ").trim();
  if (!norm) return true;
  if (PS_PROMPT_LINE_RE.test(norm)) return true;
  return isResidualShellNoise(tail);
}

export function stripBestLeadingCommandEcho(raw: string, command: string): string {
  let text = raw;
  let best = raw;
  for (const variant of collectEchoCommandVariants(command)) {
    const next = stripLeadingCommandEchoOnce(text, variant);
    if (next.length < best.length) {
      best = next;
    }
  }
  return best;
}

function stripLeadingCommandEchoOnce(raw: string, command: string): string {
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
    if (ch === "\n" || ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      continue;
    }
    break;
  }

  if (j === sent.length) {
    while (i < raw.length && (raw[i] === "\n" || raw[i] === " " || raw[i] === "\t" || raw[i] === "\r")) {
      i += 1;
    }
    return raw.slice(i);
  }

  return raw;
}
