import { useNavigate } from "react-router-dom";
import { workspaceResources, type ResourceType, type WorkspaceResource } from "../../lib/resourceRegistry";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useActionStore } from "../../stores/actionStore";
import { useI18n } from "../../i18n";

const RESOURCE_ICON: Record<ResourceType, { bg: string; color: string; path: string }> = {
  terminal: {
    bg: "var(--success-soft)",
    color: "var(--success)",
    path: "M4 17l6-6-6-6 M12 19h8",
  },
  database: {
    bg: "var(--warn-soft)",
    color: "var(--warn)",
    path: "M12 5a9 3 0 110 6 9 3 0 110-6z M3 5v14c0 3 4 5 9 5s9-2 9-5V5",
  },
  ssh: {
    bg: "var(--accent-soft)",
    color: "var(--accent)",
    path: "M2 3h20v14H2z M8 21h8 M12 17v4",
  },
  docker: {
    bg: "var(--accent-soft)",
    color: "var(--accent)",
    path: "M2 7h6v5H2z M10 7h6v5h-6z M18 7h4v5h-4z",
  },
  server: {
    bg: "var(--success-soft)",
    color: "var(--success)",
    path: "M2 2h20v8H2z M2 14h20v8H2z",
  },
  workspace: {
    bg: "var(--surface)",
    color: "var(--muted)",
    path: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z",
  },
  protocol: {
    bg: "var(--surface)",
    color: "var(--muted)",
    path: "M22 12h-4l-3 9L9 3l-3 9H2",
  },
};

const QUICK_LINKS: { path: string; type: ResourceType; label: string; hint: string }[] = [
  { path: "/terminal", type: "terminal", label: "Terminal", hint: "Local" },
  { path: "/ssh", type: "ssh", label: "prod-web-01", hint: "SSH" },
  { path: "/database", type: "database", label: "prod-db", hint: "PostgreSQL" },
  { path: "/docker", type: "docker", label: "Containers", hint: "Docker" },
];

const RESOURCE_BARS = [
  { name: "prod-web-01 — CPU", value: "23%", width: "23%", color: "var(--success)" },
  { name: "prod-web-01 — Memory", value: "1.0 GB / 4 GB", width: "25%", color: "var(--success)" },
  { name: "prod-db — CPU", value: "67%", width: "67%", color: "var(--warn)" },
  { name: "prod-db — Memory", value: "3.2 GB / 4 GB", width: "80%", color: "var(--warn)" },
  { name: "staging-worker — Disk", value: "92% · WAL logs", width: "92%", color: "var(--danger)" },
  { name: "staging-api — CPU", value: "12%", width: "12%", color: "var(--success)" },
];

const DOCKER_MINI = [
  { name: "nginx-proxy", status: "Up 3d", dot: "var(--success)" },
  { name: "app-backend", status: "Up 3d", dot: "var(--success)" },
  { name: "redis-cache", status: "Up 3d", dot: "var(--success)" },
  { name: "postgres-main", status: "Up 3d", dot: "var(--success)" },
  { name: "celery-worker", status: "Restart", dot: "var(--warn)" },
  { name: "redis-staging", status: "Stopped", dot: "var(--meta)" },
];

function draftDot(risk: string) {
  if (risk === "high" || risk === "critical") return "var(--danger)";
  if (risk === "medium") return "var(--accent)";
  return "var(--success)";
}

function WsIcon({ type }: { type: ResourceType }) {
  const icon = RESOURCE_ICON[type];
  return (
    <div className="ws-icon" style={{ background: icon.bg, color: icon.color }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d={icon.path} />
      </svg>
    </div>
  );
}

export function Dashboard() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const selectResource = useWorkspaceStore((s) => s.selectResource);
  const setActivePath = useWorkspaceStore((s) => s.setActivePath);
  const actions = useActionStore((s) => s.actions);

  const openResource = (resource: WorkspaceResource) => {
    selectResource(resource.id, resource.modulePath);
    setActivePath(resource.modulePath);
    navigate(resource.modulePath);
  };

  const recentResources = workspaceResources.slice(0, 3);
  const runningActions = actions.filter((a) => a.status === "running");
  const blockedActions = actions.filter((a) => a.status === "blocked");
  const draftActions = blockedActions.length > 0 ? blockedActions : actions.slice(0, 3);

  return (
    <div className="dashboard">
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div className="dash-grid">
          <div className="dash-col">
            <div>
              <div className="dash-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
                {t("dashboard.recentWorkspaces")}
                <button type="button" className="qa-btn" style={{ marginLeft: "auto" }} onClick={() => navigate("/terminal")}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  {t("dashboard.new")}
                </button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
                {recentResources.map((resource) => (
                  <div
                    key={resource.id}
                    className="ws-card"
                    onClick={() => openResource(resource)}
                    onKeyDown={(e) => e.key === "Enter" && openResource(resource)}
                    role="button"
                    tabIndex={0}
                  >
                    <WsIcon type={resource.type} />
                    <div className="ws-body">
                      <div className="ws-name">{resource.name}</div>
                      <div className="ws-meta">
                        <span>{t(`resourceType.${resource.type}`)}</span>
                        <span>{resource.subtitle}</span>
                      </div>
                    </div>
                    <button type="button" className="btn btn-primary btn-sm">{t("dashboard.open")}</button>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="dash-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                {t("dashboard.quickConnect")}
              </div>
              <div className="qc-grid">
                {QUICK_LINKS.map((link) => {
                  const icon = RESOURCE_ICON[link.type];
                  return (
                    <button
                      key={link.path}
                      type="button"
                      className="qc-btn"
                      onClick={() => navigate(link.path)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <path d={icon.path} />
                      </svg>
                      <span className="qc-label">{link.label}</span>
                      <span className="qc-hint">{link.hint}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="dash-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                </svg>
                {t("dashboard.activeTasks")}
                <button type="button" className="qa-btn" style={{ marginLeft: "auto" }} onClick={() => navigate("/tasks")}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                  {t("dashboard.viewAll")}
                </button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                {(runningActions.length > 0 ? runningActions : actions).slice(0, 3).map((action) => (
                  <div key={action.id} className="task-row">
                    <span className="task-dot" style={{ background: "var(--accent)" }} />
                    <span className="task-name">{action.title}</span>
                    <span className="task-info">{action.resourceName ?? action.status}</span>
                    <span className="badge badge-accent">{t("dashboard.running")}</span>
                  </div>
                ))}
                {actions.length === 0 && (
                  <div className="empty-state compact">{t("common.noResources")}</div>
                )}
              </div>
            </div>

            <div>
              <div className="dash-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <path d="M14 2v6h6" />
                </svg>
                {t("dashboard.draftBox")}
                {blockedActions.length > 0 && (
                  <span className="badge badge-warn" style={{ marginLeft: "auto" }}>
                    {blockedActions.length}
                  </span>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
                {draftActions.map((action) => (
                  <div key={action.id} className="alert-card">
                    <span className="alert-dot" style={{ background: draftDot(action.risk) }} />
                    <div className="alert-body">
                      <div className="alert-title">{action.title}</div>
                      <div className="alert-time">{action.description}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="dash-col">
            <div>
              <div className="dash-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                </svg>
                {t("dashboard.systemResources")}
              </div>
              <div
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--r-md)",
                  padding: "var(--sp-3) var(--sp-4)",
                }}
              >
                {RESOURCE_BARS.map((bar) => (
                  <div key={bar.name} className="res-bar-group">
                    <div className="res-bar-label">
                      <span>{bar.name}</span>
                      <span>{bar.value}</span>
                    </div>
                    <div className="res-bar">
                      <div className="res-bar-fill" style={{ width: bar.width, background: bar.color }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="dash-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="7" width="6" height="5" rx="1" />
                  <rect x="10" y="7" width="6" height="5" rx="1" />
                  <rect x="18" y="7" width="4" height="5" rx="1" />
                </svg>
                {t("dashboard.containers")}
                <button type="button" className="qa-btn" style={{ marginLeft: "auto" }} onClick={() => navigate("/docker")}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                  {t("dashboard.viewAll")}
                </button>
              </div>
              <div className="docker-mini-grid">
                {DOCKER_MINI.map((item) => (
                  <button key={item.name} type="button" className="docker-mini-item" onClick={() => navigate("/docker")}>
                    <span className="dm-dot" style={{ background: item.dot }} />
                    <span className="dm-name">{item.name}</span>
                    <span className="dm-status">{item.status}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="dash-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="2" width="20" height="8" rx="2" />
                  <rect x="2" y="14" width="20" height="8" rx="2" />
                </svg>
                {t("dashboard.servers")}
                <button type="button" className="qa-btn" style={{ marginLeft: "auto" }} onClick={() => navigate("/server")}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                  {t("dashboard.viewAll")}
                </button>
              </div>
              <div className="empty-state compact">{t("common.noResources")}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
