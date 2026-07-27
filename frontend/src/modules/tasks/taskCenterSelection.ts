/** 任务中心主从选择（活动 / 待办 / 历史） */
export type TaskCenterTab = "activity" | "inbox" | "history";

export type HistoryBucket = "jobs" | "audit" | "tool" | "timeline";

export type ActivityKind = "job" | "loop-plan";

export type TaskCenterSelection =
  | { tab: "activity"; kind: ActivityKind; id: string }
  | { tab: "inbox"; id: string }
  | { tab: "history"; bucket: HistoryBucket; id?: string };

export function selectionKey(sel: TaskCenterSelection): string {
  switch (sel.tab) {
    case "activity":
      return `activity:${sel.kind}:${sel.id}`;
    case "inbox":
      return `inbox:${sel.id}`;
    case "history":
      return sel.id ? `history:${sel.bucket}:${sel.id}` : `history:${sel.bucket}`;
  }
}

export const TASK_CENTER_TABS: TaskCenterTab[] = ["activity", "inbox", "history"];

/** 旧五 Tab / 「running」一级 Tab → 现行三 Tab（供持久化回读迁移） */
export const LEGACY_TASK_CENTER_TAB_ALIASES: Record<string, TaskCenterTab> = {
  running: "activity",
  inProgress: "activity",
  pending: "activity",
  triage: "inbox",
  loops: "activity",
};

/** 只认 activity | inbox | history；旧名映射后返回，未知则回退 activity */
export function coerceTaskCenterTab(raw: string | null | undefined): TaskCenterTab {
  if (raw && (TASK_CENTER_TABS as readonly string[]).includes(raw)) {
    return raw as TaskCenterTab;
  }
  return LEGACY_TASK_CENTER_TAB_ALIASES[raw ?? ""] ?? "activity";
}
