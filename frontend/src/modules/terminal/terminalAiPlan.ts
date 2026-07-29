import { useMemo } from "react";
import {
  isAiThreadMessage,
  useBlocksStore,
  type TerminalBlock,
} from "../../stores/blocksStore";
import type { PlanData } from "../../lib/ai/aiMessageParts";
import { useAiOrchestrationStore } from "../../stores/aiOrchestrationStore";

/** 从终端 AI 块线程中取出最近一条 plan 快照 */
export function extractLatestPlanSnapshot(
  block: TerminalBlock | null | undefined,
): PlanData | null {
  if (!block || block.kind !== "ai") return null;
  let snapshot: PlanData | null = null;
  for (const item of block.aiThread ?? []) {
    if (!isAiThreadMessage(item) || item.role !== "assistant") continue;
    for (const part of item.parts ?? []) {
      if (part.type === "plan") {
        snapshot = part.plan;
      }
    }
  }
  return snapshot;
}

export function formatPlanProgressLabel(plan: PlanData): string {
  const done = plan.steps.filter(
    (s) => s.status === "completed" || s.status === "skipped",
  ).length;
  return `${done}/${plan.steps.length}`;
}

export type PlanCompactBadgeTone =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "idle";

export type PlanCompactBadge = {
  progress: string;
  detail: string;
  tone: PlanCompactBadgeTone;
};

export type PlanCompactBadgeLabels = {
  completed: string;
  failed: string;
  cancelled: string;
  executing: string;
  planning: string;
};

/** 标题栏紧凑摘要：进度 + 当前步骤/终态文案 */
export function resolvePlanCompactBadge(
  plan: PlanData,
  labels: PlanCompactBadgeLabels,
): PlanCompactBadge {
  const progress = formatPlanProgressLabel(plan);
  const inProgress = plan.steps.find((s) => s.status === "in_progress");
  if (inProgress) {
    return { progress, detail: inProgress.title, tone: "running" };
  }

  const failedStep = plan.steps.find((s) => s.status === "failed");
  if (plan.status === "failed" || failedStep) {
    return {
      progress,
      detail: failedStep?.title || labels.failed,
      tone: "failed",
    };
  }

  if (plan.status === "cancelled") {
    return { progress, detail: labels.cancelled, tone: "cancelled" };
  }

  if (plan.status === "completed") {
    return { progress, detail: labels.completed, tone: "completed" };
  }

  const pending = plan.steps.find((s) => s.status === "pending");
  if (pending) {
    return {
      progress,
      detail: pending.title,
      tone: plan.status === "planning" ? "idle" : "running",
    };
  }

  if (plan.status === "planning") {
    return { progress, detail: labels.planning, tone: "idle" };
  }
  if (plan.status === "executing") {
    return { progress, detail: labels.executing, tone: "running" };
  }

  return { progress, detail: plan.title, tone: "idle" };
}

/** 订阅块内最新 plan（优先 live orchestration） */
export function useTerminalBlockPlan(blockId: string): PlanData | null {
  const snapshot = useBlocksStore((state) => {
    const block = state.findBlockById(blockId);
    return extractLatestPlanSnapshot(block);
  });
  const planId = snapshot?.id ?? null;
  const livePlan = useAiOrchestrationStore((s) =>
    planId ? (s.plans[planId] ?? null) : null,
  );
  return useMemo(() => livePlan ?? snapshot, [livePlan, snapshot]);
}

/** 取消终端 AI 块内计划的剩余步骤，并回写 message plan part */
export function cancelTerminalBlockPlanRemaining(
  blockId: string,
  planId: string,
): void {
  const store = useAiOrchestrationStore.getState();
  const snapshot = extractLatestPlanSnapshot(
    useBlocksStore.getState().findBlockById(blockId),
  );
  const plan = store.plans[planId] ?? snapshot;
  if (!plan || plan.id !== planId) return;

  for (const step of plan.steps) {
    if (step.status === "pending" || step.status === "in_progress") {
      store.updatePlanStep(planId, step.id, {
        status: "skipped",
        summary: "用户取消剩余步骤",
      });
    }
  }
  store.updatePlan(planId, { status: "cancelled" });

  const updated = store.plans[planId];
  if (!updated) return;
  const block = useBlocksStore.getState().findBlockById(blockId);
  if (!block || block.kind !== "ai") return;
  for (const item of block.aiThread ?? []) {
    if (item.kind !== "message" || item.role !== "assistant") continue;
    if (item.parts?.some((p) => p.type === "plan" && p.plan.id === planId)) {
      useBlocksStore.getState().upsertAiThreadPlanPart(blockId, item.id, updated);
      break;
    }
  }
}
