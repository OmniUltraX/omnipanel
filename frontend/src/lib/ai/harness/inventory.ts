import type { PlanData } from "../aiMessageParts";
import type { SubConversationClusterRuntime } from "../../../stores/aiOrchestrationStore";
import { useAiOrchestrationStore } from "../../../stores/aiOrchestrationStore";
import { useAiStore } from "../../../stores/aiStore";
import {
  buildAgentRuntimeConfig,
  resolveAgentId,
} from "../agents/resolveAgentRuntime";
import type { AgentId } from "../agents/types";

export type HarnessPlanSummary = {
  planId: string;
  title: string;
  status: PlanData["status"];
  doneSteps: number;
  totalSteps: number;
};

export type HarnessClusterSummary = {
  clusterId: string;
  title: string;
  status: SubConversationClusterRuntime["status"];
  childCount: number;
  completedChildren: number;
  failedChildren: number;
};

export type HarnessInventory = {
  conversationId: string | null;
  agentId: AgentId | null;
  toolsModeSummary: string;
  /** 本轮预期可见的工具族（对照提示词，避免提未注入的 MCP）。 */
  toolFamilySummary: string;
  skillIds: string[];
  activePlans: HarnessPlanSummary[];
  activeClusters: HarnessClusterSummary[];
  writeEntryNote: string;
};

function summarizeToolFamilies(toolsModeSummary: string): string {
  if (toolsModeSummary === "n/a") return "n/a";
  if (toolsModeSummary === "none") return "no tools";
  if (toolsModeSummary.includes("master")) {
    return "builtin(all) + extmcp + load_skill";
  }
  const module = toolsModeSummary.replace("moduleFilter=", "");
  return `builtin(${module}) + cross-module (plan/ask_user/web/load_skill); no extmcp`;
}

function summarizePlan(plan: PlanData): HarnessPlanSummary {
  const doneSteps = plan.steps.filter(
    (s) => s.status === "completed" || s.status === "skipped",
  ).length;
  return {
    planId: plan.id,
    title: plan.title,
    status: plan.status,
    doneSteps,
    totalSteps: plan.steps.length,
  };
}

function summarizeCluster(
  cluster: SubConversationClusterRuntime,
): HarnessClusterSummary {
  const completedChildren = cluster.children.filter(
    (c) => c.status === "completed",
  ).length;
  const failedChildren = cluster.children.filter(
    (c) => c.status === "failed" || c.status === "cancelled",
  ).length;
  return {
    clusterId: cluster.clusterId,
    title: cluster.title,
    status: cluster.status,
    childCount: cluster.children.length,
    completedChildren,
    failedChildren,
  };
}

function isPlanActive(plan: PlanData): boolean {
  return plan.status === "planning" || plan.status === "executing";
}

function isClusterActive(cluster: SubConversationClusterRuntime): boolean {
  return (
    cluster.status === "pending" ||
    cluster.status === "running" ||
    cluster.children.some((c) => c.status === "pending" || c.status === "running")
  );
}

/**
 * 只读 Harness 清单（前端纯算，不触发编排副作用）。
 * @param conversationId 父会话 id；null 时仅返回「当前侧栏会话」推断结果
 */
export function buildHarnessInventory(
  conversationId?: string | null,
): HarnessInventory {
  const ai = useAiStore.getState();
  const orch = useAiOrchestrationStore.getState();
  const convId =
    conversationId === undefined
      ? ai.activeConversationId
      : conversationId;

  const conversation = convId
    ? ai.conversations.find((c) => c.id === convId)
    : null;

  const agentId = conversation
    ? resolveAgentId({
        assistantPage: !convId?.startsWith("term-inline:"),
        conversationAgentId: conversation.agentId,
        moduleKey: convId?.startsWith("term-inline:") ? "terminal" : null,
      })
    : null;

  const runtime = agentId ? buildAgentRuntimeConfig(agentId) : null;
  const toolsModeSummary = runtime
    ? runtime.toolsMode === "none"
      ? "none"
      : `moduleFilter=${runtime.toolsMode.directInject.moduleFilter ?? "master"}`
    : "n/a";

  const plans = Object.values(orch.plans);
  const clusters = Object.values(orch.clusters);

  const scopedPlans = convId
    ? plans.filter((p) => {
        // Plan 本身无 conversationId；按「任意 active」+ 消息侧关联困难时，
        // 先返回全部 active，再附带同会话集群过滤提示。
        return isPlanActive(p) || p.status === "completed" || p.status === "failed";
      })
    : plans.filter(isPlanActive);

  const scopedClusters = convId
    ? clusters.filter((c) => c.parentConversationId === convId)
    : clusters.filter(isClusterActive);

  return {
    conversationId: convId,
    agentId,
    toolsModeSummary,
    toolFamilySummary: summarizeToolFamilies(toolsModeSummary),
    skillIds: conversation?.selectedSkillIds ?? ai.currentSkillIds ?? [],
    activePlans: (convId ? scopedPlans.filter(isPlanActive) : scopedPlans).map(
      summarizePlan,
    ),
    activeClusters: (convId
      ? scopedClusters.filter(isClusterActive)
      : scopedClusters
    ).map(summarizeCluster),
    writeEntryNote:
      "plan/cluster 仅经 internalToolBridge → plan/subConversation runners 写入",
  };
}
