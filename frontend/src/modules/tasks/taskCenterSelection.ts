/** 任务中心主从选择（待办 / 活动 / 历史） */
export type TaskCenterTab = "inbox" | "activity" | "history";

export type HistoryBucket = "jobs" | "audit" | "tool" | "timeline";

export type ActivityKind = "job" | "loop-plan";

/** 待办 Tab 内子栏：用户清单 | 系统建议（Finding） */
export type InboxBucket = "mine" | "suggestions";

/** 我的待办：智能视图或自定义列表 */
export type InboxMineView =
  | "myDay"
  | "important"
  | "planned"
  | "tasks"
  | `list:${string}`;

export const INBOX_BUCKETS: InboxBucket[] = ["mine", "suggestions"];

export const TODO_SMART_VIEWS: Array<Exclude<InboxMineView, `list:${string}`>> = [
  "myDay",
  "important",
  "planned",
  "tasks",
];

export type TaskCenterSelection =
  | { tab: "activity"; kind: ActivityKind; id: string }
  | {
      tab: "inbox";
      bucket: InboxBucket;
      /** 兼容旧：mine 下列表 id；suggestions 下 finding id */
      id?: string;
      /** mine：智能视图或 list:id */
      view?: InboxMineView;
      /** mine：选中的任务 */
      taskId?: string;
    }
  | { tab: "history"; bucket: HistoryBucket; id?: string };

export function selectionKey(sel: TaskCenterSelection): string {
  switch (sel.tab) {
    case "activity":
      return `activity:${sel.kind}:${sel.id}`;
    case "inbox": {
      if (sel.bucket === "mine") {
        const view = resolveMineView(sel);
        const task = sel.taskId ? `:task:${sel.taskId}` : "";
        return `inbox:mine:${view}${task}`;
      }
      return sel.id ? `inbox:${sel.bucket}:${sel.id}` : `inbox:${sel.bucket}`;
    }
    case "history":
      return sel.id ? `history:${sel.bucket}:${sel.id}` : `history:${sel.bucket}`;
  }
}

/** 解析 mine 视图：优先 view；旧数据仅有 id 时当作自定义列表 */
export function resolveMineView(sel: {
  view?: InboxMineView;
  id?: string;
}): InboxMineView {
  if (sel.view) return sel.view;
  if (sel.id) return `list:${sel.id}`;
  return "myDay";
}

export function mineViewToQuery(view: InboxMineView): {
  view: string;
  listId?: string;
} {
  if (view.startsWith("list:")) {
    return { view: "list", listId: view.slice(5) };
  }
  return { view };
}

export function isSmartMineView(view: InboxMineView): boolean {
  return !view.startsWith("list:");
}

/** 待办优先：默认入口且 rail 第一项 */
export const TASK_CENTER_TABS: TaskCenterTab[] = ["inbox", "activity", "history"];

/** 旧五 Tab / 「running」一级 Tab → 现行三 Tab（供持久化回读迁移） */
export const LEGACY_TASK_CENTER_TAB_ALIASES: Record<string, TaskCenterTab> = {
  running: "activity",
  inProgress: "activity",
  pending: "activity",
  triage: "inbox",
  loops: "activity",
};

/** 只认 inbox | activity | history；旧名映射后返回，未知则回退 inbox */
export function coerceTaskCenterTab(raw: string | null | undefined): TaskCenterTab {
  if (raw && (TASK_CENTER_TABS as readonly string[]).includes(raw)) {
    return raw as TaskCenterTab;
  }
  return LEGACY_TASK_CENTER_TAB_ALIASES[raw ?? ""] ?? "inbox";
}

export function coerceInboxBucket(raw: string | null | undefined): InboxBucket {
  if (raw && (INBOX_BUCKETS as readonly string[]).includes(raw)) {
    return raw as InboxBucket;
  }
  return "mine";
}

export function coerceInboxMineView(raw: string | null | undefined): InboxMineView {
  if (!raw) return "myDay";
  if (
    raw === "myDay" ||
    raw === "important" ||
    raw === "planned" ||
    raw === "tasks"
  ) {
    return raw;
  }
  if (raw.startsWith("list:") && raw.length > 5) return raw as InboxMineView;
  // 旧版把列表 id 直接存到 selection.id
  return `list:${raw}`;
}
