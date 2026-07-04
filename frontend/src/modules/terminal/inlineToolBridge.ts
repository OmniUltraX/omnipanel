import { checkCommand, type DangerLevel } from "../../lib/commandGuard";
import { getResourceById } from "../../lib/resourceRegistry";
import { reportToolResultWithRetry } from "../../lib/ai/reportToolResult";
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
import { resolveTerminalApprovalMode } from "./terminalApprovalSettings";
import { shouldRequireTerminalApproval } from "./terminalApprovalPolicy";
import {
  extractCommandOutput,
  isLikelyCommandEchoAsOutput,
} from "./terminalOutputText";

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
  conversationId: string;
  resolve: (decision: InlineToolDecision) => void;
}

const pendingByToolCallId = new Map<string, PendingInlineTool>();
const approvingToolCallIds = new Set<string>();

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

function resolveToolOutput(rawOutput: string, command: string): string {
  const trimmed = rawOutput.trim();
  if (!trimmed) return "";
  const cleaned = extractCommandOutput(trimmed, command);
  if (cleaned) return cleaned;
  if (isLikelyCommandEchoAsOutput(trimmed, command)) return "";
  return trimmed;
}

function buildToolResultPayload(options: {
  command: string;
  blockCommand?: string;
  output: string;
  exitCode: number | null;
  status: string;
  cwd: string;
}): string {
  return JSON.stringify(
    {
      command: options.blockCommand?.trim() || options.command,
      exitCode: options.exitCode,
      status: options.status,
      cwd: options.cwd.trim(),
      output: options.output.slice(-4000),
    },
    null,
    2,
  );
}

async function deliverToolResultToBackend(
  conversationId: string,
  toolCallId: string,
  result: string,
  approved: boolean,
): Promise<void> {
  try {
    await reportToolResultWithRetry(conversationId, toolCallId, result, approved);
  } catch {
    // 重试仍失败时静默；后端将超时，卡片可手动停止。
  }
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
  conversationId: string,
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
      conversationId,
      resolve,
    });

    const mode = resolveTerminalApprovalMode(sessionId);
    if (!shouldRequireTerminalApproval(command, mode)) {
      queueMicrotask(() => {
        void approveInlineTerminalTool(blockId, toolCallId);
      });
    }
  });
}

export function cancelPendingInlineTools(blockId?: string): void {
  for (const [id, pending] of pendingByToolCallId.entries()) {
    if (blockId && pending.blockId !== blockId) continue;
    const result = "用户已取消";
    pending.resolve({ approved: false, result });
    void deliverToolResultToBackend(pending.conversationId, id, result, false);
    useBlocksStore.getState().updateAiThreadItem(pending.blockId, id, {
      status: "rejected",
      result,
    } as Partial<AiThreadToolCall>);
    pendingByToolCallId.delete(id);
  }
}

export async function approveInlineTerminalTool(
  blockId: string,
  toolCallId: string,
  commandOverride?: string,
): Promise<void> {
  if (approvingToolCallIds.has(toolCallId)) return;

  const pending = pendingByToolCallId.get(toolCallId);
  if (!pending || pending.blockId !== blockId) return;

  approvingToolCallIds.add(toolCallId);
  const { conversationId } = pending;

  try {
    const command = (commandOverride ?? pending.command).trim();

    if (!command) {
      const result =
        '工具调用缺少必填参数 command。请在 arguments 中提供 JSON，例如 {"command":"date"}，然后重试。';
      useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
        status: "failed",
        result,
      } as Partial<AiThreadToolCall>);
      pendingByToolCallId.delete(toolCallId);
      await deliverToolResultToBackend(conversationId, toolCallId, result, false);
      pending.resolve({ approved: false, result });
      return;
    }

    useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
      command,
      status: "running",
    } as Partial<AiThreadToolCall>);

    let decision: InlineToolDecision = { approved: false, result: "" };
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
      const rawOutput = block?.output.trim() ?? "";
      const output = resolveToolOutput(rawOutput, block?.command.trim() || command);
      const exitCode = block?.exitCode ?? null;
      const resultPayload = buildToolResultPayload({
        command,
        blockCommand: block?.command,
        output,
        exitCode,
        status: block?.status ?? "completed",
        cwd: block?.cwd?.trim() ?? "",
      });

      useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
        status: exitCode === 0 || exitCode === null ? "completed" : "failed",
        result: resultPayload,
        shellBlockId: block?.id,
        actionId: execResult.action.id,
      } as Partial<AiThreadToolCall>);

      decision = {
        approved: true,
        result: resultPayload,
        shellBlockId: block?.id,
        exitCode,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
        status: "failed",
        result: message,
      } as Partial<AiThreadToolCall>);
      decision = { approved: true, result: message, exitCode: 1 };
    }

    pendingByToolCallId.delete(toolCallId);
    await deliverToolResultToBackend(
      conversationId,
      toolCallId,
      decision.result,
      decision.approved,
    );
    pending.resolve(decision);
  } finally {
    approvingToolCallIds.delete(toolCallId);
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

  pendingByToolCallId.delete(toolCallId);
  void deliverToolResultToBackend(pending.conversationId, toolCallId, result, false);
  pending.resolve({ approved: false, result });
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
