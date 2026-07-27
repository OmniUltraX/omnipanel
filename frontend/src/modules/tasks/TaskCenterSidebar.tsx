import { useEffect, useMemo, type ReactNode } from "react";
import {
  IconCheckCircle,
  IconClipboard,
  IconClock,
  IconInbox,
  IconLightning,
  IconRefresh,
  IconRobot,
  IconWrench,
} from "../../components/ui/icons/Icons";
import { useI18n } from "../../i18n";
import { useLoopStore } from "../../stores/loopStore";
import type { TaskItem } from "./types";
import type { HistoryBucket, TaskCenterSelection, TaskCenterTab } from "./taskCenterSelection";
import { selectionKey } from "./taskCenterSelection";

export interface TaskCenterSidebarProps {
  tab: TaskCenterTab;
  selection: TaskCenterSelection | null;
  onSelect: (next: TaskCenterSelection) => void;
  /** 未筛选的全部运行中任务（侧栏自行按 facet 分组） */
  running: TaskItem[];
  inbox: TaskItem[];
  /** 未筛选的全部历史任务（用于统计与模块芯片） */
  historyJobs: TaskItem[];
  /** 按 module 筛选后的历史任务列表 */
  filteredHistoryJobs: TaskItem[];
  historyModules: string[];
  historyModuleFilter: string;
  onHistoryModuleFilterChange: (module: string) => void;
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

function statusTone(status: string): string {
  switch (status) {
    case "running":
    case "discovering":
    case "verifying":
      return "running";
    case "pending":
      return "pending";
    case "completed":
    case "done":
    case "success":
      return "success";
    case "failed":
    case "error":
    case "blocked":
      return "danger";
    case "cancelled":
    case "stopped":
    case "dismissed":
      return "muted";
    case "warning":
    case "triaged":
    case "open":
      return "warn";
    default:
      return "neutral";
  }
}

function severityTone(sev?: string): string {
  if (sev === "critical") return "danger";
  if (sev === "warning") return "warn";
  if (sev === "info") return "info";
  return "neutral";
}

function tStatus(t: (k: string) => string, status: string): string {
  const key = `taskCenter.status.${status}`;
  const labeled = t(key);
  return labeled === key ? status : labeled;
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
}: TaskCenterSidebarProps) {
  const { t } = useI18n();
  const specsMap = useLoopStore((s) => s.specs);
  const ensureBuiltinSpecs = useLoopStore((s) => s.ensureBuiltinSpecs);
  const specs = useMemo(() => Object.values(specsMap), [specsMap]);

  const passiveJobs = useMemo(
    () => running.filter((i) => i.facet === "passive_job"),
    [running],
  );
  const activeJobs = useMemo(
    () => running.filter((i) => i.facet === "active_job"),
    [running],
  );

  const isActive = (next: TaskCenterSelection) =>
    selection != null && selectionKey(selection) === selectionKey(next);

  useEffect(() => {
    if (tab === "activity") ensureBuiltinSpecs();
  }, [tab, ensureBuiltinSpecs]);

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
      const first = inbox[0];
      const valid =
        selection?.tab === "inbox" && inbox.some((i) => i.id === selection.id);
      if (!valid && first) onSelect({ tab: "inbox", id: first.id });
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
    specs,
    passiveJobs,
    activeJobs,
    filteredHistoryJobs,
    onSelect,
  ]);

  if (tab === "activity") {
    const hasAny = passiveJobs.length + activeJobs.length + specs.length > 0;
    if (!hasAny) {
      return (
        <div className="task-center-sidebar">
          <div className="task-center-sidebar__empty">
            <span className="task-center-sidebar__empty-icon" aria-hidden>
              <IconLightning size={22} />
            </span>
            <p className="task-center-sidebar__empty-text">{t("taskCenter.activity.empty")}</p>
          </div>
        </div>
      );
    }

    return (
      <div className="task-center-sidebar">
        <div className="task-center-sidebar__sections">
          <NavSection
            accent="bg"
            title={t("taskCenter.filter.passive")}
            icon={<IconLightning size={12} />}
            count={passiveJobs.length}
            emptyHint={t("taskCenter.activity.emptyPassive")}
            items={passiveJobs.map((item) => ({
              id: item.id,
              title: item.title,
              subtitle: [item.module, formatShortTs(item.startedAt ?? item.createdAt)]
                .filter(Boolean)
                .join(" · "),
              badge: { text: tStatus(t, item.status), tone: statusTone(item.status) },
              leading:
                item.module === "database" ? (
                  <IconWrench size={14} />
                ) : item.module === "workflow" ? (
                  <IconRefresh size={14} />
                ) : (
                  <IconLightning size={14} />
                ),
              active: isActive({ tab: "activity", kind: "job", id: item.id }),
              onClick: () => onSelect({ tab: "activity", kind: "job", id: item.id }),
            }))}
          />
          <NavSection
            accent="ai"
            title={t("taskCenter.filter.active")}
            icon={<IconRobot size={12} />}
            count={activeJobs.length}
            emptyHint={t("taskCenter.activity.emptyActive")}
            items={activeJobs.map((item) => ({
              id: item.id,
              title: item.title,
              subtitle: [item.module, formatShortTs(item.startedAt ?? item.createdAt)]
                .filter(Boolean)
                .join(" · "),
              badge: { text: tStatus(t, item.status), tone: statusTone(item.status) },
              leading: <IconRobot size={14} />,
              active: isActive({ tab: "activity", kind: "job", id: item.id }),
              onClick: () => onSelect({ tab: "activity", kind: "job", id: item.id }),
            }))}
          />
          <NavSection
            accent="loop"
            title={t("taskCenter.tabs.loopPlans")}
            icon={<IconRefresh size={12} />}
            count={specs.length}
            items={specs.map((s) => ({
              id: s.id,
              title: s.name,
              subtitle: s.description,
              badge: {
                text: s.enabled ? t("taskCenter.loops.on") : t("taskCenter.loops.off"),
                tone: s.enabled ? "success" : "muted",
              },
              leading: <IconRefresh size={14} />,
              active: isActive({ tab: "activity", kind: "loop-plan", id: s.id }),
              onClick: () => onSelect({ tab: "activity", kind: "loop-plan", id: s.id }),
            }))}
          />
        </div>
      </div>
    );
  }

  if (tab === "inbox") {
    return (
      <div className="task-center-sidebar">
        <SidebarList
          empty={t("taskCenter.inbox.empty")}
          items={inbox.map((item) => ({
            id: item.id,
            title: item.title,
            subtitle: [
              item.resourceType,
              item.occurrenceCount && item.occurrenceCount > 1
                ? t("taskCenter.inbox.occurrences", { count: item.occurrenceCount })
                : null,
              formatShortTs(item.updatedAt ?? item.createdAt),
            ]
              .filter(Boolean)
              .join(" · "),
            badge: {
              text: item.severity
                ? t(`taskCenter.risk.${item.severity}`) === `taskCenter.risk.${item.severity}`
                  ? item.severity
                  : t(`taskCenter.risk.${item.severity}`)
                : tStatus(t, item.status),
              tone: severityTone(item.severity),
            },
            leading: <IconInbox size={14} />,
            active: isActive({ tab: "inbox", id: item.id }),
            onClick: () => onSelect({ tab: "inbox", id: item.id }),
          }))}
        />
      </div>
    );
  }

  const buckets: { bucket: HistoryBucket; label: string; icon: ReactNode }[] = [
    { bucket: "jobs", label: t("taskCenter.history.jobsTab"), icon: <IconCheckCircle size={14} /> },
    { bucket: "audit", label: t("taskCenter.history.auditTab"), icon: <IconClipboard size={14} /> },
    { bucket: "tool", label: t("taskCenter.history.toolTab"), icon: <IconWrench size={14} /> },
    { bucket: "timeline", label: t("taskCenter.history.timelineTab"), icon: <IconClock size={14} /> },
  ];

  const showJobsList = selection?.tab === "history" && selection.bucket === "jobs";
  const jobItems = showJobsList
    ? filteredHistoryJobs.map((item) => {
        const riskLabel = item.severity
          ? t(`taskCenter.risk.${item.severity}`) === `taskCenter.risk.${item.severity}`
            ? item.severity
            : t(`taskCenter.risk.${item.severity}`)
          : null;
        const tags: ReactNode[] = [];
        if (item.envTag) {
          tags.push(
            <span
              key="env"
              className={`env-badge${isProdEnvTag(item.envTag) ? " env-prod" : ""}`}
              title={item.envTag}
            >
              {isProdEnvTag(item.envTag) ? t("taskCenter.history.envProd") : item.envTag}
            </span>,
          );
        }
        if (riskLabel) {
          tags.push(
            <span key="risk" className={`risk-pill ${riskClass(item.severity)}`}>
              {riskLabel}
            </span>,
          );
        }
        return {
          id: item.id,
          title: item.title,
          subtitle: `${item.module} · ${formatShortTs(item.finishedAt ?? item.createdAt)}`,
          badge: { text: tStatus(t, item.status), tone: statusTone(item.status) },
          tags: tags.length > 0 ? tags : undefined,
          active: isActive({ tab: "history", bucket: "jobs", id: item.id }),
          onClick: () => onSelect({ tab: "history", bucket: "jobs", id: item.id }),
        };
      })
    : [];

  return (
    <div className="task-center-sidebar">
      <div className="task-center-sidebar__sections">
        <section className="task-center-sidebar__section task-center-sidebar__section--history">
          <h4 className="task-center-sidebar__section-title">
            <span className="task-center-sidebar__section-label">
              {t("taskCenter.history.buckets")}
            </span>
          </h4>
          <ul className="task-center-sidebar__list">
            {buckets.map(({ bucket, label, icon }) => {
              const active =
                selection?.tab === "history" && selection.bucket === bucket && !selection.id;
              return (
                <li key={bucket}>
                  <button
                    type="button"
                    className={`task-center-sidebar__item task-center-sidebar__item--nav${active ? " is-active" : ""}`}
                    onClick={() => onSelect({ tab: "history", bucket })}
                    aria-current={active ? "true" : undefined}
                  >
                    <span className="task-center-sidebar__item-accent" aria-hidden />
                    <span className="task-center-sidebar__item-leading" aria-hidden>
                      {icon}
                    </span>
                    <span className="task-center-sidebar__item-body">
                      <span className="task-center-sidebar__item-row">
                        <span className="task-center-sidebar__item-title">{label}</span>
                        {bucket === "jobs" ? (
                          <span className="task-center-sidebar__count">
                            {historyModuleFilter === "all"
                              ? historyJobs.length
                              : filteredHistoryJobs.length}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
        {showJobsList ? (
          <section className="task-center-sidebar__section">
            {historyModules.length > 0 ? (
              <div className="task-center-sidebar__module-filter">
                <span className="task-center-sidebar__module-filter-label">
                  {t("taskCenter.history.filterModule")}
                </span>
                <div className="task-center-sidebar__module-chips" role="group">
                  <button
                    type="button"
                    className={`task-center-sidebar__module-chip${historyModuleFilter === "all" ? " is-active" : ""}`}
                    onClick={() => onHistoryModuleFilterChange("all")}
                  >
                    {t("taskCenter.history.filterModuleAll")}
                  </button>
                  {historyModules.map((mod) => (
                    <button
                      key={mod}
                      type="button"
                      className={`task-center-sidebar__module-chip${historyModuleFilter === mod ? " is-active" : ""}`}
                      onClick={() => onHistoryModuleFilterChange(mod)}
                    >
                      {mod}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <h4 className="task-center-sidebar__section-title">
              <span className="task-center-sidebar__section-label">
                {t("taskCenter.history.recentJobs")}
              </span>
              <span className="task-center-sidebar__count">{filteredHistoryJobs.length}</span>
            </h4>
            {jobItems.length > 0 ? (
              <SidebarListItems items={jobItems} />
            ) : (
              <p className="task-center-sidebar__section-empty">
                {historyJobs.length === 0
                  ? t("taskCenter.history.empty")
                  : t("taskCenter.history.filterNoMatch")}
              </p>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}

type ListItem = {
  id: string;
  title: string;
  subtitle?: string;
  badge?: { text: string; tone: string };
  tags?: ReactNode[];
  leading?: ReactNode;
  active: boolean;
  onClick: () => void;
};

function NavSection({
  title,
  icon,
  count,
  accent,
  items,
  emptyHint,
}: {
  title: string;
  icon: ReactNode;
  count: number;
  accent: string;
  items: ListItem[];
  emptyHint?: string;
}) {
  return (
    <section className={`task-center-sidebar__section task-center-sidebar__section--${accent}`}>
      <h4 className="task-center-sidebar__section-title">
        <span className="task-center-sidebar__section-icon" aria-hidden>
          {icon}
        </span>
        <span className="task-center-sidebar__section-label">{title}</span>
        <span className="task-center-sidebar__count">{count}</span>
      </h4>
      {items.length > 0 ? (
        <SidebarListItems items={items} />
      ) : emptyHint ? (
        <p className="task-center-sidebar__section-empty">{emptyHint}</p>
      ) : null}
    </section>
  );
}

function SidebarList({ empty, items }: { empty: string; items: ListItem[] }) {
  if (items.length === 0) {
    return (
      <div className="task-center-sidebar__empty">
        <span className="task-center-sidebar__empty-icon" aria-hidden>
          <IconInbox size={22} />
        </span>
        <p className="task-center-sidebar__empty-text">{empty}</p>
      </div>
    );
  }
  return (
    <div className="task-center-sidebar__sections">
      <section className="task-center-sidebar__section">
        <SidebarListItems items={items} />
      </section>
    </div>
  );
}

function SidebarListItems({ items }: { items: ListItem[] }) {
  return (
    <ul className="task-center-sidebar__list">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className={`task-center-sidebar__item${item.leading ? " task-center-sidebar__item--nav" : ""}${item.active ? " is-active" : ""}`}
            onClick={item.onClick}
            title={item.title}
            aria-current={item.active ? "true" : undefined}
          >
            <span className="task-center-sidebar__item-accent" aria-hidden />
            {item.leading ? (
              <span className="task-center-sidebar__item-leading" aria-hidden>
                {item.leading}
              </span>
            ) : null}
            <span className="task-center-sidebar__item-body">
              <span className="task-center-sidebar__item-row">
                <span className="task-center-sidebar__item-title">{item.title}</span>
                {item.badge ? (
                  <span
                    className={`task-center-sidebar__badge task-center-sidebar__badge--${item.badge.tone}`}
                  >
                    {item.badge.tone === "running" ? (
                      <span className="task-center-sidebar__pulse" aria-hidden />
                    ) : null}
                    {item.badge.text}
                  </span>
                ) : null}
              </span>
              {item.subtitle ? (
                <span className="task-center-sidebar__item-meta">{item.subtitle}</span>
              ) : null}
              {item.tags && item.tags.length > 0 ? (
                <span className="task-center-sidebar__item-tags">{item.tags}</span>
              ) : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
