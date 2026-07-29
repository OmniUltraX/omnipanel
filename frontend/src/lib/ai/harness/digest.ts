import type { PlanData } from "../aiMessageParts";
import type { SubConversationClusterRuntime } from "../../../stores/aiOrchestrationStore";
import { useAiOrchestrationStore } from "../../../stores/aiOrchestrationStore";

export type DigestTraceHint = {
  eventType: string;
  snippet: string;
};

export type ExperienceDigest = {
  conversationId: string;
  generatedAt: number;
  planSummary: {
    planId: string;
    title: string;
    status: PlanData["status"];
    doneSteps: number;
    totalSteps: number;
  } | null;
  clusterSummaries: Array<{
    clusterId: string;
    title: string;
    status: SubConversationClusterRuntime["status"];
    children: Array<{ conversationId: string; title: string; status: string }>;
  }>;
  traceErrorHints: DigestTraceHint[];
  /** 供 Skill 提取直接粘贴的纯文本 */
  extractText: string;
};

function latestPlan(plans: PlanData[]): PlanData | null {
  if (plans.length === 0) return null;
  return [...plans].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

/**
 * 父子/并行感知的经验 digest（只读，无副作用）。
 */
export function buildExperienceDigest(options: {
  conversationId: string;
  /** ai_list_session_traces 结果的精简投影 */
  traces?: Array<{ event_type: string; payload: string }>;
  /** 测试注入；默认读 orchestration store */
  plans?: PlanData[];
  clusters?: SubConversationClusterRuntime[];
}): ExperienceDigest {
  const orch = useAiOrchestrationStore.getState();
  const plans = options.plans ?? Object.values(orch.plans);
  const clusters = (
    options.clusters ?? Object.values(orch.clusters)
  ).filter((c) => c.parentConversationId === options.conversationId);

  const plan = latestPlan(plans);
  const planSummary = plan
    ? {
        planId: plan.id,
        title: plan.title,
        status: plan.status,
        doneSteps: plan.steps.filter(
          (s) => s.status === "completed" || s.status === "skipped",
        ).length,
        totalSteps: plan.steps.length,
      }
    : null;

  const clusterSummaries = clusters.map((c) => ({
    clusterId: c.clusterId,
    title: c.title,
    status: c.status,
    children: c.children.map((ch) => ({
      conversationId: ch.conversationId,
      title: ch.title,
      status: ch.status,
    })),
  }));

  const traceErrorHints: DigestTraceHint[] = [];
  for (const tr of options.traces ?? []) {
    const lower = `${tr.event_type} ${tr.payload}`.toLowerCase();
    if (
      lower.includes("error") ||
      lower.includes("fail") ||
      lower.includes("拒绝") ||
      lower.includes("denied")
    ) {
      traceErrorHints.push({
        eventType: tr.event_type,
        snippet: tr.payload.slice(0, 240),
      });
    }
  }

  const lines: string[] = [
    `[Harness Digest] conversation=${options.conversationId}`,
  ];
  if (planSummary) {
    lines.push(
      `Plan: ${planSummary.title} (${planSummary.status}) ${planSummary.doneSteps}/${planSummary.totalSteps}`,
    );
    if (plan) {
      for (const step of plan.steps) {
        lines.push(`  - [${step.status}] ${step.title}`);
      }
    }
  } else {
    lines.push("Plan: (none)");
  }
  if (clusterSummaries.length === 0) {
    lines.push("Clusters: (none)");
  } else {
    lines.push(`Clusters: ${clusterSummaries.length}`);
    for (const c of clusterSummaries) {
      lines.push(`  - ${c.title} (${c.status})`);
      for (const ch of c.children) {
        lines.push(`    · ${ch.title} [${ch.status}] ${ch.conversationId}`);
      }
    }
  }
  if (traceErrorHints.length > 0) {
    lines.push("Trace hints:");
    for (const h of traceErrorHints.slice(0, 8)) {
      lines.push(`  - ${h.eventType}: ${h.snippet}`);
    }
  }

  return {
    conversationId: options.conversationId,
    generatedAt: Date.now(),
    planSummary,
    clusterSummaries,
    traceErrorHints,
    extractText: lines.join("\n"),
  };
}
