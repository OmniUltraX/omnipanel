/**
 * UiDelegated 工具总分派（Harness 写入口之一，见 `lib/ai/harness/writeEntries.ts`）。
 * Plan / 子会话并行 / 模块工具均经此进入，禁止业务旁路写 orchestration store。
 */
import { findTerminalPane } from "../../stores/terminalStore";
import { LOCAL_TERMINAL_RESOURCE_ID } from "../../modules/terminal/paneResource";
import { errorToString } from "../errorToString";
import { getToolHandler, SSH_EXEC_TOOL_NAME } from "./toolHost";
import { reportToolResultWithRetry } from "./reportToolResult";
import { runWithToolGate } from "./toolGate";

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

const inFlightToolCalls = new Set<string>();

function toolCallKey(conversationId: string, toolCallId: string): string {
  return `${conversationId}:${toolCallId}`;
}

/**
 * ACP / 缺参场景：若未传 resource_id，尝试从绑定的终端会话注入 SSH 连接 id。
 * 本地终端（非 SSH）无法走 omni_ssh_exec，留给 handler 报错。
 */
function injectSshResourceIdIfNeeded(
  toolName: string,
  args: Record<string, unknown>,
  terminalSessionId?: string | null,
): void {
  if (toolName !== SSH_EXEC_TOOL_NAME && toolName !== "omni_ssh_create_run_script") {
    return;
  }
  const existing = args.resource_id;
  if (typeof existing === "string" && existing.trim()) return;

  const tabId = terminalSessionId?.trim();
  if (!tabId) return;
  const pane = findTerminalPane(tabId);
  const resourceId = pane?.resourceId?.trim();
  if (!resourceId || resourceId === LOCAL_TERMINAL_RESOURCE_ID) return;
  args.resource_id = resourceId;
}

/** 非终端 UiDelegated 工具（数据库 / SSH 等）：调用已注册 handler 并回传结果。
 * 各 handler 内部已自带 runWithToolGate 审批（sshExec / dockerAction / filesWrite 等），
 * 此处不再重复 gate，避免双重审批弹窗。 */
async function handleModulePendingTool(options: {
  conversationId: string;
  toolCallId: string;
  toolName: string;
  argsJson: string;
  terminalSessionId?: string | null;
}): Promise<void> {
  const key = toolCallKey(options.conversationId, options.toolCallId);
  if (inFlightToolCalls.has(key)) return;
  inFlightToolCalls.add(key);

  try {
    const handler = getToolHandler(options.toolName);
    if (!handler) {
      await reportToolResultWithRetry(
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

    injectSshResourceIdIfNeeded(options.toolName, args, options.terminalSessionId);

    // handler 内部自带 runWithToolGate（见各模块 mcpTools.ts），
    // 危险操作会在 handler 内部进入审批队列，用户确认后才真正执行。
    const output = await handler(args as never);

    const result = typeof output === "string" ? output : JSON.stringify(output, null, 2);
    const success = !result.toLowerCase().startsWith("error");
    await reportToolResultWithRetry(
      options.conversationId,
      options.toolCallId,
      result,
      success,
    );
  } catch (err) {
    // 🔴 任何错误（含 handler 内部 ToolGate 审批拒绝、审批超时、handler 执行异常）
    //    都必须用带重试的 reportToolResultWithRetry 明确回传给 AI；否则 AI 工具会
    //    挂起无响应（前端看起来是"不仅没确认，也没执行"）
    const message = errorToString(err);
    await reportToolResultWithRetry(
      options.conversationId,
      options.toolCallId,
      message,
      false,
    ).catch(() => {
      // eslint-disable-next-line no-console
      console.error(
        `[internalToolBridge] 工具结果回传失败 ${options.toolName} ${options.toolCallId}`,
        message,
      );
    });
  } finally {
    inFlightToolCalls.delete(key);
  }
}

/**
 * 统一工具分派入口：后端把所有 UiDelegated 工具挂起后，前端据工具名分派。
 * - 子会话集群（omni_spawn_sub_conversations）：走 subConversationRunner；
 * - SSH 体检（omni_orchestration_ssh_fleet_health）：走 subConversationRunner；
 * - Plan 工具（omni_plan_create/add_step/update_step）：走 planToolDispatcher；
 * - 终端内联 AI 的 omni_ssh_exec：走当前 Tab PTY + 命令块 / 审批条；
 * - 其它模块（含侧栏 omni_ssh_exec）：调用注册的 handler 直接执行。
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
    // 终端内嵌场景：从 block aiThread 反查最近一条 assistant 消息 id，作为父消息 fallback
    let assistantTurnId: string | null = null;
    if (options.inline?.blockId) {
      const block = await import("../../stores/blocksStore").then((m) =>
        m.useBlocksStore.getState().findBlockById(options.inline!.blockId),
      );
      const thread = block?.aiThread ?? [];
      for (let i = thread.length - 1; i >= 0; i -= 1) {
        const item = thread[i]!;
        if (item.kind === "message" && item.role === "assistant") {
          assistantTurnId = item.id;
          break;
        }
      }
    }
    return dispatchAskUserTool({
      conversationId: options.conversationId,
      toolCallId: options.toolCallId,
      argsJson: options.argsJson,
      inline: options.inline
        ? { blockId: options.inline.blockId, assistantTurnId }
        : null,
    });
  }

  // 终端内联会话：omni_ssh_exec 走当前 Tab PTY，生成可见命令块（含审批条）
  if (options.inline && options.toolName === SSH_EXEC_TOOL_NAME) {
    const { dispatchInlineTerminalPendingTool } = await import(
      "../../modules/terminal/inlineToolBridge"
    );
    return dispatchInlineTerminalPendingTool({
      conversationId: options.conversationId,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      argsJson: options.argsJson,
      blockId: options.inline.blockId,
      sessionId: options.inline.sessionId,
    });
  }

  const sessionFromInline = options.inline?.sessionId ?? null;
  return handleModulePendingTool({
    conversationId: options.conversationId,
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    argsJson: options.argsJson,
    terminalSessionId: options.terminalSessionId ?? sessionFromInline,
  });
}
