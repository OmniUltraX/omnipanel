import type { BuiltinToolRegistration } from "../context";
import { requireString, optionalString } from "../mcpToolArgs";
import { errorToString } from "../../errorToString";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useWorkspaceMembershipStore } from "../../../stores/workspaceMembershipStore";
import { useAiStore } from "../../../stores/aiStore";
import {
  genAiTaskId,
  genPlanId,
  useAiOrchestrationStore,
} from "../../../stores/aiOrchestrationStore";
import type { PlanData, PlanStep, PlanStepStatus } from "../aiMessageParts";
import { followAiIntent } from "../uiFollow";
import { useBackgroundTaskStore } from "../../../stores/backgroundTaskStore";
import { SSH_MODULE_TOOLS } from "../../../modules/server/ssh/ai/mcpTools";

const CONCURRENCY = 4;

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  shouldAbort: () => boolean,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      if (shouldAbort()) return;
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const n = Math.min(limit, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function resolveSshHosts(workspaceId: string | null): { id: string; name: string }[] {
  const all = useConnectionStore.getState().connections.filter((c) => c.kind === "ssh");
  if (!workspaceId) {
    return all.map((c) => ({ id: c.id, name: c.name }));
  }
  const members = new Set(
    useWorkspaceMembershipStore.getState().getWorkspaceResourceIds(workspaceId),
  );
  if (members.size === 0) {
    return all.map((c) => ({ id: c.id, name: c.name }));
  }
  return all.filter((c) => members.has(c.id)).map((c) => ({ id: c.id, name: c.name }));
}

async function fetchHostStats(connectionId: string): Promise<string> {
  const tool = SSH_MODULE_TOOLS.find((t) => t.name === "omni_ssh_get_stats");
  if (!tool) throw new Error("omni_ssh_get_stats 未注册");
  const out = await tool.handler({ resource_id: connectionId });
  return typeof out === "string" ? out : JSON.stringify(out);
}

async function sshFleetHealthCheck(args: Record<string, unknown>) {
  const pinned = useAiStore.getState().conversations.find(
    (c) => c.id === useAiStore.getState().activeConversationId,
  )?.pinnedWorkspaceId;
  const workspaceId = optionalString(args, "workspace_id") ?? pinned ?? null;
  const hosts = resolveSshHosts(workspaceId);
  if (hosts.length === 0) {
    return JSON.stringify({ ok: false, error: "未找到 SSH 主机" });
  }

  const parentId = genAiTaskId("ssh_health");
  const children = hosts.map((h) => ({
    id: `${parentId}_${h.id}`,
    title: h.name,
    status: "pending" as const,
    resourceId: h.id,
  }));

  useAiOrchestrationStore.getState().createTask({
    id: parentId,
    conversationId: useAiStore.getState().activeConversationId,
    title: workspaceId
      ? `SSH 体检（工作区）· ${hosts.length} 台`
      : `SSH 体检（全局）· ${hosts.length} 台`,
    kind: "sshFleetHealth",
    children,
  });

  const bg = useBackgroundTaskStore.getState();
  bg.upsertTask({
    id: parentId,
    module: "ai",
    kind: "aiOrchestration",
    title: `SSH 体检 · ${hosts.length} 台`,
    progress: `0 / ${hosts.length}`,
    status: "running",
    index: 0,
    total: hosts.length,
    startedAt: Date.now(),
  });
  bg.setTaskListOpen(true);

  let done = 0;
  let failed = 0;
  const reports: { host: string; id: string; ok: boolean; stats?: string; error?: string }[] =
    [];

  const aborted = () =>
    useAiOrchestrationStore.getState().tasks[parentId]?.status === "cancelled";

  await mapPool(
    hosts,
    CONCURRENCY,
    async (host) => {
      if (aborted()) return;
      useAiOrchestrationStore.getState().updateChild(parentId, `${parentId}_${host.id}`, {
        status: "running",
      });
      followAiIntent({ type: "openConnection", module: "ssh", resourceId: host.id });
      try {
        const stats = await fetchHostStats(host.id);
        reports.push({ host: host.name, id: host.id, ok: true, stats });
        useAiOrchestrationStore.getState().updateChild(parentId, `${parentId}_${host.id}`, {
          status: "completed",
          summary: "已采集资源占用",
        });
      } catch (e) {
        failed += 1;
        const message = errorToString(e);
        reports.push({ host: host.name, id: host.id, ok: false, error: message });
        useAiOrchestrationStore.getState().updateChild(parentId, `${parentId}_${host.id}`, {
          status: "failed",
          error: message,
        });
      } finally {
        done += 1;
        useBackgroundTaskStore.getState().upsertTask({
          id: parentId,
          module: "ai",
          kind: "aiOrchestration",
          title: `SSH 体检 · ${hosts.length} 台`,
          progress: `${done} / ${hosts.length}`,
          status: done >= hosts.length ? "completed" : "running",
          index: done,
          total: hosts.length,
          startedAt:
            useAiOrchestrationStore.getState().tasks[parentId]?.startedAt ?? Date.now(),
          finishedAt: done >= hosts.length ? Date.now() : null,
          error: failed > 0 ? `${failed} 台失败` : null,
        });
      }
    },
    aborted,
  );

  if (aborted()) {
    useAiOrchestrationStore.getState().setParentStatus(parentId, "cancelled");
    return JSON.stringify({ ok: false, cancelled: true, taskId: parentId });
  }

  const summary = {
    ok: true,
    taskId: parentId,
    scope: workspaceId ? "workspace" : "global",
    workspaceId,
    total: hosts.length,
    failed,
    reports,
    hint: "请根据各主机 stats 给出资源占用概览与优化建议；高负载主机优先。",
  };
  useAiOrchestrationStore
    .getState()
    .setParentStatus(
      parentId,
      failed === hosts.length ? "failed" : "completed",
      `失败 ${failed}/${hosts.length}`,
    );
  return JSON.stringify(summary, null, 2);
}

// === Plan 工具 ===

const VALID_STEP_STATUSES: PlanStepStatus[] = [
  "in_progress",
  "completed",
  "failed",
  "skipped",
];

function parseStepStatus(value: unknown): PlanStepStatus {
  if (typeof value === "string" && VALID_STEP_STATUSES.includes(value as PlanStepStatus)) {
    return value as PlanStepStatus;
  }
  throw new Error(
    `参数 status 必须是以下值之一：${VALID_STEP_STATUSES.join(", ")}`,
  );
}

/** omni_plan_create：AI 创建多步骤任务计划 */
async function planCreate(args: Record<string, unknown>): Promise<string> {
  const title = requireString(args, "title");
  const stepsRaw = Array.isArray(args.steps) ? args.steps : [];
  const planId = genPlanId();
  const now = Date.now();

  const steps: PlanStep[] = stepsRaw.map((s, i) => {
    if (typeof s !== "object" || s === null) {
      throw new Error(`steps[${i}] 必须是对象`);
    }
    const obj = s as Record<string, unknown>;
    const stepId =
      typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : `step_${i + 1}`;
    const stepTitle =
      typeof obj.title === "string" && obj.title.trim()
        ? obj.title.trim()
        : `步骤 ${i + 1}`;
    const toolName =
      typeof obj.tool_name === "string" && obj.tool_name.trim()
        ? obj.tool_name.trim()
        : undefined;
    return { id: stepId, title: stepTitle, status: "pending" as const, toolName };
  });

  const plan: PlanData = {
    id: planId,
    title,
    steps,
    status: "executing",
    createdAt: now,
    updatedAt: now,
  };

  useAiOrchestrationStore.getState().createPlan(plan);

  return JSON.stringify({
    ok: true,
    plan_id: planId,
    plan,
    hint:
      "计划已创建。执行每个步骤前调用 omni_plan_update_step 标记 in_progress；完成后标记 completed（附 summary）或 failed（附 error）。全部完成后计划自动标记 completed。",
  });
}

/** omni_plan_update_step：更新计划步骤状态 */
async function planUpdateStep(args: Record<string, unknown>): Promise<string> {
  const planId = requireString(args, "plan_id");
  const stepId = requireString(args, "step_id");
  const status = parseStepStatus(args.status);
  const summary = optionalString(args, "summary");
  const error = optionalString(args, "error");
  const toolCallId = optionalString(args, "tool_call_id");

  const store = useAiOrchestrationStore.getState();
  const existing = store.plans[planId];
  if (!existing) {
    return JSON.stringify({
      ok: false,
      error: `计划 ${planId} 不存在。请先调用 omni_plan_create 创建计划。`,
    });
  }

  store.syncStepFromToolCall(planId, stepId, status, summary, error);
  if (toolCallId) {
    store.updatePlanStep(planId, stepId, { toolCallId });
  }

  const updated = useAiOrchestrationStore.getState().plans[planId];
  return JSON.stringify({
    ok: true,
    plan_id: planId,
    step_id: stepId,
    status,
    plan: updated,
  });
}

/** omni_plan_add_step：向已有计划追加新步骤 */
async function planAddStep(args: Record<string, unknown>): Promise<string> {
  const planId = requireString(args, "plan_id");
  const stepId = requireString(args, "step_id");
  const title = requireString(args, "title");
  const toolName = optionalString(args, "tool_name");
  const afterStepId = optionalString(args, "after_step_id");

  const store = useAiOrchestrationStore.getState();
  const existing = store.plans[planId];
  if (!existing) {
    return JSON.stringify({
      ok: false,
      error: `计划 ${planId} 不存在。请先调用 omni_plan_create 创建计划。`,
    });
  }

  const step: PlanStep = {
    id: stepId,
    title,
    status: "pending",
    toolName,
  };
  store.addPlanStep(planId, step, afterStepId);

  const updated = useAiOrchestrationStore.getState().plans[planId];
  return JSON.stringify({
    ok: true,
    plan_id: planId,
    step_id: stepId,
    plan: updated,
  });
}

export const ORCHESTRATION_MODULE_TOOLS: BuiltinToolRegistration[] = [
  {
    name: "omni_orchestration_ssh_fleet_health",
    description:
      "对全部（或指定工作区内）SSH 主机扇出采集资源占用（CPU/内存等），返回汇总供你给出优化建议。适合「给所有 SSH 做体检」类请求；会在后台任务与会话任务树显示进度。可选 workspace_id；省略时若会话钉了工作区则用钉住范围，否则全局。",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "可选；限定工作区 membership。省略=会话钉住或全局",
        },
      },
    },
    handler: sshFleetHealthCheck,
  },
  {
    name: "omni_plan_create",
    description:
      "创建多步骤任务计划。在执行复杂任务（需要多个工具调用、多步骤操作）前调用此工具规划步骤，让用户看到任务进度与状态。返回 plan_id 供后续 omni_plan_update_step / omni_plan_add_step 使用。",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "计划标题，概括整体任务目标",
        },
        steps: {
          type: "array",
          description: "初始步骤列表，按执行顺序排列",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "步骤唯一 ID（如 step_1, step_2）",
              },
              title: {
                type: "string",
                description: "步骤标题",
              },
              tool_name: {
                type: "string",
                description: "预计使用的工具名（如 omni_ssh_exec）",
              },
            },
            required: ["id", "title"],
          },
        },
      },
      required: ["title", "steps"],
    },
    handler: planCreate,
  },
  {
    name: "omni_plan_update_step",
    description:
      "更新计划步骤的状态。在每个步骤开始执行时标记 in_progress，完成后标记 completed（附 summary）或 failed（附 error）。全部步骤完成后计划自动标记 completed。",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "计划 ID" },
        step_id: { type: "string", description: "步骤 ID" },
        status: {
          type: "string",
          enum: ["in_progress", "completed", "failed", "skipped"],
          description: "新状态",
        },
        summary: {
          type: "string",
          description: "步骤执行摘要（完成后填写）",
        },
        error: {
          type: "string",
          description: "错误信息（失败时填写）",
        },
        tool_call_id: {
          type: "string",
          description: "关联的工具调用 ID",
        },
      },
      required: ["plan_id", "step_id", "status"],
    },
    handler: planUpdateStep,
  },
  {
    name: "omni_plan_add_step",
    description:
      "向已有计划追加新步骤。用于任务执行中发现需要额外步骤、或计划需要调整时。可在指定步骤之后插入，不指定 after_step_id 则追加到末尾。",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "计划 ID" },
        step_id: { type: "string", description: "新步骤的唯一 ID" },
        title: { type: "string", description: "步骤标题" },
        tool_name: { type: "string", description: "预计使用的工具名" },
        after_step_id: {
          type: "string",
          description: "在此步骤 ID 之后插入；不指定则追加到末尾",
        },
      },
      required: ["plan_id", "step_id", "title"],
    },
    handler: planAddStep,
  },
];
