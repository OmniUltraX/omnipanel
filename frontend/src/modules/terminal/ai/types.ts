import type { TerminalSessionInfo } from "../../../stores/terminalStore";
import type { WorkspaceResource } from "../../../lib/resourceRegistry";
import type { TerminalBlock } from "../../../stores/blocksStore";

export interface TerminalModuleContext {
  activeSessionId: string | null;
  session: TerminalSessionInfo | null;
  resource: WorkspaceResource | null;
  recentBlocks: TerminalBlock[];
  lastError: TerminalBlock | null;
}

export function isTerminalModuleContextEmpty(ctx: TerminalModuleContext): boolean {
  return !ctx.activeSessionId || !ctx.session;
}

export function buildTerminalModuleContext(input: {
  activeSessionId: string | null;
  session: TerminalSessionInfo | null;
  resource: WorkspaceResource | null;
  blocks: TerminalBlock[];
}): TerminalModuleContext {
  const sessionBlocks = input.activeSessionId
    ? input.blocks.filter((b) => b.sessionId === input.activeSessionId)
    : [];
  let lastError: TerminalBlock | null = null;
  for (let i = sessionBlocks.length - 1; i >= 0; i -= 1) {
    const block = sessionBlocks[i];
    if (block.status === "failed" || (block.exitCode !== null && block.exitCode !== 0 && block.exitCode !== 130 && block.exitCode !== 141)) {
      lastError = block;
      break;
    }
  }
  return {
    activeSessionId: input.activeSessionId,
    session: input.session,
    resource: input.resource,
    recentBlocks: sessionBlocks.slice(-8),
    lastError,
  };
}
