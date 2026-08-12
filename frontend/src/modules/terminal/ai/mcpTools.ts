import type { BuiltinToolRegistration } from "../../../lib/ai/context";
import type { WorkspaceAction } from "../../../stores/actionStore";
import type { TerminalBlock } from "../../../stores/blocksStore";
import { useTerminalStore, findTerminalPane } from "../../../stores/terminalStore";
import { resolveResourceById } from "../../../stores/connectionStore";
import { executeAiTerminalCommand } from "../executeAiTerminalCommand";
import { LOCAL_TERMINAL_RESOURCE_ID } from "../paneResource";

export interface TerminalCommandCoreArgs {
  command: string;
  session_id?: string;
}

export type TerminalCommandCoreResult =
  | { rejected: true; outputJson: string }
  | {
      rejected?: false;
      outputJson: string;
      action: WorkspaceAction;
      block?: TerminalBlock;
    };

/**
 * 终端 PTY 内执行命令的核心（供 UI/内联审批等本地路径复用）。
 * 对外 AI「跑命令」工具已统一为 `omni_ssh_exec`（覆盖本地会话与 SSH）；
 * 本模块不再单独注册 `omni_terminal_*`。
 */
export async function executeTerminalCommandCore(
  args: TerminalCommandCoreArgs,
): Promise<TerminalCommandCoreResult> {
  const command = args.command.trim();
  const tabId =
    typeof args.session_id === "string" && args.session_id.trim()
      ? args.session_id.trim()
      : useTerminalStore.getState().activeTabId;

  if (!tabId) {
    throw new Error("当前没有活动的终端会话");
  }

  const pane = findTerminalPane(tabId);
  const resource =
    resolveResourceById(pane?.resourceId ?? null) ??
    resolveResourceById(LOCAL_TERMINAL_RESOURCE_ID);

  const result = await executeAiTerminalCommand({
    tabId,
    command,
    resourceId: resource?.id ?? pane?.resourceId,
  });

  if (result.rejected) {
    return {
      rejected: true,
      outputJson: result.outputJson,
    };
  }

  if (!result.action) {
    throw new Error("终端命令执行未返回 action");
  }

  return {
    outputJson: result.outputJson,
    action: result.action,
    block: result.block,
    rejected: false,
  };
}

/** 终端模块不再注册独立「跑命令」工具（与 omni_ssh_exec 合并）。 */
export const TERMINAL_MODULE_TOOLS: BuiltinToolRegistration[] = [];
