import { useEffect, useMemo, useState } from "react";
import { ServerSidebar } from "../../components/workspace/ServerSidebar";
import { getServerMonitorResources, type WorkspaceResource } from "../../lib/resourceRegistry";
import { useWorkspaceResources } from "../../stores/connectionStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useActionStore } from "../../stores/actionStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";

type ServerTab = "monitor" | "processes" | "services" | "logs";

const SERVER_TABS: ServerTab[] = ["monitor", "processes", "services", "logs"];

const SERVER_PROFILES: Record<string, {
  cpu: string;
  cpuLabel: string;
  memory: string;
  memoryRatio: string;
  disk: string;
  diskRatio: string;
  network: string;
  networkDetail: string;
  chart: number[];
  info: {
    system: Array<[string, string]>;
    runtime: Array<[string, string]>;
  };
  processes: Array<{ pid: string; name: string; cpu: string; mem: string; user: string }>;
  services: Array<{ name: string; status: "active" | "failed" | "degraded"; desc: string }>;
  logs: Array<{ time: string; level: "info" | "warn" | "error"; message: string }>;
}> = {
  "staging-api": {
    cpu: "67.1%",
    cpuLabel: "Busy",
    memory: "6.2 GB",
    memoryRatio: "78%",
    disk: "92 GB",
    diskRatio: "92%",
    network: "2.4 MB/s",
    networkDetail: "↑ 2.4 MB/s · ↓ 1.1 MB/s",
    chart: [42, 48, 54, 50, 61, 68, 72, 64, 58, 66, 70, 62, 59, 63, 67, 61],
    info: {
      system: [["OS", "Ubuntu 22.04"], ["Kernel", "6.8.0"], ["Hostname", "staging-api"], ["Region", "ap-southeast-1a"]],
      runtime: [["Docker", "25.0.3"], ["Node", "20.15.1"], ["Python", "3.12.2"], ["Last deploy", "今天 09:12"]],
    },
    processes: [
      { pid: "1234", name: "nginx", cpu: "2.1%", mem: "45 MB", user: "www-data" },
      { pid: "5678", name: "python3", cpu: "89.2%", mem: "2.1 GB", user: "deploy" },
      { pid: "9012", name: "postgres", cpu: "5.4%", mem: "512 MB", user: "postgres" },
      { pid: "9211", name: "celery", cpu: "27.4%", mem: "384 MB", user: "deploy" },
    ],
    services: [
      { name: "nginx.service", status: "active", desc: "反向代理与静态资源" },
      { name: "docker.service", status: "active", desc: "容器运行时" },
      { name: "postgresql.service", status: "active", desc: "数据库服务" },
      { name: "ml-worker.service", status: "failed", desc: "训练任务异常退出" },
    ],
    logs: [
      { time: "09:41:02", level: "info", message: "nginx: worker process started" },
      { time: "09:41:05", level: "info", message: "postgresql: checkpoint complete" },
      { time: "09:42:18", level: "warn", message: "ml-worker: OOM killed process 5678" },
      { time: "09:43:01", level: "info", message: "docker: container nginx-proxy restarted" },
    ],
  },
  "prod-web-01": {
    cpu: "23.4%",
    cpuLabel: "Normal",
    memory: "6.2 GB",
    memoryRatio: "39%",
    disk: "54 GB",
    diskRatio: "54%",
    network: "1.8 MB/s",
    networkDetail: "↑ 1.8 MB/s · ↓ 0.9 MB/s",
    chart: [18, 22, 24, 21, 19, 25, 28, 23, 21, 17, 19, 24, 27, 26, 22, 20],
    info: {
      system: [["OS", "Ubuntu 22.04"], ["Kernel", "6.8.0"], ["Hostname", "prod-web-01"], ["Region", "ap-southeast-1a"]],
      runtime: [["Docker", "25.0.3"], ["Nginx", "1.25"], ["Node", "20.15.1"], ["Last deploy", "昨天 17:42"]],
    },
    processes: [
      { pid: "1123", name: "nginx", cpu: "1.4%", mem: "38 MB", user: "www-data" },
      { pid: "5122", name: "node", cpu: "18.2%", mem: "420 MB", user: "deploy" },
      { pid: "7342", name: "docker-proxy", cpu: "0.8%", mem: "16 MB", user: "root" },
    ],
    services: [
      { name: "nginx.service", status: "active", desc: "站点入口与 TLS" },
      { name: "docker.service", status: "active", desc: "容器运行时" },
      { name: "cron.service", status: "active", desc: "定时任务" },
    ],
    logs: [
      { time: "09:14:02", level: "warn", message: "rate limit triggered for 45.33.32.x" },
      { time: "09:13:46", level: "info", message: "200 GET /api/users 8ms" },
      { time: "09:12:01", level: "warn", message: "upstream connection timeout" },
    ],
  },
  default: {
    cpu: "18.0%",
    cpuLabel: "Normal",
    memory: "2.4 GB",
    memoryRatio: "30%",
    disk: "31 GB",
    diskRatio: "31%",
    network: "0.6 MB/s",
    networkDetail: "↑ 0.6 MB/s · ↓ 0.2 MB/s",
    chart: [12, 16, 14, 18, 21, 19, 16, 18, 20, 17, 15, 14, 16, 19, 21, 17],
    info: {
      system: [["OS", "Ubuntu 22.04"], ["Kernel", "6.8.0"], ["Hostname", "server"], ["Region", "local"]],
      runtime: [["Docker", "25.0.3"], ["Node", "20.15.1"], ["Python", "3.12.2"], ["Last deploy", "本周"]],
    },
    processes: [{ pid: "3122", name: "node", cpu: "12.3%", mem: "256 MB", user: "dev" }],
    services: [{ name: "docker.service", status: "active", desc: "容器运行时" }],
    logs: [{ time: "09:31:10", level: "info", message: "system healthy" }],
  },
};

function getProfile(resource: WorkspaceResource | null) {
  if (!resource) return SERVER_PROFILES.default;
  return (
    SERVER_PROFILES[resource.id] ??
    SERVER_PROFILES[resource.name] ??
    SERVER_PROFILES.default
  );
}

function serviceBadge(status: "active" | "failed" | "degraded") {
  if (status === "active") return "badge badge-success";
  if (status === "degraded") return "badge badge-warn";
  return "badge badge-danger";
}

const SERVER_PATH = "/server";

export function ServerPanel() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<ServerTab>("monitor");
  const [processQuery, setProcessQuery] = useState("");
  const allResources = useWorkspaceResources();
  const getResourceForPath = useWorkspaceStore((s) => s.getResourceForPath);
  const selectResource = useWorkspaceStore((s) => s.selectResource);
  const activeResource = getResourceForPath(SERVER_PATH);
  const enqueueAction = useActionStore((s) => s.enqueueAction);

  const serverResources = useMemo(() => getServerMonitorResources(allResources), [allResources]);

  // 首次进入服务器页时，为 /server 路径写入默认选中项
  useEffect(() => {
    if (!useWorkspaceStore.getState().selectedResourceByPath[SERVER_PATH] && serverResources[0]) {
      selectResource(serverResources[0].id, SERVER_PATH);
    }
  }, [serverResources, selectResource]);
  const profile = getProfile(activeResource);

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

  useTopbarTabs(topbarTabs, { onSelect: (id) => setActiveTab(id as ServerTab) }, { mode: "segment" });

  const filteredProcesses = profile.processes.filter((process) =>
    [process.pid, process.name, process.user].some((field) => field.toLowerCase().includes(processQuery.toLowerCase()))
  );

  return (
    <div className="server-workspace">
      <ServerSidebar resources={serverResources} />
      <div className="server-main">
        {activeTab === "monitor" && (
          <div className="server-content">
            <div className="monitor-grid">
              <div className="monitor-card">
                <div className="monitor-label">
                  <span>CPU Usage</span>
                  <span className="badge badge-success">{profile.cpuLabel}</span>
                </div>
                <div className="monitor-value text-accent">{profile.cpu}</div>
                <div className="monitor-bar">
                  <div className="monitor-bar-fill accent" style={{ width: profile.cpu }} />
                </div>
                <div className="monitor-detail">4 cores · Intel Xeon E5-2680 · 2.40GHz</div>
              </div>
              <div className="monitor-card">
                <div className="monitor-label">
                  <span>Memory</span>
                  <span className="badge badge-warn">{profile.memoryRatio}</span>
                </div>
                <div className="monitor-value text-warn">{profile.memory}</div>
                <div className="monitor-bar">
                  <div className="monitor-bar-fill warn" style={{ width: profile.memoryRatio }} />
                </div>
                <div className="monitor-detail">8 GB total · 1.8 GB available</div>
              </div>
              <div className="monitor-card">
                <div className="monitor-label">
                  <span>Disk</span>
                  <span className="badge badge-success">{profile.diskRatio}</span>
                </div>
                <div className="monitor-value">{profile.disk}</div>
                <div className="monitor-bar">
                  <div className="monitor-bar-fill success" style={{ width: profile.diskRatio }} />
                </div>
                <div className="monitor-detail">100 GB total · 46 GB available</div>
              </div>
              <div className="monitor-card">
                <div className="monitor-label">
                  <span>Network</span>
                  <span className="badge badge-accent">Active</span>
                </div>
                <div className="monitor-value text-success">{profile.network}</div>
                <div className="monitor-bar">
                  <div className="monitor-bar-fill accent" style={{ width: "24%" }} />
                </div>
                <div className="monitor-detail">{profile.networkDetail}</div>
              </div>
            </div>

            <div className="chart-area">
              <div className="chart-header">
                <h3>Resource Trend</h3>
                <div className="chart-tabs">
                  <span className="chart-tab active">1H</span>
                  <span className="chart-tab">6H</span>
                  <span className="chart-tab">24H</span>
                </div>
              </div>
              <div className="chart-body">
                {profile.chart.map((value, index) => (
                  <div key={index} className="chart-bar" style={{ height: `${value * 2}px` }} />
                ))}
              </div>
            </div>

            <div className="info-grid">
              <div className="info-card">
                <h4>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="2" width="20" height="8" rx="2" />
                    <rect x="2" y="14" width="20" height="8" rx="2" />
                  </svg>
                  System Info
                </h4>
                {profile.info.system.map(([label, value]) => (
                  <div key={label} className="info-row">
                    <span className="label">{label}</span>
                    <span className="value">{value}</span>
                  </div>
                ))}
              </div>
              <div className="info-card">
                <h4>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" />
                    <path d="M12 17v4M8 21h8" />
                  </svg>
                  Runtime
                </h4>
                {profile.info.runtime.map(([label, value]) => (
                  <div key={label} className="info-row">
                    <span className="label">{label}</span>
                    <span className="value">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === "processes" && (
          <div className="server-content">
            <div className="process-section">
              <div className="process-header">
                <h3>Top Processes</h3>
                <input
                  className="process-search"
                  placeholder="Filter processes..."
                  value={processQuery}
                  onChange={(event) => setProcessQuery(event.target.value)}
                />
              </div>
              <div className="process-list">
                <div className="list-header">
                  <span>PID</span>
                  <span>Name</span>
                  <span>CPU</span>
                  <span>Memory</span>
                  <span>User</span>
                  <span>Action</span>
                </div>
                {filteredProcesses.map((process) => (
                  <div key={process.pid} className="process-row">
                    <span>{process.pid}</span>
                    <span className="proc-name">{process.name}</span>
                    <span className={process.cpu.startsWith("8") ? "text-warn" : undefined}>{process.cpu}</span>
                    <span>{process.mem}</span>
                    <span>{process.user}</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        enqueueAction({
                          type: "server",
                          title: `重启 ${process.name}`,
                          description: `${activeResource?.name ?? "当前服务器"} · 重启进程 ${process.pid}`,
                          command: `sudo systemctl restart ${process.name}`,
                          resourceId: activeResource?.id,
                          source: "用户",
                        })
                      }
                    >
                      Restart
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === "services" && (
          <div className="server-content">
            <div className="service-list">
              {profile.services.map((service) => (
                <div key={service.name} className="service-item">
                  <span className="svc-name">{service.name}</span>
                  <span className={`svc-status ${serviceBadge(service.status)}`}>{service.status}</span>
                  <span className="svc-desc">{service.desc}</span>
                  <div className="svc-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        enqueueAction({
                          type: "server",
                          title: `重启 ${service.name}`,
                          description: `${activeResource?.name ?? "当前服务器"} · systemctl restart ${service.name}`,
                          command: `sudo systemctl restart ${service.name}`,
                          resourceId: activeResource?.id,
                          source: "用户",
                        })
                      }
                    >
                      Restart
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "logs" && (
          <div className="server-content">
            <div className="panel" style={{ marginBottom: "var(--sp-4)" }}>
              <div className="panel-header">
                <h3>Recent Logs</h3>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() =>
                    enqueueAction({
                      type: "server",
                      title: `导出 ${activeResource?.name ?? "当前服务器"} 日志`,
                      description: `${activeResource?.name ?? "当前服务器"} · 下载最近日志`,
                      command: "journalctl -n 200 --no-pager > incident.log",
                      resourceId: activeResource?.id,
                      source: "用户",
                    })
                  }
                >
                  Download
                </button>
              </div>
              <div className="log-viewer" style={{ maxHeight: "unset" }}>
                {profile.logs.map((log) => (
                  <div key={`${log.time}-${log.message}`} className={`log-line${log.level === "warn" ? " log-warn" : log.level === "error" ? " log-error" : ""}`}>
                    <span className="log-ts">{log.time}</span>
                    <span className={log.level === "warn" ? "text-warn" : log.level === "error" ? "text-danger" : "text-accent"}>[{log.level}]</span>{" "}
                    {log.message}
                  </div>
                ))}
              </div>
            </div>
            <div className="info-grid">
              <div className="info-card">
                <h4>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    <path d="M14 2v6h6" />
                  </svg>
                  Incident Notes
                </h4>
                <div className="info-row"><span className="label">Primary issue</span><span className="value">Memory pressure on worker</span></div>
                <div className="info-row"><span className="label">Suggested action</span><span className="value">Scale celery + inspect queue backlog</span></div>
                <div className="info-row"><span className="label">Risk</span><span className="value">Medium</span></div>
              </div>
              <div className="info-card">
                <h4>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 11l3 3L22 4" />
                    <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                  </svg>
                  Quick Actions
                </h4>
                <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() =>
                      enqueueAction({
                        type: "server",
                        title: `打开 ${activeResource?.name ?? "当前服务器"} 终端会话`,
                        description: `${activeResource?.name ?? "当前服务器"} · 从监控问题跳转到终端`,
                        command: "ssh session open",
                        resourceId: activeResource?.id,
                        source: "用户",
                      })
                    }
                  >
                    Open Terminal
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setActiveTab("processes")}>
                    View Processes
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setActiveTab("services");
                      enqueueAction({
                        type: "server",
                        title: `检查 ${activeResource?.name ?? "当前服务器"} 服务`,
                        description: `${activeResource?.name ?? "当前服务器"} · 聚焦失败服务与重启入口`,
                        command: "systemctl --failed",
                        resourceId: activeResource?.id,
                        source: "用户",
                      });
                    }}
                  >
                    Restart Service
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
