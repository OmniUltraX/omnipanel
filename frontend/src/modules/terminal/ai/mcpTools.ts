import type { BuiltinToolRegistration } from "../../../lib/ai/context";
import { optionalString } from "../../../lib/ai/mcpToolArgs";
import { runWithToolGate } from "../../../lib/ai/toolGate";
import {
  TERMINAL_EXEC_TOOL_NAME,
  parseTerminalExecCommandFromArgs,
} from "../../../lib/ai/terminalExecTool";
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
 * 对外「当前 Tab 跑命令」工具为 `omni_terminal_exec`；`omni_ssh_exec` 走 SSH 连接池。
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

async function terminalExec(args: Record<string, unknown>): Promise<string> {
  const command = parseTerminalExecCommandFromArgs(args);
  if (!command) {
    throw new Error(
      '缺少必填参数：command。请提供 JSON，例如 {"command":"Get-Date"} 或 {"command":"date"}。',
    );
  }
  const session_id = optionalString(args, "session_id");
  const tabId = session_id ?? useTerminalStore.getState().activeTabId;
  const pane = tabId ? findTerminalPane(tabId) : undefined;

  const run = async () => {
    const result = await executeTerminalCommandCore({ command, session_id });
    return result.outputJson;
  };

  return runWithToolGate(
    {
      toolName: TERMINAL_EXEC_TOOL_NAME,
      args,
      resourceId: pane?.resourceId ?? LOCAL_TERMINAL_RESOURCE_ID,
      channel: "ui-delegated",
    },
    run,
  );
}

/** 当前终端 PTY 执行（命令栏 / 直通 / 侧栏绑定活动 Tab）。 */
export const TERMINAL_MODULE_TOOLS: BuiltinToolRegistration[] = [
  {
    name: TERMINAL_EXEC_TOOL_NAME,
    description:
      "在当前活动终端 Tab 的 PTY 中执行命令（本地 PowerShell/CMD/bash，或该 Tab 已打开的 SSH 壳），\
继承 cwd/环境，并在终端中显示命令块。查时间/文件/进程等实时事实必须调用本工具，禁止凭记忆编造。\
不要传 resource_id。不支持 TUI/流式（top/vim/tail -f）。指定其它 SSH 主机且不使用当前 Tab 时改用 omni_ssh_exec。",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "要在当前终端会话执行的命令（语法须匹配该会话 shell：PowerShell 用 Get-Date 等）",
        },
        session_id: {
          type: "string",
          description: "可选；终端 Tab id。省略则使用当前活动终端",
        },
      },
      required: ["command"],
    },
    handler: terminalExec,
  },
];
