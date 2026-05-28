import { useMemo, useState } from "react";
import { DockWorkspace } from "../../components/dock";
import { workspaceResources, getResourceById } from "../../lib/resourceRegistry";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useActionStore } from "../../stores/actionStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";

const containers = [
  { name: "nginx-proxy", image: "nginx:1.25-alpine", statusKey: "running" as const, cpu: "34%", ports: "80 / 443" },
  { name: "app-backend", image: "app/api:2.1.0", statusKey: "running" as const, cpu: "12%", ports: "8080" },
  { name: "redis-cache", image: "redis:7-alpine", statusKey: "running" as const, cpu: "2%", ports: "6379" },
  { name: "old-worker", image: "app/worker:1.8.0", statusKey: "stopped" as const, cpu: "-", ports: "-" },
];

type Filter = "all" | "running" | "stopped";

export function DockerPanel() {
  const { t } = useI18n();
  const [filter, setFilter] = useState<Filter>("all");
  const activeResourceId = useWorkspaceStore((s) => s.activeResourceId);
  const selectResource = useWorkspaceStore((s) => s.selectResource);
  const activeResource = getResourceById(activeResourceId);
  const enqueueAction = useActionStore((s) => s.enqueueAction);
  const actions = useActionStore((s) => s.actions);

  const dockerResources = useMemo(
    () => workspaceResources.filter((resource) => resource.type === "docker"),
    []
  );

  const topbarTabs = useMemo(
    () =>
      dockerResources.map((resource) => ({
        id: resource.id,
        label: resource.name,
        active: resource.id === (activeResourceId ?? dockerResources[0]?.id),
      })),
    [dockerResources, activeResourceId]
  );

  useTopbarTabs(topbarTabs, {
    onSelect: (id) => selectResource(id),
  }, { mode: "connection", showAddTab: true, addTabTitle: t("shell.topbar.addHost") });

  const filteredContainers = useMemo(() => {
    if (filter === "all") return containers;
    return containers.filter((c) => c.statusKey === filter);
  }, [filter]);

  const dockerActions = useMemo(
    () => actions.filter((action) => action.type === "docker").slice(0, 4),
    [actions]
  );

  return (
    <DockWorkspace
      main={
        <div className="docker-layout">
          <div className="docker-stats">
            <div className="docker-stat">
              <div className="stat-info">
                <span className="stat-val">3</span>
                <span className="stat-label">{t("docker.stats.running")}</span>
              </div>
            </div>
            <div className="docker-stat">
              <div className="stat-info">
                <span className="stat-val">1</span>
                <span className="stat-label">{t("docker.stats.stopped")}</span>
              </div>
            </div>
            <div className="docker-stat">
              <div className="stat-info">
                <span className="stat-val">12</span>
                <span className="stat-label">{t("docker.stats.images")}</span>
              </div>
            </div>
            <div className="docker-stat">
              <div className="stat-info">
                <span className="stat-val">3</span>
                <span className="stat-label">{t("docker.stats.volumes")}</span>
              </div>
            </div>
            <button
              className="btn btn-primary btn-sm"
              style={{ marginLeft: "auto", alignSelf: "center" }}
              onClick={() =>
                enqueueAction({
                  type: "docker",
                  title: t("docker.actions.refresh"),
                  description: t("docker.actions.refreshDesc"),
                  resourceId: activeResource?.id ?? "docker-local",
                  source: "用户",
                })
              }
            >
              {t("common.refresh")}
            </button>
          </div>

          <div className="docker-filters">
            {(["all", "running", "stopped"] as const).map((key) => (
              <button
                key={key}
                type="button"
                className={`filter-tab${filter === key ? " active" : ""}`}
                onClick={() => setFilter(key)}
              >
                {t(`docker.filters.${key}`)}
                <span className="count">
                  {key === "all"
                    ? containers.length
                    : containers.filter((c) => c.statusKey === key).length}
                </span>
              </button>
            ))}
          </div>

          <div className="container-list">
            <div className="list-header">
              <span>{t("docker.list.container")}</span>
              <span>{t("docker.list.status")}</span>
              <span>{t("docker.list.cpu")}</span>
              <span>{t("docker.list.ports")}</span>
              <span>{t("docker.list.actions")}</span>
            </div>
            {filteredContainers.map((container) => (
              <div key={container.name} className="container-card">
                <div className="container-name">
                  <div className="container-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                      <rect x="2" y="7" width="6" height="5" rx="1" />
                      <rect x="10" y="7" width="6" height="5" rx="1" />
                    </svg>
                  </div>
                  <div>
                    <div className="container-title">{container.name}</div>
                    <div className="container-image">{container.image}</div>
                  </div>
                </div>
                <div className="container-status">
                  <span className={`status-dot ${container.statusKey === "running" ? "online" : "offline"}`} />
                  {t(`docker.status.${container.statusKey}`)}
                </div>
                <span>{container.cpu}</span>
                <span>{container.ports}</span>
                <div className="container-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      enqueueAction({
                        type: "docker",
                        title: t("docker.actions.restart", { name: container.name }),
                        description: t("docker.actions.restartDesc", { name: container.name }),
                        command: `docker restart ${container.name}`,
                        resourceId: activeResource?.id ?? "docker-local",
                        source: "用户",
                      })
                    }
                  >
                    {t("common.restart")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      }
      right={
        <div className="context-panel">
          <div className="panel-title">{t("docker.context.title")}</div>
          <div className="context-card">
            <span className="context-label">{t("docker.context.linkage")}</span>
            <span>{t("docker.context.linkageDesc")}</span>
          </div>
          <button
            className="btn btn-danger btn-sm"
            onClick={() =>
              enqueueAction({
                type: "docker",
                title: t("docker.actions.prune"),
                description: t("docker.actions.pruneDesc"),
                command: "docker system prune -af",
                resourceId: activeResource?.id ?? "docker-local",
                source: "AI",
              })
            }
          >
            {t("docker.context.pruneConfirm")}
          </button>
        </div>
      }
      bottom={
        <div className="bottom-feed">
          <div className="panel-title">{t("docker.feed.title")}</div>
          {dockerActions.map((action) => (
            <div key={action.id} className="feed-row">
              <span>{action.title}</span>
              <span>{action.status}</span>
            </div>
          ))}
        </div>
      }
    />
  );
}
