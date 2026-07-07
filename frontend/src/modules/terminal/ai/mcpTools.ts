import type { McpToolRegistration } from "../../../lib/ai/context";
import type { WorkspaceAction } from "../../../stores/actionStore";
import type { TerminalBlock } from "../../../stores/blocksStore";
import { requireString } from "../../../lib/ai/mcpToolArgs";
import { useTerminalStore } from "../../../stores/terminalStore";
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

/** 供 inlineToolBridge 与 MCP 工具共用的终端命令执行核心 */
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

  const tab = useTerminalStore.getState().tabs.find((item) => item.id === tabId);
  const resource =
    resolveResourceById(tab?.session.resourceId ?? null) ??
    resolveResourceById(LOCAL_TERMINAL_RESOURCE_ID);

  const result = await executeAiTerminalCommand({
    tabId,
    command,
    resourceId: resource?.id ?? tab?.session.resourceId,
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

async function runTerminalCommand(args: Record<string, unknown>): Promise<string> {
  const command = requireString(args, "command");
  const { outputJson } = await executeTerminalCommandCore({
    command,
    session_id: typeof args.session_id === "string" ? args.session_id : undefined,
  });
  return outputJson;
}

/** 终端模块 MCP 工具名（omni_{module}_{function_name}） */
export const OMNI_TERMINAL_RUN_TERMINAL_COMMAND = "omni_terminal_run_terminal_command";

export const TERMINAL_MODULE_MCP_TOOLS: McpToolRegistration[] = [
  {
    name: OMNI_TERMINAL_RUN_TERMINAL_COMMAND,
    description:
      "在当前终端会话执行 shell 命令并返回退出码与输出。不支持交互式/TUI/流式命令（如 top、vim、tail -f、claude）；请改用批处理替代（如 top -bn1 | head、tail -n 100）。安装类长任务（npm/docker/apt）可执行但可能耗时较长。",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的 shell 命令（非交互式）",
        },
        session_id: {
          type: "string",
          description: "可选，指定终端 tab id；默认使用当前活动终端",
        },
      },
      required: ["command"],
    },
    handler: runTerminalCommand,
  },
];
