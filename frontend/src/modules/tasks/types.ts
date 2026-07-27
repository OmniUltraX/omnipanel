/** 全局任务中心统一投影类型（运行中 / 待办 / 历史） */

export type TaskFacet = "passive_job" | "active_job" | "inbox" | "approval";

export type TaskItemStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "stopped"
  | "open"
  | "triaged"
  | "blocked"
  | "done"
  | "dismissed"
  | "awaiting_approval";

export type TaskSource =
  | "worker_pool"
  | "loop"
  | "orchestration"
  | "tool_gate"
  | "audit"
  | "tool_audit"
  | "ai_session";

/** 统一任务/待办/历史条目 */
export interface TaskItem {
  id: string;
  facet: TaskFacet;
  module: string;
  kind: string;
  title: string;
  status: TaskItemStatus | string;
  progress?: {
    message?: string;
    index?: number;
    total?: number;
    rowCompleted?: number;
    rowTotal?: number;
  };
  /** Inbox */
  fingerprint?: string;
  occurrenceCount?: number;
  severity?: "info" | "warning" | "critical";
  suggestedAction?: string;
  evidence?: string;
  summary?: string;
  /** 关联 */
  parentId?: string;
  conversationId?: string | null;
  loopId?: string;
  runId?: string;
  resourceId?: string;
  resourceType?: string;
  workspaceId?: string | null;
  envTag?: string;
  /** 时间与结果 */
  createdAt: number;
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
  error?: string;
  resultSummary?: string;
  source: TaskSource;
  /** 原始后端/store id，便于取消等操作 */
  backendJobId?: string;
}

export type RunningFilter = "all" | "passive" | "active";

export function isJobRunning(status: string): boolean {
  return (
    status === "pending" ||
    status === "running" ||
    status === "discovering" ||
    status === "verifying"
  );
}

export function isJobTerminal(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "stopped" ||
    status === "done" ||
    status === "dismissed"
  );
}

export function sortByRecent(a: TaskItem, b: TaskItem): number {
  const ta = a.updatedAt ?? a.finishedAt ?? a.startedAt ?? a.createdAt;
  const tb = b.updatedAt ?? b.finishedAt ?? b.startedAt ?? b.createdAt;
  return tb - ta;
}
