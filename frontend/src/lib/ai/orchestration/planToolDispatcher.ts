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
 * 2. dispatcher 更新 aiStore.conversations[].messages[].parts（plan part）+ aiOrchestrationStore.plans
 * 3. 回传 tool result 给后端（reportToolResultWithRetry）
 * 4. thread.tsx 中的 PlanStickyHeader + 对话流内 PlanView 订阅 plans 渲染（吸顶模式）
 *
 * 与子会话集群的区别：
 * - Plan 是单会话内的 todolist（步骤列表），不创建子会话
 * - Cluster 是多会话的 sub-agent（每台主机一个独立 AI 对话）
 * - Plan 步骤关联工具调用（toolCallId），但不阻塞等待工具完成
 */
import { useAiStore } from "../../../stores/aiStore";
import { useAiOrchestrationStore } from "../../../stores/aiOrchestrationStore";
import { reportToolResultWithRetry } from "../reportToolResult";
import type { PlanData, PlanStep, PlanStepStatus } from "../aiMessageParts";

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
export async function dispatchPlanCreate(options: {
  conversationId: string;
  toolCallId: string;
  argsJson: string;
}): Promise<void> {
  const { conversationId, toolCallId, argsJson } = options;

  const args = parseArgs<{
    title?: unknown;
    steps?: unknown;
  }>(argsJson);

  if (!args) {
    await reportToolResultWithRetry(conversationId, toolCallId, "参数解析失败：无效 JSON", false);
    return;
  }

  // 校验 title
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

  // 校验 steps
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

  // 找到父消息
  const parent = findParentMessage(conversationId, toolCallId);
  if (!parent) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      `找不到包含 toolCallId ${toolCallId} 的父消息`,
      false,
    );
    return;
  }

  // 创建 PlanData
  const now = Date.now();
  const plan: PlanData = {
    id: genPlanId(),
    title,
    steps,
    status: "executing",
    createdAt: now,
    updatedAt: now,
  };

  // 写入 orchestration store
  useAiOrchestrationStore.getState().createPlan(plan);

  // 写入 message parts（plan part）
  useAiStore.getState().upsertStreamPlan(conversationId, parent.msg.id, plan);

  // 回传结果：必须返回每个 step 的 id，否则 AI 调用 omni_plan_update_step 时
  // 无法传入正确的 step_id，导致状态更新静默失败（step 不匹配）。
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
 *
 * 入参：{ plan_id: string, title: string, tool_name?: string, after_step_id?: string }
 * 行为：向已有 plan 追加步骤
 * 回传：{ ok: true, step_id: string }
 */
export async function dispatchPlanAddStep(options: {
  conversationId: string;
  toolCallId: string;
  argsJson: string;
}): Promise<void> {
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

  // 检查 plan 是否存在
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

  // 创建新步骤
  const step: PlanStep = {
    id: genStepId(),
    title,
    status: "pending",
    ...(toolName ? { toolName } : {}),
  };

  // 更新 orchestration store
  useAiOrchestrationStore.getState().addPlanStep(planId, step, afterStepId);

  // 更新 message parts（找到包含该 plan 的消息）
  const conv = useAiStore.getState().conversations.find((c) => c.id === conversationId);
  if (conv) {
    for (const msg of conv.messages) {
      const parts = msg.parts ?? [];
      if (parts.some((p) => p.type === "plan" && p.plan.id === planId)) {
        // orchestration store 已更新，用最新 plan 数据 upsert message parts
        const updatedPlan = useAiOrchestrationStore.getState().plans[planId];
        if (updatedPlan) {
          useAiStore.getState().upsertStreamPlan(conversationId, msg.id, updatedPlan);
        }
        break;
      }
    }
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
 *
 * 入参：{ plan_id: string, step_id: string, status: string, summary?: string, error?: string }
 * 行为：更新步骤状态，自动推断 plan 整体状态
 * 回传：{ ok: true }
 */
export async function dispatchPlanUpdateStep(options: {
  conversationId: string;
  toolCallId: string;
  argsJson: string;
}): Promise<void> {
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

  // 检查 plan 是否存在
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

  // 检查 step 是否存在（防止 AI 编造 step_id 导致静默失败）
  const stepExists = plan.steps.some((s) => s.id === stepId);
  if (!stepExists) {
    // 列出所有有效 step_id 帮助 AI 自纠正
    const validIds = plan.steps.map((s) => s.id).join(", ");
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      `步骤不存在: ${stepId}。请使用 omni_plan_create 返回的 step_id。有效 step_id: ${validIds}`,
      false,
    );
    return;
  }

  // 更新 orchestration store（syncStepFromToolCall 会自动推断 plan 整体状态）
  useAiOrchestrationStore.getState().syncStepFromToolCall(
    planId,
    stepId,
    status as PlanStepStatus,
    summary,
    error,
  );

  // 更新 message parts
  const updatedPlan = useAiOrchestrationStore.getState().plans[planId];
  if (updatedPlan) {
    const conv = useAiStore.getState().conversations.find((c) => c.id === conversationId);
    if (conv) {
      for (const msg of conv.messages) {
        const parts = msg.parts ?? [];
        if (parts.some((p) => p.type === "plan" && p.plan.id === planId)) {
          useAiStore.getState().upsertStreamPlan(conversationId, msg.id, updatedPlan);
          break;
        }
      }
    }
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
}): Promise<void> {
  switch (options.toolName) {
    case "omni_plan_create":
      return dispatchPlanCreate(options);
    case "omni_plan_add_step":
      return dispatchPlanAddStep(options);
    case "omni_plan_update_step":
      return dispatchPlanUpdateStep(options);
    default:
      await reportToolResultWithRetry(
        options.conversationId,
        options.toolCallId,
        `未知的 plan 工具: ${options.toolName}`,
        false,
      );
  }
}
