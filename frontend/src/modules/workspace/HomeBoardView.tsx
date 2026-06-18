import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { navigateToFeature } from "../../lib/workspaceNavigation";
import { useI18n } from "../../i18n";

const RECENT_WORKSPACES = [
  {
    path: "/terminal",
    name: "prod-web-01 Terminal",
    meta: ["2 tabs, 1 split", "10 min ago"],
    iconBg: "color-mix(in oklch, var(--success) 15%, transparent)",
    iconColor: "var(--success)",
    icon: (
      <>
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </>
    ),
  },
  {
    path: "/database",
    name: "prod-db-master Query",
    meta: ["3 queries saved", "1h ago"],
    iconBg: "color-mix(in oklch, var(--warn) 15%, transparent)",
    iconColor: "var(--warn)",
    icon: (
      <>
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3" />
        <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      </>
    ),
  },
  {
    path: "/ssh",
    name: "staging-api SSH",
    meta: ["SFTP active", "3h ago"],
    iconBg: "color-mix(in oklch, var(--accent) 15%, transparent)",
    iconColor: "var(--accent)",
    icon: (
      <>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </>
    ),
  },
] as const;

const QUICK_CONNECT = [
  {
    path: "/terminal",
    label: "Terminal",
    hint: "Local",
    icon: (
      <>
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </>
    ),
  },
  {
    path: "/ssh",
    label: "prod-web-01",
    hint: "SSH",
    icon: (
      <>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </>
    ),
  },
  {
    path: "/database",
    label: "prod-db",
    hint: "PostgreSQL",
    icon: (
      <>
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3" />
        <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      </>
    ),
  },
  {
    path: "/docker",
    label: "Containers",
    hint: "Docker",
    icon: (
      <>
        <rect x="2" y="7" width="6" height="5" rx="1" />
        <rect x="10" y="7" width="6" height="5" rx="1" />
      </>
    ),
  },
  {
    path: "/files",
    label: "文件管理",
    hint: "FTP / S3",
    icon: <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />,
  },
] as const;

const ACTIVE_TASKS = [
  {
    dot: "var(--accent)",
    name: "Upload backup to S3",
    info: "67% · ETA 1m32s",
    badge: "running" as const,
  },
  {
    dot: "var(--warn)",
    name: "Pull nginx:1.25-alpine",
    info: "34% · Layer 3/7",
    badge: "running" as const,
  },
  {
    dot: "var(--meta)",
    name: "Daily server patrol",
    info: "08:00 daily",
    badge: "queued" as const,
  },
] as const;

const DRAFTS = [
  {
    dot: "var(--danger)",
    title: "Block IP 45.33.32.0/24",
    time: "nginx deny · prod-web-01",
  },
  {
    dot: "var(--accent)",
    title: "CREATE INDEX idx_orders_status",
    time: "Composite index · prod-db",
  },
  {
    dot: "var(--success)",
    title: "docker system prune -af",
    time: "Clean resources · staging-api",
  },
] as const;

const RESOURCE_BARS = [
  { label: "prod-web-01 — CPU", value: "23%", width: "23%", color: "var(--success)" },
  { label: "prod-web-01 — Memory", value: "1.0 GB / 4 GB", width: "25%", color: "var(--success)" },
  { label: "prod-db — CPU", value: "67%", width: "67%", color: "var(--warn)" },
  { label: "prod-db — Memory", value: "3.2 GB / 4 GB", width: "80%", color: "var(--warn)" },
  { label: "staging-worker — Disk", value: "92% · WAL logs", width: "92%", color: "var(--danger)" },
  { label: "staging-api — CPU", value: "12%", width: "12%", color: "var(--success)" },
] as const;

const CONTAINERS = [
  { dot: "var(--success)", name: "nginx-proxy", status: "Up 3d" },
  { dot: "var(--success)", name: "app-backend", status: "Up 3d" },
  { dot: "var(--success)", name: "redis-cache", status: "Up 3d" },
  { dot: "var(--success)", name: "postgres-main", status: "Up 3d" },
  { dot: "var(--warn)", name: "celery-worker", status: "Restart" },
  { dot: "var(--meta)", name: "redis-staging", status: "Stopped" },
] as const;

const SERVERS = [
  { dot: "var(--success)", name: "prod-web-01", type: "23%" },
  { dot: "var(--success)", name: "prod-web-02", type: "18%" },
  { dot: "var(--warn)", name: "prod-db", type: "67%" },
  { dot: "var(--success)", name: "staging-api", type: "12%" },
  { dot: "var(--danger)", name: "staging-wk", type: "Disk 92%" },
  { dot: "var(--success)", name: "dev-local", type: "8%" },
] as const;

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

/**
 * 首页工作区「看板」：双列概览（最近工作区、快捷连接、任务、草稿 / 资源、容器、服务器）。
 * 布局与 design/index.html 首页 Dashboard 对齐；数据为演示占位，后续可接真实聚合 API。
 */
export function HomeBoardView() {
  const { t } = useI18n();
  const navigate = useNavigate();

  const go = useCallback(
    (path: string) => {
      navigateToFeature(path, navigate);
    },
    [navigate],
  );

  const taskBadge = (kind: "running" | "queued") => {
    if (kind === "running") {
      return <span className="badge badge-accent">{t("dashboard.running")}</span>;
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
                  onClick={() => go("/terminal")}
                >
                  <SectionPlus />
                  {t("dashboard.new")}
                </button>
              </div>
              <div className="home-board-stack">
                {RECENT_WORKSPACES.map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    className="ws-card"
                    onClick={() => go(item.path)}
                  >
                    <div
                      className="ws-icon"
                      style={{ background: item.iconBg, color: item.iconColor }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                        {item.icon}
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
                ))}
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
                {QUICK_CONNECT.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    className="qc-btn"
                    onClick={() => go(item.path)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                      {item.icon}
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
                <button
                  type="button"
                  className="qa-btn home-board-qa-end"
                  onClick={() => go("/workflow")}
                >
                  <SectionChevron />
                  {t("dashboard.viewAll")}
                </button>
              </div>
              <div className="home-board-task-list">
                {ACTIVE_TASKS.map((task) => (
                  <div key={task.name} className="task-row">
                    <span className="task-dot" style={{ background: task.dot }} />
                    <span className="task-name">{task.name}</span>
                    <span className="task-info">{task.info}</span>
                    {taskBadge(task.badge)}
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="dash-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <path d="M14 2v6h6" />
                </svg>
                {t("dashboard.draftBox")}
                <span className="badge badge-warn home-board-qa-end">{DRAFTS.length}</span>
              </div>
              <div className="home-board-alert-stack">
                {DRAFTS.map((draft) => (
                  <div key={draft.title} className="alert-card">
                    <span className="alert-dot" style={{ background: draft.dot }} />
                    <div className="alert-body">
                      <div className="alert-title">{draft.title}</div>
                      <div className="alert-time">{draft.time}</div>
                    </div>
                  </div>
                ))}
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
                {RESOURCE_BARS.map((bar) => (
                  <div key={bar.label} className="res-bar-group">
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
                ))}
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
                  onClick={() => go("/docker")}
                >
                  <SectionChevron />
                  {t("dashboard.viewAll")}
                </button>
              </div>
              <div className="docker-mini-grid">
                {CONTAINERS.map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    className="docker-mini-item"
                    onClick={() => go("/docker")}
                  >
                    <span className="dm-dot" style={{ background: item.dot }} />
                    <span className="dm-name">{item.name}</span>
                    <span className="dm-status">{item.status}</span>
                  </button>
                ))}
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
                  onClick={() => go("/server")}
                >
                  <SectionChevron />
                  {t("dashboard.viewAll")}
                </button>
              </div>
              <div className="conn-grid">
                {SERVERS.map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    className="conn-item"
                    onClick={() => go("/server")}
                  >
                    <span className="conn-dot" style={{ background: item.dot }} />
                    <span className="conn-name">{item.name}</span>
                    <span className="conn-type">{item.type}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
