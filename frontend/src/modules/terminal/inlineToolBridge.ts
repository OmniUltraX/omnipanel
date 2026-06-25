import { checkCommand, type DangerLevel } from "../../lib/commandGuard";
import { getResourceById } from "../../lib/resourceRegistry";
import {
  createBlockId,
  useBlocksStore,
  type AiThreadToolCall,
} from "../../stores/blocksStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { resolveResourceById } from "../../stores/connectionStore";
import { cancelTerminalExecution, requestTerminalExecution } from "./executeTerminalCommand";
import { LOCAL_TERMINAL_RESOURCE_ID } from "./paneResource";
import { useTerminalUiStore } from "./terminalUiStore";

export interface InlineToolDecision {
  approved: boolean;
  result: string;
  shellBlockId?: string;
  exitCode?: number | null;
}

interface PendingInlineTool {
  blockId: string;
  sessionId: string;
  tabId: string;
  resourceId?: string;
  command: string;
  resolve: (decision: InlineToolDecision) => void;
}

const pendingByToolCallId = new Map<string, PendingInlineTool>();

function parseCommandFromArgs(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson) as { command?: string };
    if (typeof parsed.command === "string" && parsed.command.trim()) {
      return parsed.command.trim();
    }
  } catch {
    // ignore
  }
  return "";
}

function assessRisk(command: string, resourceId?: string): DangerLevel {
  const resource = getResourceById(resourceId);
  const environment = resource?.environment ?? "unknown";
  const riskCheck = checkCommand(command, environment);
  const envRisk: DangerLevel =
    environment === "prod" ? "high" : environment === "staging" ? "medium" : "low";
  const order: DangerLevel[] = ["low", "medium", "high", "critical"];
  return order.indexOf(riskCheck.level) >= order.indexOf(envRisk)
    ? riskCheck.level
    : envRisk;
}

export function createInlineTerminalToolCall(
  blockId: string,
  sessionId: string,
  toolCallId: string,
  toolName: string,
  argsJson: string,
): { toolCallId: string; command: string; riskLevel: DangerLevel } {
  const command = parseCommandFromArgs(argsJson);
  const tab = useTerminalStore.getState().tabs.find((t) => t.id === sessionId);
  const resourceId = tab?.session.resourceId ?? LOCAL_TERMINAL_RESOURCE_ID;
  const riskLevel = assessRisk(command, resourceId);

  useBlocksStore.getState().pushAiThreadItem(blockId, {
    kind: "tool_call",
    id: toolCallId,
    toolName,
    args: argsJson,
    command,
    status: "pending",
    riskLevel,
  });

  useTerminalUiStore.getState().setExpandedAiBlock(sessionId, blockId);

  return { toolCallId, command, riskLevel };
}

export function waitForInlineToolDecision(
  blockId: string,
  toolCallId: string,
  sessionId: string,
  command: string,
): Promise<InlineToolDecision> {
  const tab = useTerminalStore.getState().tabs.find((t) => t.id === sessionId);
  const resource =
    resolveResourceById(tab?.session.resourceId ?? null) ??
    resolveResourceById(LOCAL_TERMINAL_RESOURCE_ID);

  return new Promise((resolve) => {
    pendingByToolCallId.set(toolCallId, {
      blockId,
      sessionId,
      tabId: sessionId,
      resourceId: resource?.id ?? tab?.session.resourceId,
      command,
      resolve,
    });
  });
}

export function cancelPendingInlineTools(blockId?: string): void {
  for (const [id, pending] of pendingByToolCallId.entries()) {
    if (blockId && pending.blockId !== blockId) continue;
    pending.resolve({ approved: false, result: "用户已取消" });
    useBlocksStore.getState().updateAiThreadItem(pending.blockId, id, {
      status: "rejected",
      result: "用户已取消",
    } as Partial<AiThreadToolCall>);
    pendingByToolCallId.delete(id);
  }
}

export async function approveInlineTerminalTool(
  blockId: string,
  toolCallId: string,
  commandOverride?: string,
): Promise<void> {
  const pending = pendingByToolCallId.get(toolCallId);
  if (!pending || pending.blockId !== blockId) return;

  const command = (commandOverride ?? pending.command).trim();
  if (!command) {
    rejectInlineTerminalTool(blockId, toolCallId);
    return;
  }

  useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
    command,
    status: "running",
  } as Partial<AiThreadToolCall>);

  try {
    const execResult = await requestTerminalExecution({
      tabId: pending.tabId,
      command,
      resourceId: pending.resourceId,
      source: "AI",
      title: "AI 终端命令",
      description: command,
      waitForBlock: true,
    });

    const block = "block" in execResult ? execResult.block : undefined;
    const output = block?.output.trim() ?? "";
    const exitCode = block?.exitCode ?? null;
    const resultPayload = JSON.stringify(
      {
        command: block?.command.trim() || command,
        exitCode,
        status: block?.status ?? "completed",
        cwd: block?.cwd?.trim() ?? "",
        output: output.slice(-4000),
      },
      null,
      2,
    );

    useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
      status: exitCode === 0 || exitCode === null ? "completed" : "failed",
      result: resultPayload,
      shellBlockId: block?.id,
      actionId: execResult.action.id,
    } as Partial<AiThreadToolCall>);

    pending.resolve({
      approved: true,
      result: resultPayload,
      shellBlockId: block?.id,
      exitCode,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
      status: "failed",
      result: message,
    } as Partial<AiThreadToolCall>);
    pending.resolve({ approved: true, result: message, exitCode: 1 });
  } finally {
    pendingByToolCallId.delete(toolCallId);
  }
}

export function rejectInlineTerminalTool(blockId: string, toolCallId: string): void {
  const pending = pendingByToolCallId.get(toolCallId);
  if (!pending || pending.blockId !== blockId) return;

  const result = "用户拒绝执行";
  useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
    status: "rejected",
    result,
  } as Partial<AiThreadToolCall>);

  pending.resolve({ approved: false, result });
  pendingByToolCallId.delete(toolCallId);
}

export function newInlineToolCallId(): string {
  return createBlockId();
}

export function cancelInlineToolByActionId(actionId: string): void {
  for (const [toolCallId, pending] of pendingByToolCallId.entries()) {
    void actionId;
    cancelTerminalExecution(actionId);
    rejectInlineTerminalTool(pending.blockId, toolCallId);
  }
}
