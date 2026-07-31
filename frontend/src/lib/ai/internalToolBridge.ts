/**
 * UiDelegated 工具总分派（Harness 写入口之一，见 `lib/ai/harness/writeEntries.ts`）。
 * Plan / 子会话并行 / 模块工具均经此进入，禁止业务旁路写 orchestration store。
 */
import { commands } from "../../ipc/bindings";
import { executeTerminalCommandCore } from "../../modules/terminal/ai/mcpTools";
import { resolveTerminalApprovalMode } from "../../modules/terminal/terminalApprovalSettings";
import { shouldRequireTerminalApproval } from "../../modules/terminal/terminalApprovalPolicy";
import { useBlocksStore } from "../../stores/blocksStore";
import { findTerminalPane } from "../../stores/terminalStore";
import { getResolvedAiThread } from "../../modules/terminal/aiThreadBridge";
import {
  createInlineTerminalToolCall,
  waitForInlineToolDecision,
} from "../../modules/terminal/inlineToolBridge";
import { LOCAL_TERMINAL_RESOURCE_ID } from "../../modules/terminal/paneResource";
import { useTerminalUiStore } from "../../modules/terminal/terminalUiStore";
import { checkCommand, type DangerLevel } from "../../lib/commandGuard";
import { getResourceById } from "../../lib/resourceRegistry";
import { useActionDraftStore } from "../../stores/actionDraftStore";
import { errorToString } from "../errorToString";
import { reportToolResultWithRetry } from "./reportToolResult";
import { getToolHandler } from "./toolHost";

const TERMINAL_TOOL = "omni_terminal_run_terminal_command";
const SPAWN_SUB_CONVERSATIONS_TOOL = "omni_spawn_sub_conversations";
/** SSH 体检工具：已迁移到 sub-conv 模型，在 dispatchPendingTool 拦截后委托 subConversationRunner */
const SSH_FLEET_HEALTH_TOOL = "omni_orchestration_ssh_fleet_health";
/** Plan 工具（todolist 范式）：在 dispatchPendingTool 拦截后委托 planToolDispatcher */
const PLAN_TOOLS = new Set([
  "omni_plan_create",
  "omni_plan_add_step",
  "omni_plan_update_step",
]);

/** 结构化澄清表单 */
const ASK_USER_TOOL = "omni_ask_user";

/** 模型未按 schema 填 command 时回传的可操作提示（引导其重试而非误报“用户拒绝”）。 */
const MISSING_COMMAND_HINT =
  '工具调用缺少必填参数 command。请在 arguments 中提供 JSON，例如 {"command":"date"}，然后重试。';

const inFlightToolCalls = new Set<string>();

function parseCommand(argsJson: string): string {
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

function toolCallKey(conversationId: string, toolCallId: string): string {
  return `${conversationId}:${toolCallId}`;
}

/** Internal AI 路径：终端 inline 块 pending → 审批后回传 ai_chat_tool_result。 */
export async function handleInternalPendingTerminalTool(options: {
  conversationId: string;
  toolCallId: string;
  toolName: string;
  argsJson: string;
  blockId: string;
  sessionId: string;
}): Promise<void> {
  if (options.toolName !== TERMINAL_TOOL) return;

  const key = toolCallKey(options.conversationId, options.toolCallId);
  if (inFlightToolCalls.has(key)) return;
  inFlightToolCalls.add(key);

  try {
    const block = useBlocksStore.getState().findBlockById(options.blockId);
    const command = parseCommand(options.argsJson);
    const pane = findTerminalPane(options.sessionId);
    const resourceId = pane?.resourceId ?? LOCAL_TERMINAL_RESOURCE_ID;
    const exists =
      block &&
      getResolvedAiThread(block).some(
        (item) => item.kind === "tool_call" && item.id === options.toolCallId,
      );

    // 模型未提供 command：不进入审批流程，直接以“执行失败”回传可操作提示，
    // 避免误标为“用户拒绝执行”（宽松模式下用户根本没被询问）。
    if (!command) {
      if (exists) {
        useBlocksStore.getState().updateAiThreadItem(options.blockId, options.toolCallId, {
          status: "failed",
          result: MISSING_COMMAND_HINT,
        });
      } else {
        createInlineTerminalToolCall(
          options.blockId,
          options.sessionId,
          options.toolCallId,
          options.toolName,
          options.argsJson,
        );
        useBlocksStore.getState().updateAiThreadItem(options.blockId, options.toolCallId, {
          status: "failed",
          result: MISSING_COMMAND_HINT,
        });
      }
      await reportToolResultWithRetry(
        options.conversationId,
        options.toolCallId,
        MISSING_COMMAND_HINT,
        false,
      );
      return;
    }

    if (!exists) {
      createInlineTerminalToolCall(
        options.blockId,
        options.sessionId,
        options.toolCallId,
        options.toolName,
        options.argsJson,
      );
    } else {
      const resource = getResourceById(resourceId);
      const environment = resource?.environment ?? "unknown";
      const riskCheck = checkCommand(command, environment);
      const envRisk: DangerLevel =
        environment === "prod" ? "high" : environment === "staging" ? "medium" : "low";
      const order: DangerLevel[] = ["low", "medium", "high", "critical"];
      const riskLevel =
        order.indexOf(riskCheck.level) >= order.indexOf(envRisk)
          ? riskCheck.level
          : envRisk;

      useBlocksStore.getState().updateAiThreadItem(options.blockId, options.toolCallId, {
        status: "pending",
        command,
        riskLevel,
      });
      useTerminalUiStore.getState().setExpandedAiBlock(options.sessionId, options.blockId);
    }

    // 跟随在工具 completed 时触发（见 AiRuntimeProvider.updateToolCall），不在 pending 时切面板

    await waitForInlineToolDecision(
      options.blockId,
      options.toolCallId,
      options.sessionId,
      parseCommand(options.argsJson),
      options.conversationId,
    );
    // approveInlineTerminalTool 已在 resolve 前 await 回传；此处不再重复 aiChatToolResult。
  } finally {
    inFlightToolCalls.delete(key);
  }
}

/** 侧栏 AI：终端工具 pending → 在活动终端执行并回传结果。 */
export async function handleAssistantPendingTerminalTool(options: {
  conversationId: string;
  toolCallId: string;
  argsJson: string;
  terminalSessionId?: string | null;
}): Promise<void> {
  const key = toolCallKey(options.conversationId, options.toolCallId);
  if (inFlightToolCalls.has(key)) return;
  inFlightToolCalls.add(key);

  const command = parseCommand(options.argsJson);
  const boundSessionId = options.terminalSessionId?.trim() || null;
  const tabId = boundSessionId;

  try {
    if (!command) {
      await commands.aiChatToolResult(
        options.conversationId,
        options.toolCallId,
        MISSING_COMMAND_HINT,
        false,
      );
      return;
    }

    if (!tabId) {
      await commands.aiChatToolResult(
        options.conversationId,
        options.toolCallId,
        "未绑定终端会话，无法执行命令。请在终端上下文中发起请求。",
        false,
      );
      return;
    }

    const pane = findTerminalPane(tabId);
    if (!pane) {
      await commands.aiChatToolResult(
        options.conversationId,
        options.toolCallId,
        `终端会话 ${tabId} 不存在或已关闭`,
        false,
      );
      return;
    }

    const mode = resolveTerminalApprovalMode(tabId);
    // 跟随在工具 completed 时触发（见 AiRuntimeProvider.updateToolCall），不在 pending 时切面板
    if (
      shouldRequireTerminalApproval(command, mode, {
        conversationId: options.conversationId,
        terminalSessionId: tabId,
      })
    ) {
      const resource = getResourceById(pane.resourceId ?? null);
      const environment = resource?.environment ?? "unknown";
      const riskCheck = checkCommand(command, environment);
      try {
        await useActionDraftStore.getState().enqueueAwaitable({
          kind: "terminal",
          // 侧栏发起：走统一队列的 AI 内嵌条/全局弹窗，勿标成会与「终端 dock」混淆的路径
          source: "toolgate",
          title: "AI 终端命令",
          preview: command,
          risk: riskCheck.level,
          riskCheck,
          environment,
          toolName: TERMINAL_TOOL,
          resourceId: resource?.id ?? pane.resourceId,
          conversationId: options.conversationId,
          target: {
            module: "terminal",
            sessionId: tabId,
            resourceId: resource?.id ?? pane.resourceId,
            conversationId: options.conversationId,
          },
          execute: async () => "approved",
        });
      } catch {
        await commands.aiChatToolResult(
          options.conversationId,
          options.toolCallId,
          "用户拒绝执行",
          false,
        );
        return;
      }
    }

    const coreResult = await executeTerminalCommandCore({
      command,
      session_id: tabId,
    });

    await commands.aiChatToolResult(
      options.conversationId,
      options.toolCallId,
      coreResult.outputJson,
      !coreResult.rejected,
    );
  } catch (err) {
    const message = errorToString(err);
    await commands.aiChatToolResult(
      options.conversationId,
      options.toolCallId,
      message,
      false,
    ).catch(() => {});
  } finally {
    inFlightToolCalls.delete(key);
  }
}

export function isInternalTerminalTool(name: string): boolean {
  return name === TERMINAL_TOOL;
}

/** 非终端 UiDelegated 工具（数据库等）：调用已注册 handler 并回传结果。 */
async function handleModulePendingTool(options: {
  conversationId: string;
  toolCallId: string;
  toolName: string;
  argsJson: string;
}): Promise<void> {
  const key = toolCallKey(options.conversationId, options.toolCallId);
  if (inFlightToolCalls.has(key)) return;
  inFlightToolCalls.add(key);

  try {
    const handler = getToolHandler(options.toolName);
    if (!handler) {
      await commands.aiChatToolResult(
        options.conversationId,
        options.toolCallId,
        `未注册的工具 handler: ${options.toolName}`,
        false,
      );
      return;
    }

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(options.argsJson || "{}") as Record<string, unknown>;
    } catch {
      // 参数解析失败时按空对象处理，交由 handler 校验。
    }

    // 跟随在工具 completed 时触发（见 AiRuntimeProvider.updateToolCall），不在 pending 时切面板

    const output = await handler(args as never);
    const result = typeof output === "string" ? output : JSON.stringify(output, null, 2);
    const success = !result.toLowerCase().startsWith("error");
    await commands.aiChatToolResult(
      options.conversationId,
      options.toolCallId,
      result,
      success,
    );
  } catch (err) {
    const message = errorToString(err);
    await commands
      .aiChatToolResult(options.conversationId, options.toolCallId, message, false)
      .catch(() => {});
  } finally {
    inFlightToolCalls.delete(key);
  }
}

/**
 * 统一工具分派入口：后端把所有 UiDelegated 工具挂起后，前端据工具名分派。
 * - 终端命令：内联走审批 dock，侧栏走执行桥；
 * - 子会话集群（omni_spawn_sub_conversations）：走 subConversationRunner，并发执行子会话；
 * - SSH 体检（omni_orchestration_ssh_fleet_health）：已迁移到 sub-conv 模型，走 subConversationRunner；
 * - Plan 工具（omni_plan_create/add_step/update_step）：走 planToolDispatcher，更新 todolist；
 * - 其它模块（数据库等）：调用注册的 handler 直接执行。
 * 全部通过 `ai_chat_tool_result` 回传结果。
 */
export async function dispatchPendingTool(options: {
  conversationId: string;
  toolCallId: string;
  toolName: string;
  argsJson: string;
  inline?: { blockId: string; sessionId: string } | null;
  terminalSessionId?: string | null;
}): Promise<void> {
  // 子会话集群工具：动态 import 避免循环依赖（subConversationRunner 反向依赖 dispatchPendingTool）
  if (options.toolName === SPAWN_SUB_CONVERSATIONS_TOOL) {
    const { dispatchSpawnSubConversations } = await import(
      "./orchestration/subConversationRunner"
    );
    return dispatchSpawnSubConversations({
      conversationId: options.conversationId,
      toolCallId: options.toolCallId,
      argsJson: options.argsJson,
    });
  }

  // SSH 体检工具：已迁移到 sub-conv 模型，与 omni_spawn_sub_conversations 走同一通道
  if (options.toolName === SSH_FLEET_HEALTH_TOOL) {
    const { dispatchSshFleetHealthAsSubConv } = await import(
      "./orchestration/subConversationRunner"
    );
    return dispatchSshFleetHealthAsSubConv({
      conversationId: options.conversationId,
      toolCallId: options.toolCallId,
      argsJson: options.argsJson,
    });
  }

  // Plan 工具（todolist）：动态 import 避免循环依赖
  if (PLAN_TOOLS.has(options.toolName)) {
    const { dispatchPlanTool } = await import("./orchestration/planToolDispatcher");
    return dispatchPlanTool({
      conversationId: options.conversationId,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      argsJson: options.argsJson,
      inline: options.inline ?? null,
    });
  }

  // 结构化澄清表单：写 part 后等人提交，不立即回传
  if (options.toolName === ASK_USER_TOOL) {
    const { dispatchAskUserTool } = await import("./orchestration/askUserToolDispatcher");
    return dispatchAskUserTool({
      conversationId: options.conversationId,
      toolCallId: options.toolCallId,
      argsJson: options.argsJson,
    });
  }

  if (isInternalTerminalTool(options.toolName)) {
    if (options.inline) {
      return handleInternalPendingTerminalTool({
        conversationId: options.conversationId,
        toolCallId: options.toolCallId,
        toolName: options.toolName,
        argsJson: options.argsJson,
        blockId: options.inline.blockId,
        sessionId: options.inline.sessionId,
      });
    }
    return handleAssistantPendingTerminalTool({
      conversationId: options.conversationId,
      toolCallId: options.toolCallId,
      argsJson: options.argsJson,
      terminalSessionId: options.terminalSessionId,
    });
  }

  return handleModulePendingTool({
    conversationId: options.conversationId,
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    argsJson: options.argsJson,
  });
}
