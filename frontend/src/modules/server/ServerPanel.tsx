import { useMemo, useState } from "react";
import { DockWorkspace } from "../../components/dock";
import { ServerSidebar } from "../../components/workspace/ServerSidebar";
import { workspaceResources, getResourceById } from "../../lib/resourceRegistry";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useActionStore } from "../../stores/actionStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";

type ServerTab = "monitor" | "processes" | "services" | "logs";

const SERVER_TABS: ServerTab[] = ["monitor", "processes", "services", "logs"];

const services = [
  { name: "nginx.service", status: "active", desc: "反向代理与静态资源" },
  { name: "docker.service", status: "active", desc: "容器运行时" },
  { name: "postgresql.service", status: "active", desc: "数据库服务" },
  { name: "ml-worker.service", status: "failed", desc: "训练任务异常退出" },
];

const processes = [
  { pid: "1234", name: "nginx", cpu: "2.1%", mem: "45 MB", user: "www-data" },
  { pid: "5678", name: "python3", cpu: "89.2%", mem: "2.1 GB", user: "deploy" },
  { pid: "9012", name: "postgres", cpu: "5.4%", mem: "512 MB", user: "postgres" },
];

export function ServerPanel() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<ServerTab>("monitor");
  const activeResourceId = useWorkspaceStore((s) => s.activeResourceId);
  const activeResource = getResourceById(activeResourceId);
  const enqueueAction = useActionStore((s) => s.enqueueAction);
  const actions = useActionStore((s) => s.actions);

  const serverResources = useMemo(
    () => workspaceResources.filter((resource) => resource.type === "server" || resource.type === "ssh"),
    []
  );

  const serverActions = useMemo(
    () => actions.filter((action) => action.type === "server").slice(0, 4),
    [actions]
  );

  const topbarTabs = useMemo(
    () =>
      SERVER_TABS.map((tab) => ({
        id: tab,
        label: t(`server.tabs.${tab}`),
        active: activeTab === tab,
        icon: tab,
      })),
    [activeTab, t]
  );

  useTopbarTabs(topbarTabs, {
    onSelect: (id) => setActiveTab(id as ServerTab),
  }, { mode: "segment" });

  return (
    <DockWorkspace
      leftPreset="server"
      left={<ServerSidebar resources={serverResources} />}
      main={
        <div className="server-main">
          <div className="server-content">
            <div className="server-header">
              <div>
                <strong>{activeResource?.name ?? "staging-api"}</strong>
                <span>{t("server.toolbar.hint")}</span>
              </div>
              <button
                className="btn btn-primary btn-sm"
                onClick={() =>
                  enqueueAction({
                    type: "server",
                    title: t("server.actions.refresh"),
                    description: t("server.actions.refreshDesc"),
                    resourceId: activeResource?.id ?? "staging-api",
                    source: "用户",
                  })
                }
              >
                {t("server.refresh")}
              </button>
            </div>

            {activeTab === "monitor" && (
              <div className="monitor-grid">
                <div className="monitor-card">
                  <div className="monitor-label">
                    <span>{t("server.monitor.cpu")}</span>
                    <span className="badge badge-success">Normal</span>
                  </div>
                  <div className="monitor-value text-accent">23%</div>
                  <div className="monitor-bar">
                    <div className="monitor-bar-fill success" style={{ width: "23%" }} />
                  </div>
                  <div className="monitor-detail">4 cores · Intel Xeon · 2.40GHz</div>
                </div>
                <div className="monitor-card">
                  <div className="monitor-label">
                    <span>{t("server.monitor.memory")}</span>
                    <span className="badge badge-warn">78%</span>
                  </div>
                  <div className="monitor-value text-warn">6.2 GB</div>
                  <div className="monitor-bar">
                    <div className="monitor-bar-fill warn" style={{ width: "78%" }} />
                  </div>
                  <div className="monitor-detail">8 GB total · 1.8 GB available</div>
                </div>
                <div className="monitor-card">
                  <div className="monitor-label">
                    <span>{t("server.monitor.disk")}</span>
                    <span className="badge badge-success">54%</span>
                  </div>
                  <div className="monitor-value">54 GB</div>
                  <div className="monitor-bar">
                    <div className="monitor-bar-fill success" style={{ width: "54%" }} />
                  </div>
                  <div className="monitor-detail">100 GB total · 46 GB available</div>
                </div>
                <div className="monitor-card">
                  <div className="monitor-label">
                    <span>{t("server.monitor.network")}</span>
                    <span className="badge badge-accent">Active</span>
                  </div>
                  <div className="monitor-value text-success">2.4 MB/s</div>
                  <div className="monitor-bar">
                    <div className="monitor-bar-fill accent" style={{ width: "24%" }} />
                  </div>
                  <div className="monitor-detail">↑ 2.4 MB/s · ↓ 1.1 MB/s</div>
                </div>
              </div>
            )}

            {activeTab === "processes" && (
              <div className="process-list">
                <div className="list-header">
                  <span>PID</span>
                  <span>Name</span>
                  <span>CPU</span>
                  <span>Memory</span>
                  <span>User</span>
                  <span>{t("docker.list.actions")}</span>
                </div>
                {processes.map((proc) => (
                  <div key={proc.pid} className="process-row">
                    <span>{proc.pid}</span>
                    <span className="proc-name">{proc.name}</span>
                    <span className={proc.cpu.startsWith("8") ? "text-warn" : ""}>{proc.cpu}</span>
                    <span>{proc.mem}</span>
                    <span>{proc.user}</span>
                    <button type="button" className="btn btn-ghost btn-sm">{t("common.restart")}</button>
                  </div>
                ))}
              </div>
            )}

            {activeTab === "services" && (
              <div className="service-list">
                {services.map((service) => (
                  <div key={service.name} className="service-item">
                    <span className="svc-name">{service.name}</span>
                    <span className={`svc-status ${service.status === "active" ? "badge-success" : "badge-danger"}`}>
                      {service.status}
                    </span>
                    <span className="svc-desc">{service.desc}</span>
                    <div className="svc-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() =>
                          enqueueAction({
                            type: "server",
                            title: t("server.actions.restart", { name: service.name }),
                            description: t("server.actions.restartDesc", { name: service.name }),
                            command: `sudo systemctl restart ${service.name}`,
                            resourceId: activeResource?.id ?? "staging-api",
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
            )}

            {activeTab === "logs" && (
              <div className="log-viewer">
                <div className="log-line"><span className="log-ts">09:41:02</span> nginx: worker process started</div>
                <div className="log-line"><span className="log-ts">09:41:05</span> postgresql: checkpoint complete</div>
                <div className="log-line log-warn"><span className="log-ts">09:42:18</span> ml-worker: OOM killed process 5678</div>
                <div className="log-line"><span className="log-ts">09:43:01</span> docker: container nginx-proxy restarted</div>
              </div>
            )}
          </div>
        </div>
      }
      right={
        <div className="context-panel">
          <div className="panel-title">{t("server.context.title")}</div>
          <div className="context-card">
            <span className="context-label">{t("server.context.rules")}</span>
            <span>{t("server.context.rulesDesc")}</span>
          </div>
          <button
            className="btn btn-danger btn-sm"
            onClick={() =>
              enqueueAction({
                type: "server",
                title: t("server.actions.kill"),
                description: t("server.actions.killDesc"),
                command: "sudo kill -9 5678",
                resourceId: activeResource?.id ?? "staging-api",
                source: "AI",
              })
            }
          >
            {t("server.context.killConfirm")}
          </button>
        </div>
      }
      bottom={
        <div className="bottom-feed">
          <div className="panel-title">{t("server.feed.title")}</div>
          {serverActions.map((action) => (
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
