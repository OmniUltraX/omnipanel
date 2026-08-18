import { checkCommand, type DangerLevel } from "../../lib/commandGuard";
import { errorToString } from "../../lib/errorToString";
import { getResourceById } from "../../lib/resourceRegistry";
import { reportToolResultWithRetry } from "../../lib/ai/reportToolResult";
import {
  createBlockId,
  isAiThreadToolCall,
  useBlocksStore,
  type AiThreadToolCall,
} from "../../stores/blocksStore";
import { showToast } from "../../stores/toastStore";
import { pushAssistantErrorMessage } from "./aiThreadBridge";
import { findTerminalPane } from "../../stores/terminalStore";
import { resolveResourceById } from "../../stores/connectionStore";
import { cancelTerminalExecution } from "./executeTerminalCommand";
import { executeAiTerminalCommand } from "./executeAiTerminalCommand";
import { LOCAL_TERMINAL_RESOURCE_ID } from "./paneResource";
import { useTerminalUiStore } from "./terminalUiStore";
import { resolveTerminalApprovalMode } from "./terminalApprovalSettings";
import { shouldRequireTerminalApproval } from "./terminalApprovalPolicy";
import { patchEnterGateFlags } from "./passthroughAi/enterGates";
import {
  notifyShellAgentApprovalPending,
  notifyShellAgentExecuting,
  notifyShellAgentRejected,
} from "./shellAgent/loop";
import { useShellAgentStore } from "./shellAgent/shellAgentStore";
import {
  getShellAgentLastCmd,
  setShellAgentLastCmd,
  stampFrozenCmdResultInRoot,
} from "./shellAgent/thinkingCache";
import { getXterm } from "./xtermRegistry";

export interface InlineToolDecision {
  approved: boolean;
  result: string;
  shellBlockId?: string;
  exitCode?: number | null;
}

function stampInlineCmdResult(sessionId: string, toolId: string, result: string): void {
  const root = getXterm(sessionId)?.element;
  if (!root || !result.trim()) return;
  stampFrozenCmdResultInRoot(root, sessionId, toolId, result);
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

const STALE_APPROVAL_RESULT = "审批已失效（会话已中断），已关闭确认条";

export function hasLivePendingInlineTool(toolCallId: string): boolean {
  return pendingByToolCallId.has(toolCallId);
}

/** 供审批条解析会话白名单作用域 */
export function getPendingInlineToolScope(
  toolCallId: string,
  fallbackTerminalSessionId?: string,
): { conversationId?: string; terminalSessionId?: string } {
  const pending = pendingByToolCallId.get(toolCallId);
  return {
    conversationId: pending?.conversationId,
    terminalSessionId: pending?.sessionId ?? fallbackTerminalSessionId,
  };
}

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

async function deliverToolResultToBackend(
  conversationId: string,
  toolCallId: string,
  result: string,
  approved: boolean,
  blockId?: string,
): Promise<void> {
  try {
    await reportToolResultWithRetry(conversationId, toolCallId, result, approved);
  } catch (err) {
    if (!blockId) return;
    const message =
      err instanceof Error
        ? `工具回传失败：${err.message}`
        : "工具回传失败，请停止后重试";
    pushAssistantErrorMessage(blockId, message);
    useBlocksStore.getState().updateBlock(blockId, {
      status: "failed",
      exitCode: 1,
    });
    useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
      status: "failed",
      result: message,
    } as Partial<AiThreadToolCall>);
  }
}

function findToolCallItem(blockId: string, toolCallId: string): AiThreadToolCall | null {
  const block = useBlocksStore.getState().findBlockById(blockId);
  if (!block?.aiThread) return null;
  for (const item of block.aiThread) {
    if (isAiThreadToolCall(item) && item.id === toolCallId) return item;
  }
  return null;
}

/** UI 仍显示 pending/running，但内存等待表已丢失（热更新 / 取消 / 历史恢复） */
function dismissStaleInlineToolCall(
  blockId: string,
  toolCallId: string,
  status: "rejected" | "failed",
  result: string,
): boolean {
  const item = findToolCallItem(blockId, toolCallId);
  if (!item) return false;
  if (item.status !== "pending" && item.status !== "running") return false;
  useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
    status,
    result,
  } as Partial<AiThreadToolCall>);
  return true;
}

/** 扫掉指定 block（或全部）中无 live waiter 的僵尸确认项 */
export function dismissOrphanInlineToolCalls(blockId?: string): number {
  let count = 0;
  const store = useBlocksStore.getState();

  const visitBlock = (block: { id: string; aiThread?: typeof store.blocks[string][number]["aiThread"] }) => {
    if (!block.aiThread?.length) return;
    for (const item of block.aiThread) {
      if (!isAiThreadToolCall(item)) continue;
      if (item.status !== "pending" && item.status !== "running") continue;
      if (pendingByToolCallId.has(item.id)) continue;
      if (approvingToolCallIds.has(item.id)) continue;
      if (dismissStaleInlineToolCall(block.id, item.id, "rejected", STALE_APPROVAL_RESULT)) {
        count += 1;
      }
    }
  };

  if (blockId) {
    const block = store.findBlockById(blockId);
    if (block) visitBlock(block);
    return count;
  }

  for (const blocks of Object.values(store.blocks)) {
    for (const block of blocks) visitBlock(block);
  }
  return count;
}

export function createInlineTerminalToolCall(
  blockId: string,
  sessionId: string,
  toolCallId: string,
  toolName: string,
  argsJson: string,
): { toolCallId: string; command: string; riskLevel: DangerLevel } {
  const command = parseCommandFromArgs(argsJson);
  const pane = findTerminalPane(sessionId);
  const resourceId = pane?.resourceId ?? LOCAL_TERMINAL_RESOURCE_ID;
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
  const pane = findTerminalPane(sessionId);
  const resource =
    resolveResourceById(pane?.resourceId ?? null) ??
    resolveResourceById(LOCAL_TERMINAL_RESOURCE_ID);

  return new Promise((resolve) => {
    pendingByToolCallId.set(toolCallId, {
      blockId,
      sessionId,
      tabId: sessionId,
      resourceId: resource?.id ?? pane?.resourceId,
      command,
      conversationId,
      resolve,
    });

    if (
      useShellAgentStore.getState().isBusy(sessionId) ||
      useShellAgentStore.getState().get(sessionId)?.blockId === blockId
    ) {
      notifyShellAgentApprovalPending(sessionId);
      // Shell Agent 直通必须露出可点的同意/拒绝；不走 view/loose 静默自动同意
      return;
    }

    const mode = resolveTerminalApprovalMode(sessionId);
    if (
      !shouldRequireTerminalApproval(command, mode, {
        conversationId,
        terminalSessionId: sessionId,
      })
    ) {
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
    void deliverToolResultToBackend(pending.conversationId, id, result, false, pending.blockId);
    useBlocksStore.getState().updateAiThreadItem(pending.blockId, id, {
      status: "rejected",
      result,
    } as Partial<AiThreadToolCall>);
    pendingByToolCallId.delete(id);
  }
  // Map 已空但仍残留 UI pending 的项一并关掉
  dismissOrphanInlineToolCalls(blockId);
}

async function approveStaleInlineToolCall(
  blockId: string,
  toolCallId: string,
  commandOverride?: string,
): Promise<void> {
  const item = findToolCallItem(blockId, toolCallId);
  if (!item || (item.status !== "pending" && item.status !== "running")) return;

  const block = useBlocksStore.getState().findBlockById(blockId);
  const sessionId = block?.sessionId;
  const command = (commandOverride ?? item.command ?? parseCommandFromArgs(item.args)).trim();

  if (!sessionId || !command) {
    dismissStaleInlineToolCall(blockId, toolCallId, "failed", STALE_APPROVAL_RESULT);
    showToast(STALE_APPROVAL_RESULT);
    return;
  }

  // 🛡️ 防御性二次安全检查：stale 路径已丢失原始 pending waiter（热更新 / 会话恢复），
  // 不再经过 waitForInlineToolDecision 的审批门。为防止高危命令（rm -rf / DROP TABLE /
  // docker system prune -af 等）在此旁路被直接执行，一律拒绝并要求用户重新发起。
  const staleDanger = checkCommand(command);
  if (!staleDanger.safe && (staleDanger.level === "high" || staleDanger.level === "critical")) {
    const reason = `高危命令（${staleDanger.level}）的审批会话已失效，已拒绝自动执行，请重新发起以触发审批`;
    dismissStaleInlineToolCall(blockId, toolCallId, "rejected", reason);
    showToast(reason);
    return;
  }

  approvingToolCallIds.add(toolCallId);
  try {
    useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
      command,
      status: "running",
    } as Partial<AiThreadToolCall>);

    const pane = findTerminalPane(sessionId);
    const resourceId = pane?.resourceId ?? LOCAL_TERMINAL_RESOURCE_ID;
    try {
      const { clearRemoteInputLineBeforeExec } = await import("./shellAgent/loop");
      clearRemoteInputLineBeforeExec(sessionId);
      await new Promise<void>((r) => window.setTimeout(r, 60));

      const aiResult = await executeAiTerminalCommand({
        tabId: sessionId,
        command,
        resourceId,
      });
      if (aiResult.rejected) {
        useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
          status: "failed",
          result: aiResult.outputJson,
        } as Partial<AiThreadToolCall>);
        stampInlineCmdResult(sessionId, toolCallId, aiResult.outputJson);
      } else {
        const exitCode = aiResult.payload.exitCode;
        useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
          status: exitCode === 0 || exitCode === null ? "completed" : "failed",
          result: aiResult.outputJson,
          shellBlockId: aiResult.block?.id,
          actionId: aiResult.action?.id,
        } as Partial<AiThreadToolCall>);
        stampInlineCmdResult(sessionId, toolCallId, aiResult.outputJson);
      }
    } catch (err) {
      useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
        status: "failed",
        result: errorToString(err),
      } as Partial<AiThreadToolCall>);
    }
    showToast("原审批会话已失效，已按「执行」直接运行命令");
  } finally {
    approvingToolCallIds.delete(toolCallId);
  }
}

export async function approveInlineTerminalTool(
  blockId: string,
  toolCallId: string,
  commandOverride?: string,
): Promise<void> {
  if (approvingToolCallIds.has(toolCallId)) return;

  const pending = pendingByToolCallId.get(toolCallId);
  if (!pending || pending.blockId !== blockId) {
    await approveStaleInlineToolCall(blockId, toolCallId, commandOverride);
    return;
  }

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
      await deliverToolResultToBackend(conversationId, toolCallId, result, false, blockId);
      pending.resolve({ approved: false, result });
      return;
    }

    useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
      command,
      status: "running",
    } as Partial<AiThreadToolCall>);

    // 同意瞬间缓存命令，保证随后 reanchor 冻结成「已同意」卡（不依赖 React effect 时序）
    const prevCmd = getShellAgentLastCmd(pending.sessionId);
    setShellAgentLastCmd(pending.sessionId, {
      command,
      toolId: toolCallId,
      description: prevCmd?.description,
    });

    notifyShellAgentExecuting(pending.sessionId, true);
    patchEnterGateFlags(pending.sessionId, { agentExecuting: true });

    // 方案 C 执行序列：不撤流内卡 → (有残留输入才清行并等静默) → 画 prompt → 注入
    const { prepareShellAgentExecution } = await import("./shellAgent/loop");
    await prepareShellAgentExecution(pending.sessionId, command);

    let decision: InlineToolDecision = { approved: false, result: "" };
    try {
      const aiResult = await executeAiTerminalCommand({
        tabId: pending.tabId,
        command,
        resourceId: pending.resourceId,
      });

      if (aiResult.rejected) {
        useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
          status: "failed",
          result: aiResult.outputJson,
        } as Partial<AiThreadToolCall>);
        stampInlineCmdResult(pending.sessionId, toolCallId, aiResult.outputJson);
        decision = { approved: false, result: aiResult.outputJson };
      } else {
        const exitCode = aiResult.payload.exitCode;
        useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
          status: exitCode === 0 || exitCode === null ? "completed" : "failed",
          result: aiResult.outputJson,
          shellBlockId: aiResult.block?.id,
          actionId: aiResult.action?.id,
        } as Partial<AiThreadToolCall>);
        stampInlineCmdResult(pending.sessionId, toolCallId, aiResult.outputJson);

        decision = {
          approved: true,
          result: aiResult.outputJson,
          shellBlockId: aiResult.block?.id,
          exitCode,
        };
      }
    } catch (err) {
      const message = errorToString(err);
      useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
        status: "failed",
        result: message,
      } as Partial<AiThreadToolCall>);
      stampInlineCmdResult(pending.sessionId, toolCallId, message);
      decision = { approved: false, result: message };
    } finally {
      // 勿在此 idle：还要 deliverToolResult 让模型续写总结 / 下一轮工具
      notifyShellAgentExecuting(pending.sessionId, false);
      const { notifyShellAgentObserving } = await import("./shellAgent/loop");
      notifyShellAgentObserving(pending.sessionId);
      patchEnterGateFlags(pending.sessionId, { agentExecuting: false });
    }

    pendingByToolCallId.delete(toolCallId);
    {
      const { notifyShellAgentStreaming } = await import("./shellAgent/loop");
      notifyShellAgentStreaming(pending.sessionId);
    }
    await deliverToolResultToBackend(
      conversationId,
      toolCallId,
      decision.result,
      decision.approved,
      blockId,
    );
    pending.resolve(decision);
  } finally {
    approvingToolCallIds.delete(toolCallId);
  }
}

/** 确认卡回车：同意当前会话待审批的内联终端工具。 */
export function tryApprovePendingShellAgentEnter(sessionId: string): boolean {
  for (const [toolCallId, pending] of pendingByToolCallId.entries()) {
    if (pending.sessionId !== sessionId) continue;
    if (approvingToolCallIds.has(toolCallId)) return true;
    void approveInlineTerminalTool(pending.blockId, toolCallId);
    return true;
  }
  return false;
}

export function rejectInlineTerminalTool(blockId: string, toolCallId: string): void {
  const pending = pendingByToolCallId.get(toolCallId);
  if (!pending || pending.blockId !== blockId) {
    if (dismissStaleInlineToolCall(blockId, toolCallId, "rejected", STALE_APPROVAL_RESULT)) {
      showToast(STALE_APPROVAL_RESULT);
    }
    return;
  }

  const result = "用户拒绝执行";
  useBlocksStore.getState().updateAiThreadItem(blockId, toolCallId, {
    status: "rejected",
    result,
  } as Partial<AiThreadToolCall>);

  // 先冻成「已拒绝」确认卡，避免 React 切到工具条矮卡
  notifyShellAgentRejected(pending.sessionId);

  pendingByToolCallId.delete(toolCallId);
  void deliverToolResultToBackend(pending.conversationId, toolCallId, result, false, blockId);
  pending.resolve({ approved: false, result });
}

export function newInlineToolCallId(): string {
  return createBlockId();
}

/**
 * 终端内联 AI 会话中的 `omni_ssh_exec`：走当前 Tab 的 PTY 执行并生成 shell 命令块，
 * 不再静默走 ssh_pool_exec（侧栏 / 非内联仍用模块 handler）。
 */
export async function dispatchInlineTerminalPendingTool(options: {
  conversationId: string;
  toolCallId: string;
  toolName: string;
  argsJson: string;
  blockId: string;
  sessionId: string;
}): Promise<void> {
  const command = parseCommandFromArgs(options.argsJson);
  const pane = findTerminalPane(options.sessionId);
  const resourceId = pane?.resourceId ?? LOCAL_TERMINAL_RESOURCE_ID;
  const riskLevel = assessRisk(command, resourceId);

  useBlocksStore.getState().updateAiThreadItem(options.blockId, options.toolCallId, {
    toolName: options.toolName,
    args: options.argsJson,
    command,
    status: "pending",
    riskLevel,
  } as Partial<AiThreadToolCall>);

  useTerminalUiStore.getState().setExpandedAiBlock(options.sessionId, options.blockId);

  await waitForInlineToolDecision(
    options.blockId,
    options.toolCallId,
    options.sessionId,
    command,
    options.conversationId,
  );
}

export function cancelInlineToolByActionId(actionId: string): void {
  for (const [toolCallId, pending] of pendingByToolCallId.entries()) {
    void actionId;
    cancelTerminalExecution(actionId);
    rejectInlineTerminalTool(pending.blockId, toolCallId);
  }
}
