import { useBlocksStore } from "../../stores/blocksStore";
import { findTerminalPane } from "../../stores/terminalStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  extractCommandOutput,
  normalizeBlockCommand,
} from "./terminalOutputText";
import {
  isCdOnlyCommand,
  normalizeAutoLsCommand,
  buildCdWithAutoLs,
} from "./terminalAutoLsPolicy";
import {
  adaptAutoLsCommandForShell,
  resolveTerminalShellFamily,
} from "./terminalAutoLsShell";
import { isSilentHistorySync } from "./commandBar/shellHistorySync";
import { isWarpDisplay } from "./terminalDisplayMode";

export { isCdOnlyCommand, normalizeAutoLsCommand, stripAutoLsSuffix } from "./terminalAutoLsPolicy";

function resolveShellFamilyForSession(sessionId?: string) {
  const pane = sessionId ? findTerminalPane(sessionId) : null;
  return resolveTerminalShellFamily(pane?.type ?? "remote", pane?.shellLabel);
}

export function isTerminalAutoLsEnabled(): boolean {
  return useSettingsStore.getState().terminalAutoLsAfterCd;
}

export function getTerminalAutoLsCommand(): string {
  return normalizeAutoLsCommand(useSettingsStore.getState().terminalAutoLsCommand);
}

export function getAdaptedAutoLsCommandForSession(sessionId: string): string {
  const shell = resolveShellFamilyForSession(sessionId);
  return adaptAutoLsCommandForShell(getTerminalAutoLsCommand(), shell);
}

/** cd 命令在 Block Feed 下拼接列表子命令（仅 warp + 开关开启） */
export function maybeAppendAutoLsToCommand(
  command: string,
  sessionId?: string,
): string {
  if (!isTerminalAutoLsEnabled()) return command;
  if (sessionId && !isWarpDisplay(sessionId)) return command;
  if (sessionId && isSilentHistorySync(sessionId)) return command;
  if (!isCdOnlyCommand(command)) return command;

  const shell = resolveShellFamilyForSession(sessionId);
  return buildCdWithAutoLs(command, getTerminalAutoLsCommand(), shell);
}

export function unregisterTerminalAutoLsSession(_sessionId: string): void {
  // no-op
}

const CD_BLOCK_FALLBACK_MS = 880;
const SHELL_BLOCK_FALLBACK_MS = 2_000;

/** cd 常无输出时超时标记完成（纯 cd 兜底） */
export function scheduleCdBlockFallbackComplete(
  sessionId: string,
  blockId: string,
): void {
  void sessionId;
  window.setTimeout(() => {
    finalizeRunningShellBlock(blockId);
  }, CD_BLOCK_FALLBACK_MS);
}

/** 任意 shell 命令兜底完成（空 ls、OSC 133 丢失等） */
export function scheduleShellBlockFallbackComplete(
  sessionId: string,
  blockId: string,
  timeoutMs = SHELL_BLOCK_FALLBACK_MS,
): void {
  void sessionId;
  window.setTimeout(() => {
    finalizeRunningShellBlock(blockId);
  }, timeoutMs);
}

function finalizeRunningShellBlock(blockId: string): void {
  const block = useBlocksStore.getState().findBlockById(blockId);
  if (!block || block.status !== "running" || block.kind === "ai") return;

  const cmd = normalizeBlockCommand(block.command);
  const cleaned = cmd ? extractCommandOutput(block.output, cmd) : block.output.trim();
  useBlocksStore.getState().updateBlock(blockId, {
    status: "completed",
    exitCode: block.exitCode ?? 0,
    ...(cleaned ? { output: cleaned } : {}),
  });
}
