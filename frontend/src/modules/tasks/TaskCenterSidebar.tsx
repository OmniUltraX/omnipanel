import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import {
  usePersistedVerticalSplitSections,
  VerticalSplitSidebar,
  VerticalSplitSidebarSection,
} from "../../components/ui/VerticalSplitSidebar";
import { Button } from "../../components/ui/primitives/Button";
import {
  IconCheckCircle,
  IconClipboard,
  IconClock,
  IconClose,
  IconHome,
  IconInbox,
  IconLightning,
  IconPlus,
  IconRefresh,
  IconRobot,
  IconWrench,
} from "../../components/ui/icons/Icons";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import { useAiOrchestrationStore } from "../../stores/aiOrchestrationStore";
import {
  cancelAllRunningBackgroundTasks,
  getRunningBackgroundTasks,
} from "../../stores/backgroundTaskStore";
import { cancelAllRunningClusters } from "../../lib/ai/orchestration/clusterCancellation";
import { useLoopStore } from "../../stores/loopStore";
import { showToast } from "../../stores/toastStore";
import { useUserTodoStore } from "../../stores/userTodoStore";
import type { TaskItem } from "./types";
import { isJobRunning } from "./types";
import type {
  HistoryBucket,
  InboxBucket,
  InboxMineView,
  TaskCenterSelection,
  TaskCenterTab,
} from "./taskCenterSelection";
import {
  resolveMineView,
  selectionKey,
  TODO_SMART_VIEWS,
} from "./taskCenterSelection";

const SECTION_STORAGE_KEY = "omnipanel-task-center-sidebar-sections";
const SIZE_STORAGE_KEY = "omnipanel-task-center-sidebar-sizes";

type ActivitySectionKey = "passive" | "active" | "plans";
type InboxSectionKey = "mine" | "suggestions";
type HistorySectionKey = "buckets" | "jobs";

export interface TaskCenterSidebarProps {
  tab: TaskCenterTab;
  selection: TaskCenterSelection | null;
  onSelect: (next: TaskCenterSelection) => void;
  running: TaskItem[];
  inbox: TaskItem[];
  historyJobs: TaskItem[];
  filteredHistoryJobs: TaskItem[];
  historyModules: string[];
  historyModuleFilter: string;
  onHistoryModuleFilterChange: (module: string) => void;
  inboxBucket: InboxBucket;
  onInboxBucketChange: (bucket: InboxBucket) => void;
}

function isProdEnvTag(tag?: string | null): boolean {
  return !!tag && tag.toLowerCase().includes("prod");
}

function riskClass(risk?: string): string {
  switch (risk) {
    case "critical":
      return "risk-critical";
    case "high":
      return "risk-high";
    case "medium":
    case "warning":
      return "risk-medium";
    default:
      return "risk-low";
  }
}

function formatShortTs(ts: number): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

function tStatus(t: (k: string) => string, status: string): string {
  const key = `taskCenter.status.${status}`;
  const labeled = t(key);
  return labeled === key ? status : labeled;
}

/** 与文件管理 fm-conn-item 同构的一行 */
function ConnRow({
  active,
  icon,
  name,
  trailing,
  title,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  name: string;
  trailing?: ReactNode;
  title?: string;
  onClick: () => void;
}) {
  return (
    <div
      className={`fm-conn-item${active ? " active" : ""}`}
      onClick={onClick}
      title={title ?? name}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <span className="conn-icon conn-icon--local" aria-hidden>
        {icon}
      </span>
      <span className="conn-name">{name}</span>
      {trailing}
    </div>
  );
}

function CountBadge({ count }: { count: number }) {
  return <span className="badge badge-muted">{count}</span>;
}

/** 侧栏分区内的轻量批量操作条（文案按钮，避免挤在 24px icon actions 里） */
function BatchBar({ children }: { children: ReactNode }) {
  return <div className="task-center-sidebar__batch-bar">{children}</div>;
}

export function TaskCenterSidebar({
  tab,
  selection,
  onSelect,
  running,
  inbox,
  historyJobs,
  filteredHistoryJobs,
  historyModules,
  historyModuleFilter,
  onHistoryModuleFilterChange,
  inboxBucket,
  onInboxBucketChange,
}: TaskCenterSidebarProps) {
  const { t } = useI18n();
  const specsMap = useLoopStore((s) => s.specs);
  const ensureBuiltinSpecs = useLoopStore((s) => s.ensureBuiltinSpecs);
  const triageOpenFindings = useLoopStore((s) => s.triageOpenFindings);
  const cancelAiTask = useAiOrchestrationStore((s) => s.cancelTask);
  const specs = useMemo(() => Object.values(specsMap), [specsMap]);
  const userTodoLists = useUserTodoStore((s) => s.lists);
  const loadUserTodos = useUserTodoStore((s) => s.loadLists);
  const createUserTodoList = useUserTodoStore((s) => s.createList);

  const activitySections = usePersistedVerticalSplitSections<ActivitySectionKey>(
    `${SECTION_STORAGE_KEY}-activity`,
    { passive: true, active: true, plans: true },
  );
  const inboxSections = usePersistedVerticalSplitSections<InboxSectionKey>(
    `${SECTION_STORAGE_KEY}-inbox-v3`,
    { mine: true, suggestions: true },
  );
  const historySections = usePersistedVerticalSplitSections<HistorySectionKey>(
    `${SECTION_STORAGE_KEY}-history`,
    { buckets: true, jobs: true },
  );

  const passiveJobs = useMemo(
    () => running.filter((i) => i.facet === "passive_job"),
    [running],
  );
  const activeJobs = useMemo(
    () => running.filter((i) => i.facet === "active_job"),
    [running],
  );
  const cancellablePassiveCount = useMemo(
    () => passiveJobs.filter((i) => isJobRunning(String(i.status))).length,
    [passiveJobs],
  );

  const handleDismissAllInbox = useCallback(async () => {
    const count = inbox.length;
    if (count === 0) return;
    const ok = await appConfirm(
      t("taskCenter.inbox.dismissAllConfirm", { count }),
      "OmniPanel",
      { kind: "warning", confirmLabel: t("taskCenter.inbox.dismissAll") },
    );
    if (!ok) return;
    const n = triageOpenFindings("dismissed");
    showToast(t("taskCenter.inbox.dismissAllDone", { count: n }));
  }, [inbox.length, t, triageOpenFindings]);

  const handleDoneAllInbox = useCallback(async () => {
    const count = inbox.length;
    if (count === 0) return;
    const ok = await appConfirm(
      t("taskCenter.inbox.doneAllConfirm", { count }),
      "OmniPanel",
      { confirmLabel: t("taskCenter.inbox.doneAll") },
    );
    if (!ok) return;
    const n = triageOpenFindings("done");
    showToast(t("taskCenter.inbox.doneAllDone", { count: n }));
  }, [inbox.length, t, triageOpenFindings]);

  const handleCancelAllPassive = useCallback(async () => {
    const count = cancellablePassiveCount;
    if (count === 0) return;
    const ok = await appConfirm(
      t("taskCenter.activity.cancelAllConfirm", { count }),
      "OmniPanel",
      { kind: "warning", confirmLabel: t("taskCenter.activity.cancelAll") },
    );
    if (!ok) return;
    try {
      const bgBefore = getRunningBackgroundTasks().length;
      await cancelAllRunningBackgroundTasks();
      const orch = useAiOrchestrationStore.getState().tasks;
      let orchCancelled = 0;
      for (const task of Object.values(orch)) {
        if (task.kind === "loop") continue;
        if (task.status === "running" || task.status === "pending") {
          cancelAiTask(task.id);
          orchCancelled += 1;
        }
      }
      const clusterCancelled = cancelAllRunningClusters();
      showToast(
        t("taskCenter.activity.cancelAllDone", {
          count: Math.max(bgBefore + orchCancelled + clusterCancelled, count),
        }),
      );
    } catch (e) {
      showToast(String(e));
    }
  }, [cancellablePassiveCount, cancelAiTask, t]);

  const isActive = (next: TaskCenterSelection) =>
    selection != null && selectionKey(selection) === selectionKey(next);

  useEffect(() => {
    if (tab === "activity") ensureBuiltinSpecs();
  }, [tab, ensureBuiltinSpecs]);

  useEffect(() => {
    if (tab === "inbox" && inboxBucket === "mine") {
      void loadUserTodos();
    }
  }, [tab, inboxBucket, loadUserTodos]);

  useEffect(() => {
    if (tab === "activity") {
      const jobOk =
        selection?.tab === "activity" &&
        selection.kind === "job" &&
        running.some((i) => i.id === selection.id);
      const planOk =
        selection?.tab === "activity" &&
        selection.kind === "loop-plan" &&
        specs.some((s) => s.id === selection.id);
      if (jobOk || planOk) return;
      if (passiveJobs[0]) {
        onSelect({ tab: "activity", kind: "job", id: passiveJobs[0].id });
      } else if (activeJobs[0]) {
        onSelect({ tab: "activity", kind: "job", id: activeJobs[0].id });
      } else if (specs[0]) {
        onSelect({ tab: "activity", kind: "loop-plan", id: specs[0].id });
      }
      return;
    }
    if (tab === "inbox") {
      if (inboxBucket === "suggestions") {
        const first = inbox[0];
        const valid =
          selection?.tab === "inbox" &&
          selection.bucket === "suggestions" &&
          (!selection.id || inbox.some((i) => i.id === selection.id));
        if (valid) return;
        if (first) onSelect({ tab: "inbox", bucket: "suggestions", id: first.id });
        else onSelect({ tab: "inbox", bucket: "suggestions" });
        return;
      }
      const valid =
        selection?.tab === "inbox" &&
        selection.bucket === "mine" &&
        !!selection.view;
      if (valid) return;
      onSelect({ tab: "inbox", bucket: "mine", view: "myDay" });
      return;
    }
    if (tab === "history") {
      if (selection?.tab !== "history") {
        onSelect({ tab: "history", bucket: "jobs" });
        return;
      }
      if (selection.bucket === "jobs" && selection.id) {
        const stillVisible = filteredHistoryJobs.some((j) => j.id === selection.id);
        if (!stillVisible) {
          const first = filteredHistoryJobs[0];
          onSelect(
            first
              ? { tab: "history", bucket: "jobs", id: first.id }
              : { tab: "history", bucket: "jobs" },
          );
        }
      }
    }
  }, [
    tab,
    selection,
    running,
    inbox,
    inboxBucket,
    userTodoLists,
    specs,
    passiveJobs,
    activeJobs,
    filteredHistoryJobs,
    onSelect,
  ]);

  if (tab === "activity") {
    return (
      <VerticalSplitSidebar className="task-center-sidebar">
        <VerticalSplitSidebarSection
          title={t("taskCenter.filter.passive")}
          expanded={activitySections.sections.passive}
          onToggle={() => activitySections.toggleSection("passive")}
          actions={<CountBadge count={passiveJobs.length} />}
        >
          {cancellablePassiveCount > 0 ? (
            <BatchBar>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => void handleCancelAllPassive()}
              >
                {t("taskCenter.activity.cancelAll")}
              </Button>
            </BatchBar>
          ) : null}
          {passiveJobs.length === 0 ? (
            <p className="fm-conn-empty">{t("taskCenter.activity.emptyPassive")}</p>
          ) : (
            <div className="fm-connections">
              {passiveJobs.map((item) => (
                <ConnRow
                  key={item.id}
                  active={isActive({ tab: "activity", kind: "job", id: item.id })}
                  name={item.title}
                  title={`${item.title} · ${item.module}`}
                  icon={
                    item.module === "database" ? (
                      <IconWrench size={12} />
                    ) : item.module === "workflow" ? (
                      <IconRefresh size={12} />
                    ) : (
                      <IconLightning size={12} />
                    )
                  }
                  trailing={
                    <span className="badge badge-muted">{tStatus(t, item.status)}</span>
                  }
                  onClick={() => onSelect({ tab: "activity", kind: "job", id: item.id })}
                />
              ))}
            </div>
          )}
        </VerticalSplitSidebarSection>

        <VerticalSplitSidebarSection
          title={t("taskCenter.filter.active")}
          expanded={activitySections.sections.active}
          onToggle={() => activitySections.toggleSection("active")}
          actions={<CountBadge count={activeJobs.length} />}
          autoSize
          autoSizePersist={{ storageKey: SIZE_STORAGE_KEY, id: "activity-active" }}
        >
          {activeJobs.length === 0 ? (
            <p className="fm-conn-empty">{t("taskCenter.activity.emptyActive")}</p>
          ) : (
            <div className="fm-connections">
              {activeJobs.map((item) => (
                <ConnRow
                  key={item.id}
                  active={isActive({ tab: "activity", kind: "job", id: item.id })}
                  name={item.title}
                  title={`${item.title} · ${item.module}`}
                  icon={<IconRobot size={12} />}
                  trailing={
                    <span className="badge badge-muted">{tStatus(t, item.status)}</span>
                  }
                  onClick={() => onSelect({ tab: "activity", kind: "job", id: item.id })}
                />
              ))}
            </div>
          )}
        </VerticalSplitSidebarSection>

        <VerticalSplitSidebarSection
          title={t("taskCenter.tabs.loopPlans")}
          expanded={activitySections.sections.plans}
          onToggle={() => activitySections.toggleSection("plans")}
          actions={<CountBadge count={specs.length} />}
          autoSize
          autoSizePersist={{ storageKey: SIZE_STORAGE_KEY, id: "activity-plans" }}
        >
          {specs.length === 0 ? (
            <p className="fm-conn-empty">{t("taskCenter.activity.empty")}</p>
          ) : (
            <div className="fm-connections">
              {specs.map((s) => (
                <ConnRow
                  key={s.id}
                  active={isActive({ tab: "activity", kind: "loop-plan", id: s.id })}
                  name={s.name}
                  title={s.description || s.name}
                  icon={<IconRefresh size={12} />}
                  trailing={
                    <span className="badge badge-muted">
                      {s.enabled ? t("taskCenter.loops.on") : t("taskCenter.loops.off")}
                    </span>
                  }
                  onClick={() => onSelect({ tab: "activity", kind: "loop-plan", id: s.id })}
                />
              ))}
            </div>
          )}
        </VerticalSplitSidebarSection>
      </VerticalSplitSidebar>
    );
  }

  if (tab === "inbox") {
    return (
      <VerticalSplitSidebar className="task-center-sidebar">
        <VerticalSplitSidebarSection
          title={t("taskCenter.inbox.mine")}
          expanded={inboxSections.sections.mine}
          onToggle={() => inboxSections.toggleSection("mine")}
          actions={
            <div className="schema-toolbar schema-toolbar--inline">
              <Button
                variant="icon"
                title={t("taskCenter.inbox.newList")}
                aria-label={t("taskCenter.inbox.newList")}
                onClick={(e) => {
                  e.stopPropagation();
                  onInboxBucketChange("mine");
                  void (async () => {
                    const id = await createUserTodoList();
                    if (id) {
                      onSelect({
                        tab: "inbox",
                        bucket: "mine",
                        view: `list:${id}`,
                        id,
                      });
                    }
                  })();
                }}
              >
                <IconPlus size={14} />
              </Button>
            </div>
          }
        >
          <div className="fm-connections">
            {TODO_SMART_VIEWS.map((view) => {
              const labelKey =
                view === "myDay"
                  ? "taskCenter.todo.myDay"
                  : view === "important"
                    ? "taskCenter.todo.important"
                    : view === "planned"
                      ? "taskCenter.todo.planned"
                      : "taskCenter.todo.tasks";
              const icon =
                view === "myDay" ? (
                  <IconLightning size={12} />
                ) : view === "important" ? (
                  <IconCheckCircle size={12} />
                ) : view === "planned" ? (
                  <IconClock size={12} />
                ) : (
                  <IconHome size={12} />
                );
              const next: TaskCenterSelection = {
                tab: "inbox",
                bucket: "mine",
                view,
              };
              const active =
                selection?.tab === "inbox" &&
                selection.bucket === "mine" &&
                resolveMineView(selection) === view;
              return (
                <ConnRow
                  key={view}
                  active={active}
                  name={t(labelKey)}
                  icon={icon}
                  onClick={() => {
                    onInboxBucketChange("mine");
                    onSelect(next);
                  }}
                />
              );
            })}
            {userTodoLists
              .filter((list) => !list.isDefault)
              .map((list) => {
                const view = `list:${list.id}` as InboxMineView;
                const active =
                  selection?.tab === "inbox" &&
                  selection.bucket === "mine" &&
                  resolveMineView(selection) === view;
                return (
                  <ConnRow
                    key={list.id}
                    active={active}
                    name={list.title || t("taskCenter.todo.untitledList")}
                    title={list.title}
                    icon={<IconClipboard size={12} />}
                    onClick={() => {
                      onInboxBucketChange("mine");
                      onSelect({
                        tab: "inbox",
                        bucket: "mine",
                        view,
                        id: list.id,
                      });
                    }}
                  />
                );
              })}
          </div>
        </VerticalSplitSidebarSection>

        <VerticalSplitSidebarSection
          title={t("taskCenter.inbox.suggestions")}
          expanded={inboxSections.sections.suggestions}
          onToggle={() => inboxSections.toggleSection("suggestions")}
          autoSize
          autoSizePersist={{ storageKey: SIZE_STORAGE_KEY, id: "inbox-suggestions" }}
          actions={
            inbox.length > 0 ? (
              <div className="schema-toolbar schema-toolbar--inline">
                <Button
                  variant="icon"
                  title={t("taskCenter.inbox.doneAll")}
                  aria-label={t("taskCenter.inbox.doneAll")}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDoneAllInbox();
                  }}
                >
                  <IconCheckCircle size={14} />
                </Button>
                <Button
                  variant="icon"
                  title={t("taskCenter.inbox.dismissAll")}
                  aria-label={t("taskCenter.inbox.dismissAll")}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDismissAllInbox();
                  }}
                >
                  <IconClose size={14} />
                </Button>
              </div>
            ) : undefined
          }
        >
          {inbox.length === 0 ? (
            <p className="fm-conn-empty">{t("taskCenter.inbox.empty")}</p>
          ) : (
            <div className="fm-connections">
              {inbox.map((item) => {
                const riskLabel = item.severity
                  ? t(`taskCenter.risk.${item.severity}`) === `taskCenter.risk.${item.severity}`
                    ? item.severity
                    : t(`taskCenter.risk.${item.severity}`)
                  : tStatus(t, item.status);
                return (
                  <ConnRow
                    key={item.id}
                    active={isActive({
                      tab: "inbox",
                      bucket: "suggestions",
                      id: item.id,
                    })}
                    name={item.title}
                    title={item.title}
                    icon={<IconInbox size={12} />}
                    trailing={<span className="badge badge-muted">{riskLabel}</span>}
                    onClick={() => {
                      onInboxBucketChange("suggestions");
                      onSelect({ tab: "inbox", bucket: "suggestions", id: item.id });
                    }}
                  />
                );
              })}
            </div>
          )}
        </VerticalSplitSidebarSection>
      </VerticalSplitSidebar>
    );
  }

  const buckets: { bucket: HistoryBucket; label: string; icon: ReactNode }[] = [
    { bucket: "jobs", label: t("taskCenter.history.jobsTab"), icon: <IconCheckCircle size={12} /> },
    { bucket: "audit", label: t("taskCenter.history.auditTab"), icon: <IconClipboard size={12} /> },
    { bucket: "tool", label: t("taskCenter.history.toolTab"), icon: <IconWrench size={12} /> },
    { bucket: "timeline", label: t("taskCenter.history.timelineTab"), icon: <IconClock size={12} /> },
  ];

  const showJobsList = selection?.tab === "history" && selection.bucket === "jobs";

  return (
    <VerticalSplitSidebar className="task-center-sidebar">
      <VerticalSplitSidebarSection
        title={t("taskCenter.history.buckets")}
        expanded={historySections.sections.buckets}
        onToggle={() => historySections.toggleSection("buckets")}
      >
        <div className="fm-connections">
          {buckets.map(({ bucket, label, icon }) => (
            <ConnRow
              key={bucket}
              active={
                selection?.tab === "history" &&
                selection.bucket === bucket &&
                !selection.id
              }
              name={label}
              icon={icon}
              onClick={() => onSelect({ tab: "history", bucket })}
            />
          ))}
        </div>
      </VerticalSplitSidebarSection>

      {showJobsList ? (
        <VerticalSplitSidebarSection
          title={t("taskCenter.history.recentJobs")}
          expanded={historySections.sections.jobs}
          onToggle={() => historySections.toggleSection("jobs")}
          actions={<CountBadge count={filteredHistoryJobs.length} />}
          autoSize
          autoSizePersist={{ storageKey: SIZE_STORAGE_KEY, id: "history-jobs" }}
        >
          {historyModules.length > 0 ? (
            <div className="task-center-sidebar__module-filter">
              <label
                className="fm-quick-subsection-title"
                htmlFor="task-history-module-filter"
              >
                {t("taskCenter.history.filterModule")}
              </label>
              <div className="task-center-sidebar__module-filter-row">
                <select
                  id="task-history-module-filter"
                  className="task-center-sidebar__module-select"
                  value={historyModuleFilter}
                  onChange={(e) => onHistoryModuleFilterChange(e.target.value)}
                >
                  <option value="all">{t("taskCenter.history.filterModuleAll")}</option>
                  {historyModules.map((mod) => (
                    <option key={mod} value={mod}>
                      {mod}
                    </option>
                  ))}
                </select>
                {historyModuleFilter !== "all" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => onHistoryModuleFilterChange("all")}
                  >
                    {t("taskCenter.history.clearFilter")}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {filteredHistoryJobs.length === 0 ? (
            <p className="fm-conn-empty">
              {historyJobs.length === 0
                ? t("taskCenter.history.empty")
                : t("taskCenter.history.filterNoMatch")}
            </p>
          ) : (
            <div className="fm-connections">
              {filteredHistoryJobs.map((item) => {
                const riskLabel = item.severity
                  ? t(`taskCenter.risk.${item.severity}`) === `taskCenter.risk.${item.severity}`
                    ? item.severity
                    : t(`taskCenter.risk.${item.severity}`)
                  : null;
                return (
                  <ConnRow
                    key={item.id}
                    active={isActive({ tab: "history", bucket: "jobs", id: item.id })}
                    name={item.title}
                    title={`${item.title} · ${item.module} · ${formatShortTs(item.finishedAt ?? item.createdAt)}`}
                    icon={<IconCheckCircle size={12} />}
                    trailing={
                      <>
                        {item.envTag ? (
                          <span
                            className={`env-badge${isProdEnvTag(item.envTag) ? " env-prod" : ""}`}
                          >
                            {isProdEnvTag(item.envTag)
                              ? t("taskCenter.history.envProd")
                              : item.envTag}
                          </span>
                        ) : null}
                        {riskLabel ? (
                          <span className={`risk-pill ${riskClass(item.severity)}`}>
                            {riskLabel}
                          </span>
                        ) : (
                          <span className="badge badge-muted">{tStatus(t, item.status)}</span>
                        )}
                      </>
                    }
                    onClick={() =>
                      onSelect({ tab: "history", bucket: "jobs", id: item.id })
                    }
                  />
                );
              })}
            </div>
          )}
        </VerticalSplitSidebarSection>
      ) : null}
    </VerticalSplitSidebar>
  );
}
