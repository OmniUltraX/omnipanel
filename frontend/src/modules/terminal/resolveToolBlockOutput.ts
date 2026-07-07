import type { TerminalBlock } from "../../stores/blocksStore";
import type { CommandExecutionProfile, TerminalToolResultPayload } from "./terminalCommandProfile";
import { flattenOutputModel } from "./terminalOutputModel";
import {
  extractCommandOutput,
  isEchoOnlyTerminalOutput,
  isLikelyCommandEchoAsOutput,
} from "./terminalOutputText";

const MAX_OUTPUT_CHARS = 4000;

function pickLongestNonEmpty(...candidates: string[]): string {
  let best = "";
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed.length > best.length) {
      best = trimmed;
    }
  }
  return best;
}

function extractProgressTail(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  return lines[lines.length - 1];
}

export function resolveBlockTextOutput(
  block: TerminalBlock | null | undefined,
  command: string,
  watchOutput?: string,
): string {
  const fromLive = block?.liveOutput ? flattenOutputModel(block.liveOutput) : "";
  const fromBlock = block?.output?.trim() ?? "";
  const cleanedBlock = fromBlock
    ? extractCommandOutput(fromBlock, command) || fromBlock
    : "";
  const cleanedLive = fromLive ? extractCommandOutput(fromLive, command) || fromLive : "";
  const cleanedWatch = watchOutput
    ? extractCommandOutput(watchOutput, command) || watchOutput.trim()
    : "";

  const merged = pickLongestNonEmpty(cleanedLive, cleanedBlock, cleanedWatch);
  if (!merged) return "";

  if (
    isEchoOnlyTerminalOutput(merged, command) ||
    isLikelyCommandEchoAsOutput(merged, command)
  ) {
    return "";
  }
  return merged;
}

export function buildToolResultFromBlock(options: {
  command: string;
  block: TerminalBlock | null | undefined;
  watchOutput?: string;
  profile: CommandExecutionProfile;
  cwd: string;
  startedAt: number;
}): TerminalToolResultPayload {
  const { command, block, watchOutput, profile, cwd, startedAt } = options;
  const blockCommand = block?.command?.trim() || command;
  const output = resolveBlockTextOutput(block, blockCommand, watchOutput);
  const progressTail =
    profile.kind === "progress" ? extractProgressTail(output) : undefined;

  const payload: TerminalToolResultPayload = {
    command: blockCommand,
    exitCode: block?.exitCode ?? null,
    status: block?.status ?? (output ? "completed" : "completed"),
    cwd: block?.cwd?.trim() || cwd,
    output: output.slice(-MAX_OUTPUT_CHARS),
    profileKind: profile.kind,
    durationMs: Date.now() - startedAt,
  };

  if (progressTail) {
    payload.progressTail = progressTail;
  }

  if (!output) {
    payload.emptyOutput = true;
    payload.diagnostic =
      "命令已执行但未采集到有效输出。可能原因：shell 集成未就绪、输出被回显过滤、或命令无 stdout。";
    if (block?.exitCode !== 0 && block?.exitCode != null) {
      payload.status = "failed";
    }
  }

  return payload;
}
