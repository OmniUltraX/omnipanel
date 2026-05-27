import type { TerminalBlock } from "../stores/blocksStore";

export interface TerminalContextInfo {
  type: "terminal";
  sessionId: string;
  cwd: string;
  recentCommands: Array<{
    command: string;
    exitCode: number | null;
    status: string;
  }>;
  lastError: {
    command: string;
    exitCode: number;
    output: string;
  } | null;
}

export function collectTerminalContext(
  sessionId: string,
  blocks: TerminalBlock[],
  maxBlocks = 5
): TerminalContextInfo {
  const sessionBlocks = blocks.filter((b) => b.sessionId === sessionId);
  const recent = sessionBlocks.slice(-maxBlocks);

  let lastError: TerminalContextInfo["lastError"] = null;
  for (let i = sessionBlocks.length - 1; i >= 0; i--) {
    const b = sessionBlocks[i];
    if (b.status === "failed" || (b.exitCode !== null && b.exitCode !== 0)) {
      lastError = {
        command: b.command,
        exitCode: b.exitCode ?? 1,
        output: b.output.slice(-500), // Last 500 chars of output
      };
      break;
    }
  }

  const cwd =
    sessionBlocks.length > 0
      ? sessionBlocks[sessionBlocks.length - 1].cwd
      : "";

  return {
    type: "terminal",
    sessionId,
    cwd,
    recentCommands: recent.map((b) => ({
      command: b.command,
      exitCode: b.exitCode,
      status: b.status,
    })),
    lastError,
  };
}

export function formatContextForAI(ctx: TerminalContextInfo): string {
  let text = `## Terminal Context\n`;
  text += `- Session: ${ctx.sessionId}\n`;
  if (ctx.cwd) text += `- Working directory: ${ctx.cwd}\n`;

  if (ctx.recentCommands.length > 0) {
    text += `\n### Recent commands:\n`;
    for (const cmd of ctx.recentCommands) {
      const status =
        cmd.exitCode === 0
          ? "✓"
          : cmd.exitCode !== null
            ? `✗ (exit ${cmd.exitCode})`
            : "⏳";
      text += `- \`${cmd.command}\` ${status}\n`;
    }
  }

  if (ctx.lastError) {
    text += `\n### Last error:\n`;
    text += `- Command: \`${ctx.lastError.command}\`\n`;
    text += `- Exit code: ${ctx.lastError.exitCode}\n`;
    if (ctx.lastError.output) {
      text += `- Output:\n\`\`\`\n${ctx.lastError.output}\n\`\`\`\n`;
    }
  }

  return text;
}
