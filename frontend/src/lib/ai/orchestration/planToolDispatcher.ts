/**
 * Plan 工具 dispatcher（todolist 范式）。
 *
 * 拦截 3 个 UiDelegated plan 工具调用：
 * - omni_plan_create：创建计划，写入 message parts + orchestration store
 * - omni_plan_add_step：向已有计划追加步骤
 * - omni_plan_update_step：更新步骤状态（pending → in_progress → completed/failed/skipped）
 *
 * 数据流：
 * 1. AI 调用 plan 工具 → 后端挂起 → dispatchPendingTool 拦截 → 委托本 dispatcher
 * 2. dispatcher 更新 orchestration store.plans
 * 3. 侧栏：写入 aiStore.conversations[].messages[].parts
 *    终端内联：写入 blocksStore.aiThread message.parts
 * 4. 回传 tool result；UI（PlanView / 吸顶）订阅 plans + message parts
 */
import { useAiStore } from "../../../stores/aiStore";
import { useAiOrchestrationStore } from "../../../stores/aiOrchestrationStore";
import {
  isAiThreadMessage,
  useBlocksStore,
  type TerminalBlock,
} from "../../../stores/blocksStore";
import { reportToolResultWithRetry } from "../reportToolResult";
import type { PlanData, PlanStep, PlanStepStatus } from "../aiMessageParts";

export type PlanInlineTarget = {
  blockId: string;
  sessionId: string;
};

export type PlanDispatchOptions = {
  conversationId: string;
  toolCallId: string;
  argsJson: string;
  inline?: PlanInlineTarget | null;
};

/** plan id 前缀 + 自增序号 */
let planSeq = 0;
function genPlanId(): string {
  return `plan_${Date.now()}_${(++planSeq).toString(36)}`;
}

/** step id 前缀 + 自增序号 */
let stepSeq = 0;
function genStepId(): string {
  return `step_${Date.now()}_${(++stepSeq).toString(36)}`;
}

function getInlineThread(blockId: string) {
  const block = useBlocksStore.getState().findBlockById(blockId);
  if (!block || block.kind !== "ai") return null as TerminalBlock | null;
  return block;
}

/** 找到包含 toolCallId 的父消息（streaming assistant message） */
function findParentMessage(conversationId: string, toolCallId: string) {
  const conv = useAiStore.getState().conversations.find((c) => c.id === conversationId);
  if (!conv) return null;
  const msg = conv.messages.find(
    (m) =>
      Array.isArray(m.parts) &&
      m.parts.some((p) => p.type === "tool-call" && p.id === toolCallId),
  );
  if (!msg) return null;
  return { conv, msg };
}

/** 终端 AI 块：找到携带该 toolCallId 的 assistant message */
function findInlineParentMessageId(blockId: string, toolCallId: string): string | null {
  const block = getInlineThread(blockId);
  if (!block) return null;
  const thread = block.aiThread ?? [];
  for (const item of thread) {
    if (!isAiThreadMessage(item) || item.role !== "assistant") continue;
    if (item.parts?.some((p) => p.type === "tool-call" && p.id === toolCallId)) {
      return item.id;
    }
  }
  let lastAssistantId: string | null = null;
  for (const item of thread) {
    if (isAiThreadMessage(item) && item.role === "assistant") {
      lastAssistantId = item.id;
      continue;
    }
    if (item.kind === "tool_call" && item.id === toolCallId) {
      return lastAssistantId;
    }
  }
  return lastAssistantId;
}

/** 终端 AI 块：找到已挂载该 planId 的 assistant message */
function findInlineMessageIdWithPlan(blockId: string, planId: string): string | null {
  const block = getInlineThread(blockId);
  if (!block) return null;
  for (const item of block.aiThread ?? []) {
    if (!isAiThreadMessage(item) || item.role !== "assistant") continue;
    if (item.parts?.some((p) => p.type === "plan" && p.plan.id === planId)) {
      return item.id;
    }
  }
  return null;
}

function persistPlanPart(
  options: Pick<PlanDispatchOptions, "conversationId" | "toolCallId" | "inline">,
  plan: PlanData,
  createHost?: { aiMessageId?: string | null; inlineMessageId?: string | null },
): boolean {
  let wrote = false;

  const aiMessageId =
    createHost?.aiMessageId ??
    (() => {
      const parent = findParentMessage(options.conversationId, options.toolCallId);
      return parent?.msg.id ?? null;
    })();
  if (aiMessageId) {
    useAiStore.getState().upsertStreamPlan(options.conversationId, aiMessageId, plan);
    wrote = true;
  } else {
    // 非 create：按 planId 扫会话消息
    const conv = useAiStore
      .getState()
      .conversations.find((c) => c.id === options.conversationId);
    if (conv) {
      for (const msg of conv.messages) {
        if (msg.parts?.some((p) => p.type === "plan" && p.plan.id === plan.id)) {
          useAiStore.getState().upsertStreamPlan(options.conversationId, msg.id, plan);
          wrote = true;
          break;
        }
      }
    }
  }

  if (options.inline) {
    const inlineMessageId =
      createHost?.inlineMessageId ??
      findInlineMessageIdWithPlan(options.inline.blockId, plan.id) ??
      findInlineParentMessageId(options.inline.blockId, options.toolCallId);
    if (inlineMessageId) {
      useBlocksStore
        .getState()
        .upsertAiThreadPlanPart(options.inline.blockId, inlineMessageId, plan);
      wrote = true;
    }
  }

  return wrote;
}

/**
 * 解析 JSON 参数，失败时回传错误并返回 null。
 */
function parseArgs<T>(argsJson: string): T | null {
  try {
    return JSON.parse(argsJson || "{}") as T;
  } catch {
    return null;
  }
}

/**
 * omni_plan_create dispatcher。
 *
 * 入参：{ title: string, steps: [{ title, tool_name? }] }
 * 行为：创建 PlanData，写入 message parts + orchestration store
 * 回传：{ ok: true, plan_id: string }
 */
export async function dispatchPlanCreate(options: PlanDispatchOptions): Promise<void> {
  const { conversationId, toolCallId, argsJson } = options;

  const args = parseArgs<{
    title?: unknown;
    steps?: unknown;
  }>(argsJson);

  if (!args) {
    await reportToolResultWithRetry(conversationId, toolCallId, "参数解析失败：无效 JSON", false);
    return;
  }

  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      "参数解析失败：title 必须是非空字符串",
      false,
    );
    return;
  }

  if (!Array.isArray(args.steps) || args.steps.length === 0) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      "参数解析失败：steps 必须是非空数组",
      false,
    );
    return;
  }
  if (args.steps.length > 30) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      "参数解析失败：steps 最多 30 个",
      false,
    );
    return;
  }

  const steps: PlanStep[] = [];
  for (let i = 0; i < args.steps.length; i++) {
    const raw = args.steps[i] as unknown;
    if (!raw || typeof raw !== "object") {
      await reportToolResultWithRetry(
        conversationId,
        toolCallId,
        `参数解析失败：steps[${i}] 必须是对象`,
        false,
      );
      return;
    }
    const obj = raw as Record<string, unknown>;
    const stepTitle = typeof obj.title === "string" ? obj.title.trim() : "";
    if (!stepTitle) {
      await reportToolResultWithRetry(
        conversationId,
        toolCallId,
        `参数解析失败：steps[${i}].title 必须是非空字符串`,
        false,
      );
      return;
    }
    const toolName =
      typeof obj.tool_name === "string" && obj.tool_name.trim()
        ? obj.tool_name.trim()
        : undefined;
    steps.push({
      id: genStepId(),
      title: stepTitle,
      status: "pending",
      ...(toolName ? { toolName } : {}),
    });
  }

  const aiParent = findParentMessage(conversationId, toolCallId);
  const inlineMessageId = options.inline
    ? findInlineParentMessageId(options.inline.blockId, toolCallId)
    : null;

  if (!aiParent && !inlineMessageId) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      `找不到包含 toolCallId ${toolCallId} 的父消息`,
      false,
    );
    return;
  }

  const now = Date.now();
  const plan: PlanData = {
    id: genPlanId(),
    title,
    steps,
    status: "executing",
    createdAt: now,
    updatedAt: now,
  };

  useAiOrchestrationStore.getState().createPlan(plan);
  persistPlanPart(options, plan, {
    aiMessageId: aiParent?.msg.id ?? null,
    inlineMessageId,
  });

  await reportToolResultWithRetry(
    conversationId,
    toolCallId,
    JSON.stringify({
      ok: true,
      plan_id: plan.id,
      step_count: steps.length,
      steps: steps.map((s, i) => ({ index: i, step_id: s.id, title: s.title })),
    }),
    true,
  );
}

/**
 * omni_plan_add_step dispatcher。
 */
export async function dispatchPlanAddStep(options: PlanDispatchOptions): Promise<void> {
  const { conversationId, toolCallId, argsJson } = options;

  const args = parseArgs<{
    plan_id?: unknown;
    title?: unknown;
    tool_name?: unknown;
    after_step_id?: unknown;
  }>(argsJson);

  if (!args) {
    await reportToolResultWithRetry(conversationId, toolCallId, "参数解析失败：无效 JSON", false);
    return;
  }

  const planId = typeof args.plan_id === "string" ? args.plan_id.trim() : "";
  if (!planId) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      "参数解析失败：plan_id 必须是非空字符串",
      false,
    );
    return;
  }

  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      "参数解析失败：title 必须是非空字符串",
      false,
    );
    return;
  }

  const toolName =
    typeof args.tool_name === "string" && args.tool_name.trim()
      ? args.tool_name.trim()
      : undefined;
  const afterStepId =
    typeof args.after_step_id === "string" && args.after_step_id.trim()
      ? args.after_step_id.trim()
      : undefined;

  const plan = useAiOrchestrationStore.getState().plans[planId];
  if (!plan) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      `计划不存在: ${planId}`,
      false,
    );
    return;
  }

  const step: PlanStep = {
    id: genStepId(),
    title,
    status: "pending",
    ...(toolName ? { toolName } : {}),
  };

  useAiOrchestrationStore.getState().addPlanStep(planId, step, afterStepId);

  const updatedPlan = useAiOrchestrationStore.getState().plans[planId];
  if (updatedPlan) {
    persistPlanPart(options, updatedPlan);
  }

  await reportToolResultWithRetry(
    conversationId,
    toolCallId,
    JSON.stringify({ ok: true, step_id: step.id, plan_id: planId }),
    true,
  );
}

/**
 * omni_plan_update_step dispatcher。
 */
export async function dispatchPlanUpdateStep(options: PlanDispatchOptions): Promise<void> {
  const { conversationId, toolCallId, argsJson } = options;

  const args = parseArgs<{
    plan_id?: unknown;
    step_id?: unknown;
    status?: unknown;
    summary?: unknown;
    error?: unknown;
  }>(argsJson);

  if (!args) {
    await reportToolResultWithRetry(conversationId, toolCallId, "参数解析失败：无效 JSON", false);
    return;
  }

  const planId = typeof args.plan_id === "string" ? args.plan_id.trim() : "";
  if (!planId) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      "参数解析失败：plan_id 必须是非空字符串",
      false,
    );
    return;
  }

  const stepId = typeof args.step_id === "string" ? args.step_id.trim() : "";
  if (!stepId) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      "参数解析失败：step_id 必须是非空字符串",
      false,
    );
    return;
  }

  const validStatuses: PlanStepStatus[] = [
    "pending",
    "in_progress",
    "completed",
    "failed",
    "skipped",
  ];
  const status = typeof args.status === "string" ? args.status.trim() : "";
  if (!validStatuses.includes(status as PlanStepStatus)) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      `参数解析失败：status 必须是 ${validStatuses.join("/")} 之一`,
      false,
    );
    return;
  }

  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : undefined;
  const error =
    typeof args.error === "string" && args.error.trim() ? args.error.trim() : undefined;

  const plan = useAiOrchestrationStore.getState().plans[planId];
  if (!plan) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      `计划不存在: ${planId}`,
      false,
    );
    return;
  }

  const stepExists = plan.steps.some((s) => s.id === stepId);
  if (!stepExists) {
    const validIds = plan.steps.map((s) => s.id).join(", ");
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      `步骤不存在: ${stepId}。请使用 omni_plan_create 返回的 step_id。有效 step_id: ${validIds}`,
      false,
    );
    return;
  }

  useAiOrchestrationStore.getState().syncStepFromToolCall(
    planId,
    stepId,
    status as PlanStepStatus,
    summary,
    error,
  );

  const updatedPlan = useAiOrchestrationStore.getState().plans[planId];
  if (updatedPlan) {
    persistPlanPart(options, updatedPlan);
  }

  await reportToolResultWithRetry(
    conversationId,
    toolCallId,
    JSON.stringify({ ok: true, plan_id: planId, step_id: stepId, status }),
    true,
  );
}

/** 判断是否是 plan 工具 */
export function isPlanTool(toolName: string): boolean {
  return (
    toolName === "omni_plan_create" ||
    toolName === "omni_plan_add_step" ||
    toolName === "omni_plan_update_step"
  );
}

/** 统一入口：根据工具名分派到对应的 plan dispatcher */
export async function dispatchPlanTool(options: {
  conversationId: string;
  toolCallId: string;
  toolName: string;
  argsJson: string;
  inline?: PlanInlineTarget | null;
}): Promise<void> {
  const dispatchOptions: PlanDispatchOptions = {
    conversationId: options.conversationId,
    toolCallId: options.toolCallId,
    argsJson: options.argsJson,
    inline: options.inline,
  };
  switch (options.toolName) {
    case "omni_plan_create":
      return dispatchPlanCreate(dispatchOptions);
    case "omni_plan_add_step":
      return dispatchPlanAddStep(dispatchOptions);
    case "omni_plan_update_step":
      return dispatchPlanUpdateStep(dispatchOptions);
    default:
      await reportToolResultWithRetry(
        options.conversationId,
        options.toolCallId,
        `未知的 plan 工具: ${options.toolName}`,
        false,
      );
  }
}
