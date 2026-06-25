import type { McpToolRegistration } from "../../../lib/ai/context";
import { useTerminalStore } from "../../../stores/terminalStore";
import { resolveResourceById } from "../../../stores/connectionStore";
import { requestTerminalExecution, type TerminalExecutionResult } from "../executeTerminalCommand";
import { LOCAL_TERMINAL_RESOURCE_ID } from "../paneResource";

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`缺少必填参数：${key}`);
  }
  return value.trim();
}

export interface TerminalCommandCoreArgs {
  command: string;
  session_id?: string;
}

/** 供 inlineToolBridge 与 MCP 工具共用的终端命令执行核心 */
export async function executeTerminalCommandCore(
  args: TerminalCommandCoreArgs,
): Promise<TerminalExecutionResult & { outputJson: string }> {
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

  const result = await requestTerminalExecution({
    tabId,
    command,
    resourceId: resource?.id ?? tab?.session.resourceId,
    source: "AI",
    title: "AI 终端命令",
    description: command,
    waitForBlock: true,
  });

  const block = "block" in result ? result.block : undefined;
  if (!block) {
    const outputJson = JSON.stringify({ status: "submitted", command }, null, 2);
    return { ...result, outputJson };
  }

  const output = block.output.trim();
  const outputJson = JSON.stringify(
    {
      command: block.command.trim() || command,
      exitCode: block.exitCode,
      status: block.status,
      cwd: block.cwd.trim() || tab?.session.cwd || "",
      output: output.slice(-4000),
    },
    null,
    2,
  );

  return { ...result, outputJson };
}

async function runTerminalCommand(args: Record<string, unknown>): Promise<string> {
  const command = requireString(args, "command");
  const { outputJson } = await executeTerminalCommandCore({
    command,
    session_id: typeof args.session_id === "string" ? args.session_id : undefined,
  });
  return outputJson;
}

export const TERMINAL_MODULE_MCP_TOOLS: McpToolRegistration[] = [
  {
    name: "run_terminal_command",
    description:
      "在当前活动终端会话中执行 shell 命令。危险命令会进入用户确认流程；执行完成后返回退出码与输出。",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的 shell 命令",
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
