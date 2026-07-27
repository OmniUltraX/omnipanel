/**
 * 任务中心多源投影。
 *
 * 去重规则：
 * 1. 跳过 `kind === "aiOrchestration"` 的 bg 任务（编排侧已有镜像，避免双计）。
 * 2. LoopRun → active_job；若编排 parent 已由 LoopRun.parentTaskId 覆盖则不再单独展示该编排任务。
 * 3. 其它 AI 编排任务 → passive_job（module=ai）。
 * 4. Finding → inbox；ActionDraft / ToolGate 审批绝不进入 inbox（也不写 loop findings）。
 * 5. Workflow live 执行 → passive_job；历史 bg 来自 bgTaskHistory。
 */
import type {
  AiTaskParent,
  SubConversationClusterRuntime,
} from "../../../stores/aiOrchestrationStore";
import type { BackgroundTaskInfo } from "../../../stores/backgroundTaskStore";
import type { LiveWorkflowExecution } from "../../../stores/workflowLiveStore";
import type { LoopFinding, LoopRun } from "../../../lib/ai/loopSpec";
import {
  isJobRunning,
  isJobTerminal,
  sortByRecent,
  type TaskItem,
} from "../types";

export interface TaskProjectionInput {
  bgTasks: Record<string, BackgroundTaskInfo>;
  bgHistory: Record<string, BackgroundTaskInfo>;
  aiTasks: Record<string, AiTaskParent>;
  /** 子会话集群（cursor sub-agent 范式）；可选，未传时跳过 cluster 投影 */
  clusters?: Record<string, SubConversationClusterRuntime>;
  loopRuns: Record<string, LoopRun>;
  findings: Record<string, LoopFinding>;
  workflowExecs: Record<string, LiveWorkflowExecution>;
  workflowTitles?: Record<string, string>;
  loopTitles?: Record<string, string>;
}

export interface TaskProjection {
  running: TaskItem[];
  inbox: TaskItem[];
  historyJobs: TaskItem[];
}

function mapBgToItem(task: BackgroundTaskInfo): TaskItem {
  return {
    id: `passive:bg:${task.id}`,
    facet: "passive_job",
    module: task.module,
    kind: task.kind,
    title: task.title,
    status: task.status,
    progress: {
      message: task.progress,
      index: task.index,
      total: task.total,
      rowCompleted: task.rowCompleted ?? undefined,
      rowTotal: task.rowTotal ?? undefined,
    },
    createdAt: task.startedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt ?? undefined,
    error: task.error ?? undefined,
    source: "worker_pool",
    backendJobId: task.id,
  };
}

function mapWorkflowStatus(status: string): string {
  switch (status) {
    case "running":
    case "pending":
      return status;
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return status;
  }
}

export function buildTaskProjection(input: TaskProjectionInput): TaskProjection {
  const running: TaskItem[] = [];
  const historyJobs: TaskItem[] = [];
  const coveredOrchIds = new Set<string>();
  const historyBgIds = new Set<string>();

  for (const run of Object.values(input.loopRuns)) {
    if (run.parentTaskId) coveredOrchIds.add(run.parentTaskId);
    const item: TaskItem = {
      id: `active:loop:${run.id}`,
      facet: "active_job",
      module: "loop",
      kind: "loop_run",
      title: input.loopTitles?.[run.loopId] ?? `Loop · ${run.loopId}`,
      status: run.status,
      loopId: run.loopId,
      runId: run.id,
      parentId: run.parentTaskId,
      createdAt: run.startedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      error: run.error,
      resultSummary:
        run.verifyPassed == null
          ? undefined
          : run.verifyPassed
            ? "verify:pass"
            : "verify:fail",
      summary: run.turns.map((t) => `${t.phase}:${t.ok ? "ok" : "fail"}`).join(" · "),
      source: "loop",
      backendJobId: run.id,
    };
    if (isJobRunning(run.status)) running.push(item);
    else if (isJobTerminal(run.status) || run.finishedAt) historyJobs.push(item);
  }

  for (const task of Object.values(input.bgTasks)) {
    if (task.kind === "aiOrchestration") continue;
    const item = mapBgToItem(task);
    if (isJobRunning(task.status)) running.push(item);
    else if (isJobTerminal(task.status)) {
      historyJobs.push(item);
      historyBgIds.add(task.id);
    }
  }

  for (const task of Object.values(input.bgHistory)) {
    if (task.kind === "aiOrchestration") continue;
    if (historyBgIds.has(task.id)) continue;
    if (input.bgTasks[task.id] && isJobRunning(input.bgTasks[task.id].status)) continue;
    historyJobs.push(mapBgToItem(task));
  }

  for (const exec of Object.values(input.workflowExecs)) {
    const status = mapWorkflowStatus(String(exec.status));
    const title =
      exec.title ||
      input.workflowTitles?.[exec.workflow_id] ||
      `Workflow · ${exec.workflow_id.slice(0, 8)}`;
    const item: TaskItem = {
      id: `passive:wf:${exec.id}`,
      facet: "passive_job",
      module: "workflow",
      kind: "workflow_run",
      title,
      status,
      createdAt: exec.started_at ?? Date.now(),
      startedAt: exec.started_at ?? undefined,
      finishedAt: exec.finished_at ?? undefined,
      resultSummary: exec.output?.slice(0, 200) || undefined,
      error: status === "failed" ? exec.output?.slice(0, 300) : undefined,
      source: "worker_pool",
      backendJobId: exec.id,
      parentId: exec.workflow_id,
    };
    if (isJobRunning(status)) running.push(item);
    else if (isJobTerminal(status)) historyJobs.push(item);
  }

  for (const task of Object.values(input.aiTasks)) {
    if (coveredOrchIds.has(task.id)) continue;
    const isLoopKind = task.kind === "loop";
    const item: TaskItem = {
      id: isLoopKind ? `active:orch:${task.id}` : `passive:orch:${task.id}`,
      facet: isLoopKind ? "active_job" : "passive_job",
      module: "ai",
      kind: task.kind || "orchestration",
      title: task.title,
      status: task.status,
      conversationId: task.conversationId,
      createdAt: task.startedAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      resultSummary: task.resultSummary,
      summary: `${task.children.filter((c) => c.status === "completed").length}/${task.children.length}`,
      source: "orchestration",
      backendJobId: task.id,
    };
    if (isJobRunning(task.status)) running.push(item);
    else if (isJobTerminal(task.status)) historyJobs.push(item);
  }

  // 子会话集群（cursor sub-agent 范式）：running/pending → running；terminal → historyJobs
  for (const cluster of Object.values(input.clusters ?? {})) {
    const done = cluster.children.filter(
      (c) =>
        c.status === "completed" ||
        c.status === "failed" ||
        c.status === "cancelled",
    ).length;
    const item: TaskItem = {
      id: `passive:cluster:${cluster.clusterId}`,
      facet: "passive_job",
      module: "ai",
      kind: "sub_conversation_cluster",
      title: cluster.title,
      status: cluster.status,
      conversationId: cluster.parentConversationId,
      createdAt: cluster.createdAt,
      startedAt: cluster.createdAt,
      finishedAt: cluster.finishedAt,
      resultSummary: cluster.aggregatedResult?.slice(0, 200),
      summary: `${done}/${cluster.children.length}`,
      source: "orchestration",
      backendJobId: cluster.clusterId,
      parentId: cluster.parentConversationId,
    };
    if (isJobRunning(cluster.status)) running.push(item);
    else if (isJobTerminal(cluster.status)) historyJobs.push(item);
  }

  const inbox: TaskItem[] = Object.values(input.findings)
    .filter((f) => f.status === "open" || f.status === "triaged" || f.status === "blocked")
    .map((f) => ({
      id: `inbox:finding:${f.id}`,
      facet: "inbox" as const,
      module: "loop",
      kind: "finding",
      title: f.title,
      status: f.status,
      severity: f.severity,
      suggestedAction: f.suggestedAction,
      evidence: f.evidence,
      summary: f.summary,
      fingerprint: f.fingerprint,
      occurrenceCount: f.occurrenceCount ?? 1,
      loopId: f.loopId,
      runId: f.runId,
      resourceId: f.resourceId,
      resourceType: f.resourceType,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      source: "loop" as const,
      backendJobId: f.id,
    }));

  running.sort(sortByRecent);
  inbox.sort(sortByRecent);
  historyJobs.sort(sortByRecent);

  return { running, inbox, historyJobs };
}
