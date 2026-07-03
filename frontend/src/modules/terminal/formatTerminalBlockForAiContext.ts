import type { TerminalBlock } from "../../stores/blocksStore";
import { getAiBlockTextForContext } from "./aiThreadBridge";
import { isResidualShellNoise } from "./terminalCommandEcho";
import { stripAutoLsSuffix } from "./terminalAutoLs";
import { shouldUseDirectoryPreview } from "./terminalDirectoryPreview";
import {
  extractCommandOutput,
  isEchoOnlyTerminalOutput,
  normalizeBlockCommand,
  stripTerminalControlSequences,
} from "./terminalOutputText";

const MAX_OUTPUT_CHARS = 4000;

function shellOutputForContext(block: TerminalBlock): string {
  const cleaned = extractCommandOutput(block.output, block.command);
  if (cleaned) {
    if (shouldUseDirectoryPreview(block) && isResidualShellNoise(cleaned)) return "";
    return cleaned;
  }
  if (isEchoOnlyTerminalOutput(block.output, block.command)) return "";
  if (isResidualShellNoise(stripTerminalControlSequences(block.output))) return "";
  return block.output.trim();
}

export function blockContextLabel(block: TerminalBlock): string {
  if (block.kind === "ai") {
    return block.title?.trim() || "AI 对话";
  }
  const cmd = stripAutoLsSuffix(normalizeBlockCommand(block.command));
  if (cmd) return cmd;
  if (block.directoryPreview) return block.cwd?.trim() || "目录";
  return "命令块";
}

export function canAttachBlockToAiContext(block: TerminalBlock): boolean {
  if (block.kind === "ai") {
    return getAiBlockTextForContext(block).trim().length > 0 || Boolean(block.title?.trim());
  }
  const cmd = stripAutoLsSuffix(normalizeBlockCommand(block.command)).trim();
  if (cmd) return true;
  if (block.directoryPreview || block.attachedListing) return true;
  return shellOutputForContext(block).length > 0 || block.status === "running";
}

export function formatTerminalBlockForAiContext(block: TerminalBlock): string {
  if (block.kind === "ai") {
    const text = getAiBlockTextForContext(block);
    return text ? `[引用的终端 AI 块]\n${text}` : "";
  }

  const cmd = stripAutoLsSuffix(normalizeBlockCommand(block.command));
  const output = shellOutputForContext(block);
  const lines = ["[引用的终端命令块]"];

  if (cmd) lines.push(`命令: \`${cmd}\``);
  if (block.cwd?.trim()) lines.push(`目录: ${block.cwd.trim()}`);
  if (block.exitCode !== null) lines.push(`退出码: ${block.exitCode}`);
  if (block.status === "running") lines.push("状态: 执行中");

  if (output) {
    const clipped =
      output.length > MAX_OUTPUT_CHARS ? `…${output.slice(-MAX_OUTPUT_CHARS)}` : output;
    lines.push("", "输出:", "```", clipped, "```");
  }

  return lines.join("\n");
}
