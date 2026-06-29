import { useBlocksStore } from "../../stores/blocksStore";
import { findTerminalPane } from "../../stores/terminalStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  isCdOnlyCommand,
  normalizeAutoLsCommand,
  buildCdWithAutoLs,
  isCdNavigationCommand,
} from "./terminalAutoLsPolicy";
import {
  adaptAutoLsCommandForShell,
  resolveTerminalShellFamily,
} from "./terminalAutoLsShell";
import { isSilentHistorySync } from "./commandBar/shellHistorySync";
import { isWarpDisplay } from "./terminalDisplayMode";

export { isCdOnlyCommand, isCdNavigationCommand, normalizeAutoLsCommand, stripAutoLsSuffix } from "./terminalAutoLsPolicy";

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

/** cd 常无输出时超时标记完成（纯 cd 兜底） */
export function scheduleCdBlockFallbackComplete(
  sessionId: string,
  blockId: string,
): void {
  void sessionId;
  window.setTimeout(() => {
    const block = useBlocksStore.getState().findBlockById(blockId);
    if (!block || block.status !== "running" || !isCdNavigationCommand(block.command)) {
      return;
    }
    useBlocksStore.getState().updateBlock(blockId, {
      status: "completed",
      exitCode: 0,
    });
  }, CD_BLOCK_FALLBACK_MS);
}
