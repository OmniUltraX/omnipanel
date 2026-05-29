import { useEffect, useMemo, useState } from "react";
import { useWorkspaceResources } from "../../stores/connectionStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useActionStore } from "../../stores/actionStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";

type Filter = "all" | "running" | "stopped";

const DOCKER_PATH = "/docker";

type ContainerItem = {
  name: string;
  image: string;
  status: "running" | "stopped";
  uptime: string;
  cpu: string;
  ports: string[];
  network: string;
  hostId: string;
  hostName: string;
  containerId: string;
  createdAt: string;
  startedAt: string;
  restartPolicy: string;
  memory: string;
  env: Array<{ key: string; value: string }>;
  logs: Array<{ ts: string; level: "info" | "warn" | "error"; message: string }>;
};

const containers: ContainerItem[] = [
  {
    name: "nginx-proxy",
    image: "nginx:1.25-alpine",
    status: "running",
    uptime: "3 days",
    cpu: "34%",
    ports: ["0.0.0.0:443->443/tcp", "0.0.0.0:80->80/tcp"],
    network: "bridge",
    hostId: "docker-prod-web",
    hostName: "prod-web-01",
    containerId: "a3f8c2d1e5b9",
    createdAt: "2026-05-23 14:22:01",
    startedAt: "2026-05-23 14:22:03",
    restartPolicy: "unless-stopped",
    memory: "128 MB",
    env: [
      { key: "NGINX_HOST", value: "prod.example.com" },
      { key: "NGINX_PORT", value: "80" },
    ],
    logs: [
      { ts: "2026-05-26 09:14:02", level: "warn", message: "rate limit triggered for 45.33.32.x" },
      { ts: "2026-05-26 09:13:46", level: "info", message: "200 GET /api/users 8ms" },
      { ts: "2026-05-26 09:12:01", level: "warn", message: "upstream connection timeout" },
    ],
  },
  {
    name: "app-backend",
    image: "app/api:2.1.0",
    status: "running",
    uptime: "3 days",
    cpu: "12%",
    ports: ["0.0.0.0:8080->8080/tcp"],
    network: "bridge",
    hostId: "docker-prod-web",
    hostName: "prod-web-01",
    containerId: "bd91f773aa10",
    createdAt: "2026-05-23 14:22:01",
    startedAt: "2026-05-23 14:22:04",
    restartPolicy: "unless-stopped",
    memory: "312 MB",
    env: [
      { key: "APP_ENV", value: "production" },
      { key: "PORT", value: "8080" },
    ],
    logs: [
      { ts: "2026-05-26 09:18:02", level: "info", message: "healthcheck passed" },
      { ts: "2026-05-26 09:16:42", level: "info", message: "200 GET /health 4ms" },
    ],
  },
  {
    name: "redis-cache",
    image: "redis:7-alpine",
    status: "running",
    uptime: "3 days",
    cpu: "2%",
    ports: ["6379/tcp"],
    network: "bridge",
    hostId: "docker-prod-web",
    hostName: "prod-web-01",
    containerId: "ce31aa99ee21",
    createdAt: "2026-05-23 14:22:01",
    startedAt: "2026-05-23 14:22:04",
    restartPolicy: "unless-stopped",
    memory: "64 MB",
    env: [{ key: "REDIS_APPENDONLY", value: "yes" }],
    logs: [{ ts: "2026-05-26 09:17:11", level: "info", message: "ready to accept connections" }],
  },
  {
    name: "postgres-main",
    image: "postgres:16-alpine",
    status: "running",
    uptime: "3 days",
    cpu: "8%",
    ports: ["5432/tcp"],
    network: "bridge",
    hostId: "docker-prod-web",
    hostName: "prod-web-01",
    containerId: "d6ef11a9b08f",
    createdAt: "2026-05-23 14:22:01",
    startedAt: "2026-05-23 14:22:04",
    restartPolicy: "unless-stopped",
    memory: "512 MB",
    env: [{ key: "POSTGRES_DB", value: "app" }],
    logs: [{ ts: "2026-05-26 09:15:02", level: "info", message: "checkpoint complete" }],
  },
  {
    name: "old-worker",
    image: "app/worker:1.8.0",
    status: "stopped",
    uptime: "2 days ago",
    cpu: "-",
    ports: [],
    network: "-",
    hostId: "docker-staging-api",
    hostName: "staging-api",
    containerId: "e8342dc98c11",
    createdAt: "2026-05-20 09:01:02",
    startedAt: "2026-05-24 10:03:04",
    restartPolicy: "on-failure",
    memory: "-",
    env: [{ key: "QUEUE", value: "legacy" }],
    logs: [{ ts: "2026-05-26 08:42:18", level: "error", message: "Exited with code 137" }],
  },
  {
    name: "temp-debug",
    image: "ubuntu:22.04",
    status: "stopped",
    uptime: "5 hours ago",
    cpu: "-",
    ports: [],
    network: "-",
    hostId: "docker-local",
    hostName: "dev-local",
    containerId: "f0ab72cd33de",
    createdAt: "2026-05-28 21:22:04",
    startedAt: "2026-05-28 22:02:04",
    restartPolicy: "no",
    memory: "-",
    env: [{ key: "DEBUG", value: "1" }],
    logs: [{ ts: "2026-05-29 00:24:11", level: "warn", message: "interactive container stopped" }],
  },
];

export function DockerPanel() {
  const { t } = useI18n();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const allResources = useWorkspaceResources();
  const getResourceForPath = useWorkspaceStore((s) => s.getResourceForPath);
  const selectResource = useWorkspaceStore((s) => s.selectResource);
  const activeResource = getResourceForPath(DOCKER_PATH);
  const enqueueAction = useActionStore((s) => s.enqueueAction);

  const dockerResources = useMemo(
    () => allResources.filter((resource) => resource.type === "docker"),
    [allResources]
  );

  useEffect(() => {
    if (!useWorkspaceStore.getState().selectedResourceByPath[DOCKER_PATH] && dockerResources[0]) {
      selectResource(dockerResources[0].id, DOCKER_PATH);
    }
  }, [dockerResources, selectResource]);

  const [drawerContainerName, setDrawerContainerName] = useState<string | null>(null);

  useEffect(() => {
    setDrawerContainerName(null);
  }, [activeResource?.id]);
  const topbarTabs = useMemo(
    () =>
      dockerResources.map((resource) => ({
        id: resource.id,
        label: resource.name,
        active: resource.id === (activeResource?.id ?? dockerResources[0]?.id),
      })),
    [activeResource?.id, dockerResources]
  );

  useTopbarTabs(
    topbarTabs,
    { onSelect: (id) => selectResource(id, DOCKER_PATH) },
    { mode: "connection", showAddTab: true, addTabTitle: t("shell.topbar.addHost") }
  );

  const scopedContainers = useMemo(() => {
    if (!activeResource) return containers;
    return containers.filter((container) => container.hostId === activeResource.id);
  }, [activeResource]);

  const counts = useMemo(
    () => ({
      all: scopedContainers.length,
      running: scopedContainers.filter((container) => container.status === "running").length,
      stopped: scopedContainers.filter((container) => container.status === "stopped").length,
    }),
    [scopedContainers]
  );

  const filteredContainers = useMemo(() => {
    return scopedContainers.filter((container) => {
      const matchesFilter = filter === "all" || container.status === filter;
      const matchesQuery =
        container.name.toLowerCase().includes(query.toLowerCase()) ||
        container.image.toLowerCase().includes(query.toLowerCase()) ||
        container.network.toLowerCase().includes(query.toLowerCase());
      return matchesFilter && matchesQuery;
    });
  }, [filter, query, scopedContainers]);

  const drawerContainer = scopedContainers.find((container) => container.name === drawerContainerName) ?? null;

  const openDrawer = (container: ContainerItem) => setDrawerContainerName(container.name);
  const closeDrawer = () => setDrawerContainerName(null);

  return (
    <>
      <div className="docker-layout">
        <div className="docker-stats">
          <div className="docker-stat">
            <div className="stat-icon" style={{ background: "var(--success-soft)", color: "var(--success)" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="7" width="6" height="5" rx="1" />
                <rect x="10" y="7" width="6" height="5" rx="1" />
              </svg>
            </div>
            <div className="stat-info">
              <span className="stat-val">{counts.running}</span>
              <span className="stat-label">Running</span>
            </div>
          </div>
          <div className="docker-stat">
            <div className="stat-icon" style={{ background: "var(--surface-hover)", color: "var(--muted)" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="7" width="6" height="5" rx="1" />
                <rect x="10" y="7" width="6" height="5" rx="1" />
              </svg>
            </div>
            <div className="stat-info">
              <span className="stat-val">{counts.stopped}</span>
              <span className="stat-label">Stopped</span>
            </div>
          </div>
          <div className="docker-stat">
            <div className="stat-icon" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
              </svg>
            </div>
            <div className="stat-info">
              <span className="stat-val">12</span>
              <span className="stat-label">Images</span>
            </div>
          </div>
          <div className="docker-stat">
            <div className="stat-icon" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
            </div>
            <div className="stat-info">
              <span className="stat-val">3</span>
              <span className="stat-label">Volumes</span>
            </div>
          </div>
        </div>

        <div className="docker-filters">
          {(["all", "running", "stopped"] as const).map((key) => (
            <button key={key} type="button" className={`filter-tab${filter === key ? " active" : ""}`} onClick={() => setFilter(key)}>
              {t(`docker.filters.${key}`)}
              <span className="count">{counts[key]}</span>
            </button>
          ))}
          <span style={{ marginLeft: "auto" }}>
            <input
              className="input input-search"
              placeholder="Filter containers..."
              style={{ fontSize: 11, width: 200 }}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </span>
        </div>

        <div className="container-list">
          <div className="list-header">
            <span>{t("docker.list.container")}</span>
            <span>{t("docker.list.status")}</span>
            <span>{t("docker.list.cpu")}</span>
            <span>{t("docker.list.ports")}</span>
            <span>Network</span>
            <span></span>
          </div>
          {filteredContainers.map((container) => (
            <div
              key={container.name}
              className="container-card"
              style={container.status === "stopped" ? { opacity: 0.65 } : undefined}
              onClick={() => openDrawer(container)}
            >
              <div className="container-name">
                <div className="container-icon" style={{ color: container.status === "running" ? "var(--success)" : "var(--muted)" }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
                <span className={`status-dot ${container.status === "running" ? "online" : "offline"}`} />
                <span className={container.status === "running" ? "text-success text-sm" : "text-muted text-sm"}>
                  {container.status === "running" ? "Running" : "Exited"}
                </span>
                <span className="text-muted text-xs">{container.uptime}</span>
              </div>
              <div><span className={container.cpu === "34%" ? "text-warn" : undefined}>{container.cpu}</span></div>
              <div className="text-sm">{container.ports.length > 0 ? container.ports.join("\n") : "-"}</div>
              <div className="text-sm text-muted">{container.network}</div>
              <div className="container-actions" onClick={(event) => event.stopPropagation()}>
                {container.status === "running" ? (
                  <>
                    <button
                      className="btn-icon"
                      title="Restart"
                      onClick={() =>
                        enqueueAction({
                          type: "docker",
                          title: `重启 ${container.name}`,
                          description: `${container.hostName} · docker restart ${container.name}`,
                          command: `docker restart ${container.name}`,
                          resourceId: activeResource?.id,
                          source: "用户",
                        })
                      }
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                        <path d="M23 4v6h-6M1 20v-6h6" />
                        <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
                      </svg>
                    </button>
                    <button
                      className="btn-icon"
                      title="Stop"
                      onClick={() =>
                        enqueueAction({
                          type: "docker",
                          title: `停止 ${container.name}`,
                          description: `${container.hostName} · docker stop ${container.name}`,
                          command: `docker stop ${container.name}`,
                          resourceId: activeResource?.id,
                          source: "用户",
                        })
                      }
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                        <rect x="6" y="6" width="12" height="12" rx="1" />
                      </svg>
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn-icon" title="Start">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                    </button>
                    <button className="btn-icon text-danger" title="Remove">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                        <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className={`drawer-overlay${drawerContainer ? " show" : ""}`} onClick={closeDrawer} />
      <div className={`drawer${drawerContainer ? " show" : ""}`}>
        {drawerContainer && (
          <>
            <div className="drawer-header">
              <div className="container-icon" style={{ color: "var(--success)", width: 28, height: 28, display: "grid", placeItems: "center", background: "var(--success-soft)", borderRadius: "var(--r-sm)" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <rect x="2" y="7" width="6" height="5" rx="1" />
                  <rect x="10" y="7" width="6" height="5" rx="1" />
                </svg>
              </div>
              <h2>{drawerContainer.name}</h2>
              <span className={`badge ${drawerContainer.status === "running" ? "badge-success" : "badge-muted"}`}>
                {drawerContainer.status === "running" ? "Running" : "Stopped"}
              </span>
              <button className="btn-icon" onClick={closeDrawer} title="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="drawer-body">
              <div className="drawer-section">
                <h4>Container Info</h4>
                <dl className="drawer-kv">
                  <dt>ID</dt><dd className="text-muted">{drawerContainer.containerId}</dd>
                  <dt>Image</dt><dd>{drawerContainer.image}</dd>
                  <dt>Host</dt><dd>{drawerContainer.hostName}</dd>
                  <dt>Created</dt><dd>{drawerContainer.createdAt}</dd>
                  <dt>Started</dt><dd>{drawerContainer.startedAt}</dd>
                  <dt>Restart Policy</dt><dd>{drawerContainer.restartPolicy}</dd>
                </dl>
              </div>

              <div className="drawer-section">
                <h4>Resource Usage</h4>
                <div className="quick-stats" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                  <div className="quick-stat">
                    <div className="stat-label">CPU</div>
                    <div className="stat-value">{drawerContainer.cpu}</div>
                  </div>
                  <div className="quick-stat">
                    <div className="stat-label">Memory</div>
                    <div className="stat-value">{drawerContainer.memory}</div>
                  </div>
                </div>
              </div>

              <div className="drawer-section">
                <h4>Ports</h4>
                <dl className="drawer-kv">
                  {drawerContainer.ports.length > 0 ? drawerContainer.ports.map((port, index) => (
                    <div key={port} style={{ display: "contents" }}>
                      <dt>{index === 0 ? "Primary" : `Port ${index + 1}`}</dt>
                      <dd>{port}</dd>
                    </div>
                  )) : (
                    <div style={{ display: "contents" }}>
                      <dt>Ports</dt>
                      <dd>-</dd>
                    </div>
                  )}
                </dl>
              </div>

              <div className="drawer-section">
                <h4>Environment</h4>
                <dl className="drawer-kv">
                  {drawerContainer.env.map((entry) => (
                    <div key={entry.key} style={{ display: "contents" }}>
                      <dt>{entry.key}</dt>
                      <dd>{entry.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              <div className="drawer-section">
                <h4>Recent Logs</h4>
                <div className="log-viewer">
                  {drawerContainer.logs.map((line) => (
                    <div key={`${line.ts}-${line.message}`} className="log-line">
                      <span className="ts">{line.ts}</span>{" "}
                      <span className={`level-${line.level}`}>[{line.level}]</span>{" "}
                      {line.message}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-2" style={{ marginTop: "var(--sp-4)" }}>
                <button className="btn btn-primary">Open Terminal</button>
                <button className="btn btn-secondary">View Logs</button>
                <button className="btn btn-secondary">Restart</button>
                <button className="btn btn-danger" style={{ marginLeft: "auto" }}>Stop</button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
