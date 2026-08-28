import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  enterEngineeringWorkspaceFullscreen,
  navigateToFeature,
} from "../../lib/workspaceNavigation";
import { isModuleOpen, useAppModuleStore } from "../../stores/appModuleStore";
import { MODULE_PATHS } from "../../lib/paths";
import { useI18n } from "../../i18n";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { AskAiComposer } from "../../components/ai/AskAiComposer";
import {
  askAiFromSurface,
  buildDashboardSuggestionChips,
} from "../../lib/ai/surfaces";
import { useLoopStore } from "../../stores/loopStore";
import { useAiStore } from "../../stores/aiStore";
import { showToast } from "../../stores/toastStore";
import { errorToString } from "../../lib/errorToString";
import { DashboardIcon } from "./DashboardIcon";
import { PluginHomeLaunchStrip } from "./PluginHomeLaunchStrip";
import { useDashboardData } from "./useDashboardData";

function SectionChevron() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  );
}

function SectionPlus() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function DashboardEmpty({ children }: { children: string }) {
  return <p className="home-board-empty">{children}</p>;
}

/**
 * 首页工作区「看板」：双列概览（最近工作区、快捷连接、任务、草稿 / 资源、容器、服务器）。
 */
export function HomeBoardView() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const {
    recentWorkspaces,
    quickConnect,
    activeTasks,
    drafts,
    resourceBars,
    containers,
    servers,
    containersLoading,
  } = useDashboardData();
  const findings = useLoopStore((s) => s.findings);
  const drawerOpen = useAiStore((s) => s.drawerOpen);
  useAppModuleStore((s) => s.modules);
  const [composerValue, setComposerValue] = useState("");
  const [sending, setSending] = useState(false);

  const suggestionChips = useMemo(() => {
    const openFindings = Object.values(findings)
      .filter((f) => f.status === "open" || f.status === "triaged" || f.status === "blocked")
      .slice(0, 5)
      .map((f) => ({
        id: f.id,
        title: f.title,
        summary: f.summary,
      }));
    return buildDashboardSuggestionChips({
      drafts: drafts.map((d) => ({ id: d.id, title: d.title })),
      tasks: activeTasks.map((task) => ({
        id: task.id,
        name: task.name,
        info: task.info,
      })),
      findings: openFindings,
      starters: [
        {
          id: "overview",
          label: t("ai.surfaces.starterOverview"),
          prompt: t("ai.surfaces.starterOverviewPrompt"),
        },
        {
          id: "health",
          label: t("ai.surfaces.starterHealth"),
          prompt: t("ai.surfaces.starterHealthPrompt"),
        },
        {
          id: "plan",
          label: t("ai.surfaces.starterPlan"),
          prompt: t("ai.surfaces.starterPlanPrompt"),
        },
      ],
      limit: 5,
    });
  }, [drafts, activeTasks, findings, t]);

  const go = useCallback(
    (path: string) => {
      navigateToFeature(path, navigate);
    },
    [navigate],
  );

  const openWorkspace = useCallback(
    (workspaceId: string) => {
      enterEngineeringWorkspaceFullscreen(workspaceId, navigate);
    },
    [navigate],
  );

  const openConnection = useCallback(
    (path: string, resourceId?: string) => {
      if (resourceId) {
        useWorkspaceStore.getState().selectResource(resourceId, path);
      }
      go(path);
    },
    [go],
  );

  const handleAskSubmit = useCallback(async (prompt: string) => {
    setSending(true);
    try {
      await askAiFromSurface({
        prompt,
        surface: "dashboard",
        newConversation: true,
      });
    } catch (e) {
      showToast(errorToString(e));
    } finally {
      setSending(false);
    }
  }, []);

  const taskBadge = (kind: "running" | "queued" | "blocked") => {
    if (kind === "running") {
      return <span className="badge badge-accent">{t("dashboard.running")}</span>;
    }
    if (kind === "blocked") {
      return <span className="badge badge-warn">{t("dashboard.blocked")}</span>;
    }
    return <span className="badge badge-warn">{t("dashboard.queued")}</span>;
  };

  return (
    <div className="home-board-view dashboard">
      <div className="home-board-body">
        <div className="dash-grid">
          <div className="dash-col">
            <section>
              <div className="dash-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
                {t("dashboard.recentWorkspaces")}
                <button
                  type="button"
                  className="qa-btn home-board-qa-end"
                  onClick={() => go(MODULE_PATHS.terminal)}
                >
                  <SectionPlus />
                  {t("dashboard.new")}
                </button>
              </div>
              <div className="home-board-stack">
                {recentWorkspaces.length === 0 ? (
                  <DashboardEmpty>{t("dashboard.empty.workspaces")}</DashboardEmpty>
                ) : (
                  recentWorkspaces.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="ws-card"
                      onClick={() => openWorkspace(item.id)}
                    >
                      <div
                        className="ws-icon"
                        style={{ background: item.iconBg, color: item.iconColor }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                          <DashboardIcon kind={item.iconKind} />
                        </svg>
                      </div>
                      <div className="ws-body">
                        <div className="ws-name">{item.name}</div>
                        <div className="ws-meta">
                          {item.meta.map((part) => (
                            <span key={part}>{part}</span>
                          ))}
                        </div>
                      </div>
                      <span className="btn btn-primary btn-sm">{t("dashboard.open")}</span>
                    </button>
                  ))
                )}
              </div>
            </section>

            <section>
              <div className="dash-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                {t("dashboard.quickConnect")}
              </div>
              <div className="qc-grid">
                {quickConnect.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="qc-btn"
                    onClick={() => openConnection(item.path, item.resourceId)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                      <DashboardIcon kind={item.iconKind} />
                    </svg>
                    <span className="qc-label">{item.label}</span>
                    <span className="qc-hint">{item.hint}</span>
                  </button>
                ))}
              </div>
            </section>

            <section>
              <div className="dash-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                </svg>
                {t("dashboard.activeTasks")}
                {isModuleOpen("workflow") && (
                  <button
                    type="button"
                    className="qa-btn home-board-qa-end"
                    onClick={() => go(MODULE_PATHS.workflow)}
                  >
                    <SectionChevron />
                    {t("dashboard.viewAll")}
                  </button>
                )}
              </div>
              <div className="home-board-task-list">
                {activeTasks.length === 0 ? (
                  <DashboardEmpty>{t("dashboard.empty.tasks")}</DashboardEmpty>
                ) : (
                  activeTasks.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      className="task-row home-board-task-row"
                      onClick={() => go(task.path)}
                    >
                      <span className="task-dot" style={{ background: task.dot }} />
                      <span className="task-name">{task.name}</span>
                      <span className="task-info">{task.info}</span>
                      {taskBadge(task.badge)}
                    </button>
                  ))
                )}
              </div>
            </section>

            <section>
              <div className="dash-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <path d="M14 2v6h6" />
                </svg>
                {t("dashboard.draftBox")}
                {drafts.length > 0 ? (
                  <span className="badge badge-warn home-board-qa-end">{drafts.length}</span>
                ) : null}
              </div>
              <div className="home-board-alert-stack">
                {drafts.length === 0 ? (
                  <DashboardEmpty>{t("dashboard.empty.drafts")}</DashboardEmpty>
                ) : (
                  drafts.map((draft) => (
                    <button
                      key={draft.id}
                      type="button"
                      className="alert-card home-board-draft-row"
                      onClick={() => go(draft.path)}
                    >
                      <span className="alert-dot" style={{ background: draft.dot }} />
                      <div className="alert-body">
                        <div className="alert-title">{draft.title}</div>
                        <div className="alert-time">{draft.time}</div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </section>
          </div>

          <div className="dash-col">
            <section>
              <div className="dash-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                </svg>
                {t("dashboard.systemResources")}
              </div>
              <div className="home-board-resource-panel">
                {resourceBars.length === 0 ? (
                  <DashboardEmpty>{t("dashboard.empty.resources")}</DashboardEmpty>
                ) : (
                  resourceBars.map((bar) => (
                    <div key={bar.id} className="res-bar-group">
                      <div className="res-bar-label">
                        <span>{bar.label}</span>
                        <span>{bar.value}</span>
                      </div>
                      <div className="res-bar">
                        <div
                          className="res-bar-fill"
                          style={{ width: bar.width, background: bar.color }}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section>
              <div className="dash-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <rect x="2" y="7" width="6" height="5" rx="1" />
                  <rect x="10" y="7" width="6" height="5" rx="1" />
                  <rect x="18" y="7" width="4" height="5" rx="1" />
                  <rect x="6" y="2" width="6" height="5" rx="1" />
                  <path d="M2 17h20c0 2.76-4.48 5-10 5S2 19.76 2 17z" />
                </svg>
                {t("dashboard.containers")}
                <button
                  type="button"
                  className="qa-btn home-board-qa-end"
                  onClick={() => go(MODULE_PATHS.docker)}
                >
                  <SectionChevron />
                  {t("dashboard.viewAll")}
                </button>
              </div>
              <div className="docker-mini-grid">
                {containersLoading ? (
                  <DashboardEmpty>{t("dashboard.empty.loading")}</DashboardEmpty>
                ) : containers.length === 0 ? (
                  <DashboardEmpty>{t("dashboard.empty.containers")}</DashboardEmpty>
                ) : (
                  containers.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="docker-mini-item"
                      onClick={() => go(MODULE_PATHS.docker)}
                    >
                      <span className="dm-dot" style={{ background: item.dot }} />
                      <span className="dm-name">{item.name}</span>
                      <span className="dm-status">{item.status}</span>
                    </button>
                  ))
                )}
              </div>
            </section>

            <section>
              <div className="dash-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <rect x="2" y="2" width="20" height="8" rx="2" />
                  <rect x="2" y="14" width="20" height="8" rx="2" />
                  <circle cx="6" cy="6" r="1" fill="currentColor" />
                  <circle cx="6" cy="18" r="1" fill="currentColor" />
                </svg>
                {t("dashboard.servers")}
                <button
                  type="button"
                  className="qa-btn home-board-qa-end"
                  onClick={() => go(MODULE_PATHS.server)}
                >
                  <SectionChevron />
                  {t("dashboard.viewAll")}
                </button>
              </div>
              <div className="conn-grid">
                {servers.length === 0 ? (
                  <DashboardEmpty>{t("dashboard.empty.servers")}</DashboardEmpty>
                ) : (
                  servers.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="conn-item"
                      onClick={() => openConnection(item.path, item.resourceId)}
                    >
                      <span className="conn-dot" style={{ background: item.dot }} />
                      <span className="conn-name">{item.name}</span>
                      <span className="conn-type">{item.type}</span>
                    </button>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
        <PluginHomeLaunchStrip />
        <section className="home-board-ai" aria-label={t("ai.surfaces.askAi")}>
          {drawerOpen ? (
            <button
              type="button"
              className="home-board-ai__handoff"
              onClick={() => useAiStore.getState().closeDrawer()}
            >
              <span className="home-board-ai__handoff-title">
                {t("ai.surfaces.handedOffTitle")}
              </span>
              <span className="home-board-ai__handoff-hint">
                {t("ai.surfaces.handedOffCollapseHint")}
              </span>
            </button>
          ) : (
            <>
              {suggestionChips.length > 0 ? (
                <div
                  className="home-board-ai__chips"
                  role="list"
                  aria-label={t("ai.surfaces.suggestions")}
                >
                  {suggestionChips.map((chip) => (
                    <button
                      key={chip.id}
                      type="button"
                      role="listitem"
                      className="home-board-ai__chip"
                      data-kind={chip.kind}
                      onClick={() => setComposerValue(chip.prompt)}
                    >
                      <span className="home-board-ai__chip-label">{chip.label}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <AskAiComposer
                value={composerValue}
                onChange={setComposerValue}
                disabled={sending}
                onSubmit={handleAskSubmit}
                placeholder={t("ai.surfaces.homePlaceholder")}
              />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
