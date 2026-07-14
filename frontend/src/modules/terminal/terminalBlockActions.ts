import {
  useBlocksStore,
  type TerminalBlock,
} from "../../stores/blocksStore";
import {
  isCdNavigationCommand,
  stripAutoLsSuffix,
} from "./terminalAutoLsPolicy";
import { shouldUseDirectoryPreview } from "./terminalDirectoryPreview";
import {
  extractCommandOutput,
  isEchoOnlyTerminalOutput,
  normalizeBlockCommand,
  stripTerminalControlSequences,
} from "./terminalOutputText";
import { isResidualShellNoise } from "./terminalCommandEcho";
import { renderLiveOutputText } from "./terminalOutputModel";

function blockRawOutput(block: TerminalBlock): string {
  return renderLiveOutputText(block.liveOutput, block.output);
}

/** 与 Feed 展示一致的 shell 输出文本（已剥离 echo / 噪声） */
export function resolveShellBlockOutput(block: TerminalBlock): string {
  const source = blockRawOutput(block);
  const cleaned = extractCommandOutput(source, block.command);
  if (cleaned) {
    if (shouldUseDirectoryPreview(block) && isResidualShellNoise(cleaned)) return "";
    return cleaned;
  }
  if (isEchoOnlyTerminalOutput(source, block.command)) return "";
  if (isResidualShellNoise(stripTerminalControlSequences(source))) return "";
  return source.trim();
}

function displayCommand(block: TerminalBlock): string {
  return stripAutoLsSuffix(normalizeBlockCommand(block.command)).trim();
}

/** 空目录预览（cd 后无文件） */
export function isEmptyDirectoryPreviewBlock(block: TerminalBlock): boolean {
  if (block.kind === "ai") return false;
  if (block.status === "running") return false;
  if (block.attachedListing && block.attachedListing.entries.length > 0) return false;
  return block.directoryPreview === true || shouldUseDirectoryPreview(block);
}

/**
 * 无实质输出的 shell block（可批量清理）。
 * 含：空输出命令、空目录预览；排除运行中 / AI / 有内容的列表。
 */
export function isEmptyOutputShellBlock(block: TerminalBlock): boolean {
  if (block.kind === "ai") return false;
  if (block.status === "running") return false;
  if (block.attachedListing && block.attachedListing.entries.length > 0) return false;
  if (isEmptyDirectoryPreviewBlock(block)) return true;
  return resolveShellBlockOutput(block).length === 0;
}

/**
 * 无意义 / 噪声命令：导航、清屏、状态查询等。
 * cd / pwd / clear / whoami / true …
 */
export function isNoisyShellBlock(block: TerminalBlock): boolean {
  if (block.kind === "ai") return false;
  if (block.status === "running") return false;

  const cmd = displayCommand(block);
  if (!cmd) return false;

  if (isCdNavigationCommand(block.command) || isEmptyDirectoryPreviewBlock(block)) {
    return true;
  }

  // 单行噪声命令（可带简单参数，不含管道/重定向）
  if (/[|&;><`]/.test(cmd)) return false;

  const base = cmd.split(/\s+/)[0]?.toLowerCase() ?? "";
  const NOISE_BASES = new Set([
    "pwd",
    "clear",
    "cls",
    "reset",
    "true",
    "false",
    ":",
    "whoami",
    "hostname",
    "date",
    "uptime",
    "id",
    "tty",
    "dirs",
    "pushd",
    "popd",
    "uname",
    "arch",
    "nproc",
    "jobs",
    "fg",
    "bg",
    "sync",
    "get-location",
    "gl",
    "get-date",
    "clear-host",
  ]);

  if (NOISE_BASES.has(base)) return true;

  // 无参数或仅空白的 echo
  if (base === "echo" && /^echo\s*$/i.test(cmd)) return true;

  if (base === "command" && /^command\s+-v\b/i.test(cmd)) return true;

  return false;
}

/** 已结束且失败的 shell 块 */
export function isFailedShellBlock(block: TerminalBlock): boolean {
  if (block.kind === "ai") return false;
  if (block.status === "running") return false;
  return block.status === "failed" || (block.exitCode !== null && block.exitCode !== 0);
}

function clearMatchingBlocks(
  sessionId: string,
  predicate: (block: TerminalBlock) => boolean,
): number {
  const blocks = useBlocksStore.getState().getBlocks(sessionId);
  const kept = blocks.filter((block) => !predicate(block));
  const removed = blocks.length - kept.length;
  if (removed > 0) {
    useBlocksStore.getState().replaceSessionBlocks(sessionId, kept);
  }
  return removed;
}

export function clearEmptyOutputBlocks(sessionId: string): number {
  return clearMatchingBlocks(sessionId, isEmptyOutputShellBlock);
}

export function clearNoisyShellBlocks(sessionId: string): number {
  return clearMatchingBlocks(sessionId, isNoisyShellBlock);
}

export function clearFailedShellBlocks(sessionId: string): number {
  return clearMatchingBlocks(sessionId, isFailedShellBlock);
}

export function clearAllSessionBlocks(sessionId: string): void {
  useBlocksStore.getState().clearBlocks(sessionId);
}
