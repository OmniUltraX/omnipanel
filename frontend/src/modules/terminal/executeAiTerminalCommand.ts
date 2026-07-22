import type { WorkspaceAction } from "../../stores/actionStore";
import { useBlocksStore, type TerminalBlock } from "../../stores/blocksStore";
import { findTerminalPane } from "../../stores/terminalStore";
import {
  getOutputWatchText,
  requestTerminalExecution,
  type TerminalExecutionResult,
} from "./executeTerminalCommand";
import {
  buildProfileRejectPayload,
  resolveCommandProfile,
  serializeToolResultPayload,
  type TerminalToolResultPayload,
} from "./terminalCommandProfile";
import { buildToolResultFromBlock } from "./resolveToolBlockOutput";

export interface ExecuteAiTerminalCommandOptions {
  tabId: string;
  command: string;
  resourceId?: string;
}

export interface ExecuteAiTerminalCommandResult {
  rejected: boolean;
  payload: TerminalToolResultPayload;
  outputJson: string;
  action?: WorkspaceAction;
  block?: TerminalBlock;
}

function mergeBlockWithWatch(
  block: TerminalBlock | undefined,
  sessionId: string,
): TerminalBlock | undefined {
  if (!block) return undefined;
  const watchText = getOutputWatchText(sessionId).trim();
  if (!watchText || block.output.trim().length >= watchText.length) {
    return block;
  }
  return { ...block, output: watchText };
}

function resolveStoredBlock(block: TerminalBlock | undefined): TerminalBlock | undefined {
  if (!block?.id) return block;
  return useBlocksStore.getState().findBlockById(block.id) ?? block;
}

/** AI 工具统一终端命令执行入口：profile 分流、拒绝策略、双源输出合并。 */
export async function executeAiTerminalCommand(
  options: ExecuteAiTerminalCommandOptions,
): Promise<ExecuteAiTerminalCommandResult> {
  const command = options.command.trim();
  const profile = resolveCommandProfile(command, "AI");
  const startedAt = Date.now();

  if (!profile.allowAiExecution) {
    const payload = buildProfileRejectPayload(profile, command);
    return {
      rejected: true,
      payload,
      outputJson: serializeToolResultPayload(payload),
    };
  }

  const execResult = (await requestTerminalExecution({
    tabId: options.tabId,
    command,
    resourceId: options.resourceId,
    source: "AI",
    title: "AI 终端命令",
    description: command,
    waitForBlock: true,
  })) as TerminalExecutionResult & { block?: TerminalBlock };

  const rawBlock = execResult.block;
  const mergedBlock = mergeBlockWithWatch(rawBlock, options.tabId);
  const storeBlock = resolveStoredBlock(mergedBlock);

  const pane = findTerminalPane(options.tabId);
  const payload = buildToolResultFromBlock({
    command,
    block: storeBlock,
    watchOutput: getOutputWatchText(options.tabId),
    profile,
    cwd: pane?.cwd ?? "",
    startedAt,
  });

  return {
    rejected: false,
    payload,
    outputJson: serializeToolResultPayload(payload),
    action: execResult.action,
    block: storeBlock,
  };
}
