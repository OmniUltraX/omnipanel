import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useActionStore } from "../../stores/actionStore";
import { useAiStore } from "../../stores/aiStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";
import {
  useContainerLogStream,
  useDockerWorkspace,
  type ContainerFilter,
} from "./useDockerWorkspace";
import { DockerExecTerminal } from "./DockerExecTerminal";
import { DockerConnectionDialog } from "./DockerConnectionDialog";
import { DockerStatsPanel } from "./DockerStatsPanel";
import { ImageActionBar } from "./ImageActionBar";
import { DockerNetworksTab } from "./DockerNetworksTab";
import { DockerVolumesTab } from "./DockerVolumesTab";
import { DockerFilesTab } from "./DockerFilesTab";
import { DockerImageDrawer } from "./DockerImageDrawer";
import { DockerNetworkDrawer } from "./DockerNetworkDrawer";
import { DockerVolumeDrawer } from "./DockerVolumeDrawer";
import { DockerComposeDrawer } from "./DockerComposeDrawer";
import { DockerFileEditor } from "./DockerFileEditor";
import { Button } from "../../components/ui/Button";
import { WorkspaceEmptyPage } from "../../components/ui/WorkspaceEmptyPage";
import type { DockerComposeAction } from "../../ipc/bindings";
import { CreateContainerDialog } from "./CreateContainerDialog";
import { SwarmPanel } from "./SwarmPanel";
import { formatDockerTime } from "./format";
import {
  CloseIcon,
  ComposeStackIcon,
  ContainerIcon,
  DockerWhaleIcon,
  ImageLayersIcon,
  PlayIcon,
  PushIcon,
  RestartIcon,
  StatsIcon,
  StopIcon,
  TagIcon,
  TrashIcon,
} from "./icons";
import type {
  DockerContainerDetail,
  DockerContainerSummary,
} from "../../ipc/bindings";

type WorkspaceTab = "containers" | "images" | "compose" | "networks" | "volumes" | "files" | "swarm";

interface ConfirmState {
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  onConfirm: () => void;
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "-";
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

const STATUS_BADGE: Record<string, string> = {
  online: "badge-success",
  degraded: "badge-warn",
  offline: "badge-muted",
};

const SOURCE_LABEL: Record<string, string> = {
  "local-engine": "本地 Engine",
  "remote-engine": "远程 Engine",
  "ssh-engine": "SSH 宿主机",
  "onepanel": "1Panel 面板",
  "panel-adapter": "面板适配",
};

export function DockerPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/docker";
  const navigate = useNavigate();
  const enqueueAction = useActionStore((s) => s.enqueueAction);
  const setAiDraft = useAiStore((s) => s.setDraftPrompt);
  const openAiDrawer = useAiStore((s) => s.openDrawer);

  const docker = useDockerWorkspace();
  const {
    connections,
    selectedConnection,
    selectedConnectionId,
    selectConnection,
    probe,
    overview,
    containers,
    images,
    composeProjects,
    networks,
    volumes,
    files,
    filePath,
    fileContainerId,
    composeAction,
    pullImage,
    pushImage,
    tagImage,
    buildImage,
    listNetworks,
    createNetwork,
    removeNetwork,
    listVolumes,
    createVolume,
    removeVolume,
    pruneVolumes,
    listContainerDir,
    readContainerFile,
    writeContainerFile,
    connectionsLoading,
    dataLoading,
    dataRefreshing,
    error,
    refresh,
    containerAction,
    inspect,
    inspectImage,
    imageHistory,
    inspectNetwork,
    inspectVolume,
    removeImage,
    pruneImages,
    reloadConnections,
  } = docker;

  const [tab, setTab] = useState<WorkspaceTab>("containers");
  const [filter, setFilter] = useState<ContainerFilter>("all");
  const [query, setQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [showAddConn, setShowAddConn] = useState(false);
  const [statsContainer, setStatsContainer] = useState<{ id: string; name: string } | null>(null);
  const [imageDrawerId, setImageDrawerId] = useState<string | null>(null);
  const [networkDrawerName, setNetworkDrawerName] = useState<string | null>(null);
  const [volumeDrawerName, setVolumeDrawerName] = useState<string | null>(null);
  const [composeDrawerName, setComposeDrawerName] = useState<string | null>(null);
  const [fileEditor, setFileEditor] = useState<{ path: string; content: string } | null>(null);
  const [showCreateContainer, setShowCreateContainer] = useState(false);
  const [selectedContainers, setSelectedContainers] = useState<Set<string>>(new Set());
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3200);
  };

  // 连接 → topbar 标签页。
  const topbarTabs = useMemo(
    () =>
      connections.map((c) => ({
        id: c.connectionId,
        label: c.name,
        active: c.connectionId === selectedConnectionId,
      })),
    [connections, selectedConnectionId]
  );

  useTopbarTabs(
    topbarTabs,
    {
      onSelect: (id) => selectConnection(id),
      onAdd: () => setShowAddConn(true),
    },
    { mode: "connection", showAddTab: true, addTabTitle: "添加 Docker 连接", enabled: isActiveRoute }
  );

  // 切换连接时复位本地视图状态（数据在 hook 内后台加载，无全屏遮罩）。
  useEffect(() => {
    setDrawerId(null);
    setTab("containers");
    setFilter("all");
    setQuery("");
    setSearchInput("");
    setErrorDismissed(false);
    setSelectedContainers(new Set());
    setSelectedImages(new Set());
  }, [selectedConnectionId]);

  // 从其他模块切回 Docker 时静默刷新，保留当前 UI 状态。
  const onDockerRouteRef = useRef(location.pathname === "/docker");
  useEffect(() => {
    const onDocker = location.pathname === "/docker";
    if (onDocker && !onDockerRouteRef.current) {
      refresh();
    }
    onDockerRouteRef.current = onDocker;
  }, [location.pathname, refresh]);

  // Search debounce
  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const counts = useMemo(
    () => ({
      all: containers.length,
      running: containers.filter((c) => c.running).length,
      stopped: containers.filter((c) => !c.running).length,
    }),
    [containers]
  );

  const filteredContainers = useMemo(() => {
    const q = query.toLowerCase();
    return containers.filter((c) => {
      const matchesFilter =
        filter === "all" || (filter === "running" ? c.running : !c.running);
      const matchesQuery =
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.image.toLowerCase().includes(q) ||
        c.networks.some((n) => n.toLowerCase().includes(q));
      return matchesFilter && matchesQuery;
    });
  }, [containers, filter, query]);

  // 审计记录（记录型动作，进入操作流，不二次执行）。
  const recordAudit = (title: string, description: string) => {
    enqueueAction({
      type: "docker",
      title,
      description,
      resourceId: selectedConnectionId ?? undefined,
      source: "用户",
    });
  };

  const runContainerAction = async (
    container: DockerContainerSummary,
    action: string,
    label: string
  ) => {
    const res = await containerAction(container.id, action);
    if (res.ok) {
      showToast(`${label} ${container.name} 成功`);
    } else {
      showToast(`${label} ${container.name} 失败：${res.message ?? "未知错误"}`);
    }
  };

  const confirmContainerRemove = (container: DockerContainerSummary) => {
    const isProd = selectedConnection?.environment === "prod";
    setConfirm({
      title: `删除容器 ${container.name}`,
      message: `将永久删除容器（含其可写层），此操作不可恢复。`,
      detail: `${selectedConnection?.name ?? ""} · ${container.image}${isProd ? " · ⚠ 生产环境" : ""}`,
      confirmLabel: "确认删除",
      onConfirm: async () => {
        setConfirm(null);
        const res = await containerAction(container.id, "remove");
        if (res.ok) {
          recordAudit(`删除容器 ${container.name}`, `${selectedConnection?.name ?? ""} · docker rm -f ${container.name}`);
          showToast(`已删除容器 ${container.name}`);
          if (drawerId === container.id) setDrawerId(null);
        } else {
          showToast(`删除失败：${res.message ?? "未知错误"}`);
        }
      },
    });
  };

  const confirmImageRemove = (imageId: string, label: string) => {
    setConfirm({
      title: `删除镜像 ${label}`,
      message: "删除后若有容器引用将失败，可使用强制删除。",
      detail: selectedConnection?.name ?? "",
      confirmLabel: "确认删除",
      onConfirm: async () => {
        setConfirm(null);
        const res = await removeImage(imageId, true);
        if (res.ok) {
          recordAudit(`删除镜像 ${label}`, `${selectedConnection?.name ?? ""} · docker rmi -f ${label}`);
          showToast(`已删除镜像 ${label}`);
        } else {
          showToast(`删除失败：${res.message ?? "未知错误"}`);
        }
      },
    });
  };

  const confirmPrune = () => {
    setConfirm({
      title: "清理悬空镜像",
      message: "将删除所有未被引用的悬空镜像以释放磁盘空间。",
      detail: selectedConnection?.name ?? "",
      confirmLabel: "确认清理",
      onConfirm: async () => {
        setConfirm(null);
        const res = await pruneImages();
        if (res.ok) {
          recordAudit("清理 Docker 悬空镜像", `${selectedConnection?.name ?? ""} · docker image prune`);
          showToast(res.message ?? "清理完成");
        } else {
          showToast(`清理失败：${res.message ?? "未知错误"}`);
        }
      },
    });
  };

  const isOffline = probe?.status === "offline";
  const isLocalEngine = selectedConnection?.source === "local-engine";
  const showLocalEngineWelcome =
    isLocalEngine &&
    !connectionsLoading &&
    !dataLoading &&
    (isOffline || Boolean(error));

  const toggleContainerSelect = (id: string) => {
    setSelectedContainers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleImageSelect = (id: string) => {
    setSelectedImages((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const batchRemoveContainers = async () => {
    if (selectedContainers.size === 0) return;
    setConfirm({
      title: `批量删除 ${selectedContainers.size} 个容器`,
      message: "将逐个删除选中的容器，此操作不可恢复。",
      detail: selectedConnection?.name ?? "",
      confirmLabel: "确认删除",
      onConfirm: async () => {
        setConfirm(null);
        let ok = 0;
        let fail = 0;
        for (const cid of selectedContainers) {
          const res = await containerAction(cid, "remove");
          if (res.ok) ok++;
          else fail++;
        }
        setSelectedContainers(new Set());
        showToast(`批量删除完成：成功 ${ok}，失败 ${fail}`);
      },
    });
  };

  const batchRemoveImages = async () => {
    if (selectedImages.size === 0) return;
    setConfirm({
      title: `批量删除 ${selectedImages.size} 个镜像`,
      message: "将逐个强制删除选中的镜像，此操作不可恢复。",
      detail: selectedConnection?.name ?? "",
      confirmLabel: "确认删除",
      onConfirm: async () => {
        setConfirm(null);
        let ok = 0;
        let fail = 0;
        for (const imgId of selectedImages) {
          const res = await removeImage(imgId, true);
          if (res.ok) ok++;
          else fail++;
        }
        setSelectedImages(new Set());
        showToast(`批量删除完成：成功 ${ok}，失败 ${fail}`);
      },
    });
  };

  return (
    <>
      <div className="docker-layout">
        {/* 连接头部 */}
        {selectedConnection && (
          <div className="docker-conn-header">
            <div className="docker-conn-header-info">
              <span className={`status-dot ${selectedConnection.status === "online" ? "online" : selectedConnection.status === "degraded" ? "warning" : "offline"}`} />
              <strong>{selectedConnection.name}</strong>
              <span className={`badge ${STATUS_BADGE[selectedConnection.status] ?? "badge-muted"}`}>
                {selectedConnection.status === "online" ? "在线" : selectedConnection.status === "degraded" ? "降级" : "离线"}
              </span>
              <span className="text-muted text-xs">{SOURCE_LABEL[selectedConnection.source] ?? selectedConnection.source}</span>
              {selectedConnection.hostLabel && selectedConnection.hostLabel !== SOURCE_LABEL[selectedConnection.source] && (
                <span className="text-muted text-xs">{selectedConnection.hostLabel}</span>
              )}
              {selectedConnection.engineVersion && (
                <span className="text-muted text-xs">Engine {selectedConnection.engineVersion}</span>
              )}
            </div>
            <Button variant="secondary" size="sm" onClick={refresh} disabled={dataRefreshing}>
              {dataRefreshing ? "刷新中…" : "刷新"}
            </Button>
          </div>
        )}

        {connectionsLoading ? (
          <div className="docker-empty">正在加载 Docker 连接…</div>
        ) : connections.length === 0 ? (
          <div className="docker-empty">
            <div className="docker-empty-title">暂无 Docker 连接</div>
            <Button variant="primary" size="sm" style={{ marginTop: 12 }} onClick={() => setShowAddConn(true)}>
              添加 Docker 连接
            </Button>
          </div>
        ) : showLocalEngineWelcome ? (
          <WorkspaceEmptyPage
            prompt={t("docker.empty.localEngine")}
            actions={
              <Button variant="secondary" size="sm" onClick={refresh}>
                {t("common.refresh")}
              </Button>
            }
          />
        ) : isOffline ? (
          <div className="docker-empty">
            <div className="docker-empty-title">Docker 未安装或未启动</div>
            <div className="text-muted text-sm">{probe?.warningMessage ?? error ?? "无法连接到 Docker Engine"}</div>
            <Button variant="secondary" size="sm" style={{ marginTop: 12 }} onClick={refresh}>重试</Button>
          </div>
        ) : (
          <>
            {/* 统计 */}
            <div className="docker-stats">
              <StatCard color="success" value={overview?.summary.containersRunning ?? counts.running} label={t("docker.stats.running")} icon="running" />
              <StatCard color="muted" value={overview?.summary.containersStopped ?? counts.stopped} label={t("docker.stats.stopped")} icon="stopped" />
              <StatCard color="accent" value={overview?.summary.images ?? images.length} label={t("docker.stats.images")} icon="images" />
              <StatCard color="warn" value={composeProjects.length} label="Compose" icon="compose" />
            </div>

            {/* Error Banner */}
            {error && !isOffline && !errorDismissed && (
              <div className="docker-error-banner">
                <span className="docker-error-icon">⚠</span>
                <span className="docker-error-text">{error}</span>
                <button className="docker-error-dismiss" onClick={() => setErrorDismissed(true)}>×</button>
              </div>
            )}

            {/* 子页签 */}
            <div className="docker-subtabs">
              {(
                [
                  { key: "containers", label: "容器" },
                  { key: "images", label: "镜像" },
                  { key: "compose", label: "Compose" },
                  { key: "networks", label: "网络" },
                  { key: "volumes", label: "卷" },
                  { key: "files", label: "文件" },
                  { key: "swarm", label: "Swarm" },
                ] as const
              ).map(({ key, label }) => (
                <button key={key} type="button" className={`subtab${tab === key ? " active" : ""}`} onClick={() => setTab(key)}>
                  {label}
                </button>
              ))}
            </div>

            <div key={tab} className="docker-tab-content-animate">
            {tab === "containers" && (
              <>
                <div className="docker-filters">
                  {(["all", "running", "stopped"] as const).map((key) => (
                    <button key={key} type="button" className={`filter-tab${filter === key ? " active" : ""}`} onClick={() => setFilter(key)}>
                      {t(`docker.filters.${key}`)}
                      <span className="count">{counts[key]}</span>
                    </button>
                  ))}
                  {selectedContainers.size > 0 && (
                    <button className="btn btn-danger btn-sm" onClick={batchRemoveContainers}>
                      批量删除 ({selectedContainers.size})
                    </button>
                  )}
                  <button className="btn btn-primary btn-sm" onClick={() => setShowCreateContainer(true)} disabled={!probe?.capabilities?.canManageContainers}>
                    + 创建容器
                  </button>
                  <span style={{ marginLeft: "auto" }}>
                    <input
                      className="input input-search"
                      placeholder="筛选容器…"
                      style={{ fontSize: 11, width: 200 }}
                      value={searchInput}
                      onChange={(e) => setSearchInput(e.target.value)}
                    />
                  </span>
                </div>

                <div className="container-list">
                  <div className="list-header list-5">
                    <span className="col-check">
                      <input type="checkbox" checked={selectedContainers.size > 0 && selectedContainers.size === filteredContainers.length} onChange={(e) => {
                        if (e.target.checked) setSelectedContainers(new Set(filteredContainers.map((c) => c.id)));
                        else setSelectedContainers(new Set());
                      }} />
                    </span>
                    <span>{t("docker.list.container")}</span>
                    <span>{t("docker.list.status")}</span>
                    <span>{t("docker.list.ports")}</span>
                    <span>网络</span>
                    <span></span>
                  </div>
                  {filteredContainers.length === 0 ? (
                    <div className="docker-empty" style={{ minHeight: 120 }}>
                      {dataLoading && containers.length === 0 ? "加载中…" : <EmptyState icon="📦" title="暂无容器" desc="创建或拉取一个容器开始使用" />}
                    </div>
                  ) : (
                    filteredContainers.map((container, idx) => (
                      <div
                        key={container.id}
                        className="container-card container-card-5 docker-list-item"
                        style={!container.running ? { opacity: 0.65, animationDelay: `${idx * 0.03}s` } : { animationDelay: `${idx * 0.03}s` }}
                        onClick={() => setDrawerId(container.id)}
                      >
                        <div className="col-check" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={selectedContainers.has(container.id)} onChange={() => toggleContainerSelect(container.id)} />
                        </div>
                        <div className="container-name">
                          <div className="container-icon" style={{ color: container.running ? "var(--success)" : "var(--muted)" }}>
                            <ContainerIcon />
                          </div>
                          <div>
                            <div className="container-title">{container.name}</div>
                            <div className="container-image">{container.image}</div>
                          </div>
                        </div>
                        <div className="container-status">
                          <span className={`status-dot ${container.running ? "online" : "offline"}`} />
                          <span className={container.running ? "text-success text-sm" : "text-muted text-sm"}>
                            {container.statusText || (container.running ? "Running" : "Exited")}
                          </span>
                        </div>
                        <div className="text-sm" style={{ whiteSpace: "pre-line" }}>
                          {container.ports.length > 0 ? container.ports.map((p) => portLabel(p)).join("\n") : "-"}
                        </div>
                        <div className="text-sm text-muted">{container.networks.join(", ") || "-"}</div>
                        <div className="container-actions" onClick={(e) => e.stopPropagation()}>
                          <Button
                            variant="icon"
                            title="资源监控"
                            disabled={!container.running}
                            onClick={() => setStatsContainer({ id: container.id, name: container.name })}
                          >
                            <StatsIcon />
                          </Button>
                          {container.running ? (
                            <>
                              <Button variant="icon" title="重启" onClick={() => runContainerAction(container, "restart", "重启")}>
                                <RestartIcon />
                              </Button>
                              <Button variant="icon" title="停止" onClick={() => runContainerAction(container, "stop", "停止")}>
                                <StopIcon />
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button variant="icon" title="启动" onClick={() => runContainerAction(container, "start", "启动")}>
                                <PlayIcon />
                              </Button>
                              <Button variant="icon" className="text-danger" title="删除" onClick={() => confirmContainerRemove(container)}>
                                <TrashIcon />
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}

            {tab === "images" && (
              <div className="container-list">
                <div className="docker-filters">
                  <span className="text-muted text-sm">{images.length} 个镜像</span>
                  {selectedImages.size > 0 && (
                    <button className="btn btn-danger btn-sm" onClick={batchRemoveImages}>
                      批量删除 ({selectedImages.size})
                    </button>
                  )}
                  <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    <ImageActionBar
                      canManage={probe?.capabilities?.canManageImages ?? false}
                      onPull={async (image, onProgress) => {
                        const r = await pullImage(image, onProgress);
                        showToast(r.message ?? (r.ok ? "拉取完成" : "拉取失败"));
                        return r;
                      }}
                      onBuild={async (ctx, tag, df, onProgress) => {
                        const r = await buildImage(ctx, tag, df, onProgress);
                        showToast(r.message ?? (r.ok ? "构建完成" : "构建失败"));
                        return r;
                      }}
                      onMessage={(msg) => showToast(msg)}
                    />
                    <Button variant="secondary" size="sm" onClick={confirmPrune}>
                      清理悬空
                    </Button>
                  </div>
                </div>
                <div className="list-header image-row">
                  <span className="col-check">
                    <input type="checkbox" checked={selectedImages.size > 0 && selectedImages.size === images.length} onChange={(e) => {
                      if (e.target.checked) setSelectedImages(new Set(images.map((i) => i.id)));
                      else setSelectedImages(new Set());
                    }} />
                  </span>
                  <span>仓库</span>
                  <span>标签</span>
                  <span>大小</span>
                  <span>创建时间</span>
                  <span></span>
                </div>
                {images.length === 0 ? (
                  <div className="docker-empty" style={{ minHeight: 120 }}>{dataLoading && images.length === 0 ? "加载中…" : <EmptyState icon="🖼️" title="暂无镜像" desc="拉取或构建镜像" />}</div>
                ) : (
                  images.map((img, idx) => (
                    <div
                      key={`${img.id}-${img.repository}-${img.tag}-${idx}`}
                      className="container-card image-row docker-list-item"
                      style={{ animationDelay: `${idx * 0.03}s` }}
                      onClick={() => setImageDrawerId(img.id)}
                    >
                      <div className="col-check" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selectedImages.has(img.id)} onChange={() => toggleImageSelect(img.id)} />
                      </div>
                      <div className="container-title">
                        {img.repository}
                        {img.dangling && <span className="badge badge-warn" style={{ marginLeft: 6 }}>悬空</span>}
                      </div>
                      <div className="text-sm text-muted">{img.tag}</div>
                      <div className="text-sm">{formatBytes(img.sizeBytes)}</div>
                      <div className="text-sm text-muted">{formatDockerTime(img.createdAt)}</div>
                      <div className="container-actions" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="icon"
                          title="推送"
                          disabled={!probe?.capabilities?.canManageImages || img.dangling}
                          onClick={async () => {
                            const ref = `${img.repository}:${img.tag}`;
                            const r = await pushImage(ref);
                            showToast(r.message ?? (r.ok ? "推送完成" : "推送失败"));
                          }}
                        >
                          <PushIcon />
                        </Button>
                        <Button
                          variant="icon"
                          title="打 tag"
                          disabled={!probe?.capabilities?.canManageImages}
                          onClick={async () => {
                            const newTag = window.prompt(`为 ${img.repository}:${img.tag} 设置新 tag`, `${img.repository}:latest`);
                            if (!newTag) return;
                            const r = await tagImage(`${img.repository}:${img.tag}`, newTag);
                            showToast(r.message ?? (r.ok ? "已打 tag" : "打 tag 失败"));
                          }}
                        >
                          <TagIcon />
                        </Button>
                        <Button
                          variant="icon"
                          className="text-danger"
                          title="删除镜像"
                          onClick={() => confirmImageRemove(img.id, `${img.repository}:${img.tag}`)}
                        >
                          <TrashIcon />
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {tab === "compose" && (
              <div className="container-list">
                {composeProjects.length === 0 ? (
                  <div className="docker-empty" style={{ minHeight: 120 }}>
                    {dataLoading && composeProjects.length === 0 ? "加载中…" : <EmptyState icon="🐳" title="未识别到 Compose 项目" />}
                  </div>
                ) : (
                  composeProjects.map((proj) => (
                    <div key={proj.name} className="compose-card" onClick={() => setComposeDrawerName(proj.name)} style={{ cursor: "pointer" }}>
                      <div className="compose-head">
                        <strong>{proj.name}</strong>
                        <span className="text-muted text-xs">
                          {proj.runningContainerCount}/{proj.containerCount} 运行 · {proj.serviceCount} 服务
                        </span>
                        {proj.workingDir && <span className="text-muted text-xs">{proj.workingDir}</span>}
                        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={!probe?.capabilities?.canCompose}
                            onClick={async () => {
                              const r = await composeAction("up", proj.name);
                              showToast(r.message ?? (r.ok ? "已 up" : "up 失败"));
                            }}
                          >
                            Up
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={!probe?.capabilities?.canCompose}
                            onClick={async () => {
                              const r = await composeAction("down", proj.name);
                              showToast(r.message ?? (r.ok ? "已 down" : "down 失败"));
                            }}
                          >
                            Down
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={!probe?.capabilities?.canCompose}
                            onClick={async () => {
                              const r = await composeAction("restart", proj.name);
                              showToast(r.message ?? (r.ok ? "已 restart" : "restart 失败"));
                            }}
                          >
                            Restart
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={!probe?.capabilities?.canCompose}
                            onClick={async () => {
                              const r = await composeAction("pull", proj.name);
                              showToast(r.message ?? (r.ok ? "已 pull" : "pull 失败"));
                            }}
                          >
                            Pull
                          </Button>
                        </div>
                      </div>
                      <div className="compose-services">
                        {proj.services.map((svc) => (
                          <div key={svc.name} className="compose-service">
                            <span className={`status-dot ${svc.runningContainerCount > 0 ? "online" : "offline"}`} />
                            <span className="compose-service-name">{svc.name}</span>
                            <span className="text-muted text-xs">{svc.image}</span>
                            <span className="text-muted text-xs" style={{ marginLeft: "auto" }}>
                              {svc.runningContainerCount}/{svc.containerCount}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {tab === "networks" && (
              <DockerNetworksTab
                networks={networks}
                canManage={probe?.capabilities?.canManageContainers ?? false}
                onRefresh={listNetworks}
                onCreate={async (req) => {
                  const r = await createNetwork(req);
                  showToast(r.message ?? (r.ok ? "已创建" : "创建失败"));
                  return r;
                }}
                onRemove={async (name) => {
                  const r = await removeNetwork(name);
                  showToast(r.message ?? (r.ok ? "已删除" : "删除失败"));
                  return r;
                }}
                onInspect={(name) => setNetworkDrawerName(name)}
              />
            )}

            {tab === "volumes" && (
              <DockerVolumesTab
                volumes={volumes}
                canManage={probe?.capabilities?.canManageContainers ?? false}
                onRefresh={listVolumes}
                onCreate={async (req) => {
                  const r = await createVolume(req);
                  showToast(r.message ?? (r.ok ? "已创建" : "创建失败"));
                  return r;
                }}
                onRemove={async (name) => {
                  const r = await removeVolume(name, false);
                  showToast(r.message ?? (r.ok ? "已删除" : "删除失败"));
                  return r;
                }}
                onPrune={async () => {
                  const r = await pruneVolumes();
                  showToast(r.message ?? (r.ok ? "已清理" : "清理失败"));
                  return r;
                }}
                onInspect={(name) => setVolumeDrawerName(name)}
              />
            )}

            {tab === "files" && (
              <DockerFilesTab
                containers={containers}
                files={files}
                filePath={filePath}
                fileContainerId={fileContainerId}
                onPickContainer={async (cid) => {
                  await listContainerDir(cid, "/");
                }}
                onEnter={async (entry) => {
                  if (!fileContainerId) return;
                  const next = filePath === "/" ? `/${entry.name}` : `${filePath}/${entry.name}`;
                  if (entry.isDir) {
                    await listContainerDir(fileContainerId, next);
                  } else {
                    const content = await readContainerFile(fileContainerId, next, 64 * 1024);
                    setFileEditor({ path: next, content });
                  }
                }}
              />
            )}

            {tab === "swarm" && selectedConnectionId && (
              <SwarmPanel connectionId={selectedConnectionId} />
            )}
            </div>
          </>
        )}
      </div>

      <ContainerDrawer
        connectionId={selectedConnectionId}
        containerId={drawerId}
        canExec={probe?.capabilities?.canContainerExec ?? false}
        canStreamLogs={probe?.capabilities?.canStreamLogs ?? false}
        hostLabel={selectedConnection?.hostLabel ?? null}
        sourceLabel={selectedConnection ? SOURCE_LABEL[selectedConnection.source] ?? selectedConnection.source : null}
        inspect={inspect}
        onClose={() => setDrawerId(null)}
        onAction={runContainerAction}
        onRemove={confirmContainerRemove}
        onNavigate={navigate}
        onSendToAi={(detail) => {
          const s = detail.summary;
          const ports = s.ports.length
            ? s.ports.map((p) => `${p.publicPort ?? "-"}->${p.privatePort}/${p.protocol}`).join(", ")
            : "无";
          const context = [
            `请帮我分析以下 Docker 容器的运行情况：`,
            `- 名称：${s.name}`,
            `- 镜像：${s.image}`,
            `- 状态：${s.state}（${s.statusText}）`,
            detail.exitCode != null ? `- 退出码：${detail.exitCode}` : null,
            detail.restartPolicy ? `- 重启策略：${detail.restartPolicy}` : null,
            `- 端口：${ports}`,
            `- 来源：${selectedConnection ? SOURCE_LABEL[selectedConnection.source] ?? selectedConnection.source : "未知"} · ${selectedConnection?.hostLabel ?? ""}`,
          ]
            .filter(Boolean)
            .join("\n");
          setAiDraft(context);
          openAiDrawer();
          recordAudit(`发送容器上下文给 AI：${s.name}`, `${selectedConnection?.name ?? ""} · ${s.image}`);
        }}
      />

      <DockerImageDrawer
        imageId={imageDrawerId}
        onClose={() => setImageDrawerId(null)}
        inspectImage={inspectImage}
        imageHistory={imageHistory}
        onRemove={async (id) => {
          const r = await removeImage(id, true);
          showToast(r.message ?? (r.ok ? "已删除" : "删除失败"));
          return r;
        }}
        onPrune={async () => {
          const r = await pruneImages();
          showToast(r.message ?? (r.ok ? "清理完成" : "清理失败"));
          return r;
        }}
        onCopyId={(id) => {
          void navigator.clipboard?.writeText(id).then(
            () => showToast("已复制镜像 ID"),
            () => showToast("复制失败")
          );
        }}
      />

      <DockerNetworkDrawer
        name={networkDrawerName}
        onClose={() => setNetworkDrawerName(null)}
        inspectNetwork={inspectNetwork}
        onRemove={async (name) => {
          const r = await removeNetwork(name);
          showToast(r.message ?? (r.ok ? "已删除" : "删除失败"));
          return r;
        }}
      />

      <DockerVolumeDrawer
        name={volumeDrawerName}
        onClose={() => setVolumeDrawerName(null)}
        inspectVolume={inspectVolume}
        onRemove={async (name) => {
          const r = await removeVolume(name, false);
          showToast(r.message ?? (r.ok ? "已删除" : "删除失败"));
          return r;
        }}
      />

      <DockerComposeDrawer
        project={composeProjects.find((p) => p.name === composeDrawerName) ?? null}
        onClose={() => setComposeDrawerName(null)}
        onAction={async (action, proj) => {
          const r = await composeAction(action as DockerComposeAction, proj.name);
          showToast(r.message ?? (r.ok ? "已执行" : "执行失败"));
          return r;
        }}
      />

      <DockerFileEditor
        open={fileEditor !== null}
        filePath={fileEditor?.path ?? null}
        initialContent={fileEditor?.content ?? ""}
        onClose={() => setFileEditor(null)}
        onSave={async (content) => {
          if (!fileEditor || !fileContainerId) {
            return { ok: false, message: "上下文丢失" };
          }
          const r = await writeContainerFile(fileContainerId, fileEditor.path, content);
          if (r.ok) {
            showToast(r.message ?? "已写入");
          } else {
            showToast(r.message ?? "写入失败");
          }
          return r;
        }}
      />

      {confirm && (
        <ConfirmModal confirm={confirm} onCancel={() => setConfirm(null)} />
      )}

      <DockerConnectionDialog
        open={showAddConn}
        onClose={() => setShowAddConn(false)}
        onSaved={() => {
          void reloadConnections();
        }}
      />

      <CreateContainerDialog
        open={showCreateContainer}
        connectionId={selectedConnectionId}
        onClose={() => setShowCreateContainer(false)}
        onCreated={() => {
          void refresh();
          showToast("容器创建成功");
        }}
      />

      {statsContainer && (
        <>
          <div className="drawer-overlay show" onClick={() => setStatsContainer(null)} />
          <aside
            className="docker-drawer docker-stats-drawer show"
            role="dialog"
            aria-label="资源监控"
            onClick={(e) => e.stopPropagation()}
          >
            <DockerStatsPanel
              connectionId={selectedConnectionId}
              containerId={statsContainer.id}
              containerName={statsContainer.name}
              onClose={() => setStatsContainer(null)}
            />
          </aside>
        </>
      )}

      {toast && <div className="docker-toast">{toast}</div>}
    </>
  );
}

function EmptyState({ icon, title, desc }: { icon: string; title: string; desc?: string }) {
  return (
    <div className="docker-empty-state">
      <div className="docker-empty-icon">{icon}</div>
      <div className="docker-empty-title">{title}</div>
      {desc && <div className="docker-empty-desc">{desc}</div>}
    </div>
  );
}

function useCountUp(target: number, duration = 600) {
  const [value, setValue] = useState(0);
  const prevRef = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const from = prevRef.current;
    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(from + (target - from) * eased);
      setValue(current);
      if (progress < 1) requestAnimationFrame(tick);
      else prevRef.current = target;
    };
    requestAnimationFrame(tick);
  }, [target, duration]);
  return value;
}

function StatCard({ color, value, label, icon }: { color: string; value: number; label: string; icon: "running" | "stopped" | "images" | "compose" }) {
  const animatedValue = useCountUp(value);
  const bg = `var(--${color}-soft)`;
  const fg = `var(--${color})`;
  const icons = {
    running: <DockerWhaleIcon />,
    stopped: <DockerWhaleIcon />,
    images: <ImageLayersIcon />,
    compose: <ComposeStackIcon />,
  };
  return (
    <div className="docker-stat">
      <div className="stat-icon" style={{ background: bg, color: fg }}>
        {icons[icon]}
      </div>
      <div className="stat-info">
        <span className="stat-val">{animatedValue}</span>
        <span className="stat-label">{label}</span>
      </div>
    </div>
  );
}

function portLabel(p: { ip: string | null; publicPort: number | null; privatePort: number; protocol: string }): string {
  if (p.publicPort != null) {
    return `${p.ip ?? "0.0.0.0"}:${p.publicPort}->${p.privatePort}/${p.protocol}`;
  }
  return `${p.privatePort}/${p.protocol}`;
}

interface ContainerDrawerProps {
  connectionId: string | null;
  containerId: string | null;
  canExec: boolean;
  canStreamLogs: boolean;
  hostLabel: string | null;
  sourceLabel: string | null;
  inspect: (id: string) => Promise<DockerContainerDetail | null>;
  onClose: () => void;
  onAction: (c: DockerContainerSummary, action: string, label: string) => void;
  onRemove: (c: DockerContainerSummary) => void;
  onNavigate: (path: string) => void;
  onSendToAi: (detail: DockerContainerDetail) => void;
}

type DrawerTab = "info" | "logs" | "terminal";

function ContainerDrawer({
  connectionId,
  containerId,
  canExec,
  canStreamLogs,
  hostLabel,
  sourceLabel,
  inspect,
  onClose,
  onAction,
  onRemove,
  onNavigate,
  onSendToAi,
}: ContainerDrawerProps) {
  const [detail, setDetail] = useState<DockerContainerDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("info");

  useEffect(() => {
    if (!containerId) {
      setDetail(null);
      return;
    }
    setDrawerTab("info");
    setLoading(true);
    let cancelled = false;
    void inspect(containerId).then((d) => {
      if (!cancelled) {
        setDetail(d);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [containerId, inspect]);

  const open = Boolean(containerId);

  return (
    <>
      <div className={`drawer-overlay${open ? " show" : ""}`} onClick={onClose} />
      <div className={`drawer${open ? " show" : ""}`}>
        {open && (
          <>
            <div className="drawer-header">
              <div className="container-icon" style={{ color: "var(--success)", width: 28, height: 28, display: "grid", placeItems: "center", background: "var(--success-soft)", borderRadius: "var(--r-sm)" }}>
                <ContainerIcon />
              </div>
              <h2>{detail?.summary.name ?? "加载中…"}</h2>
              {detail && (
                <span className={`badge ${detail.summary.running ? "badge-success" : "badge-muted"}`}>
                  {detail.summary.running ? "运行中" : "已停止"}
                </span>
              )}
              <Button variant="icon" onClick={onClose} title="关闭">
                <CloseIcon size={16} />
              </Button>
            </div>

            <div className="drawer-subtabs">
              <button className={`subtab${drawerTab === "info" ? " active" : ""}`} onClick={() => setDrawerTab("info")}>详情</button>
              <button
                className={`subtab${drawerTab === "logs" ? " active" : ""}`}
                disabled={!canStreamLogs}
                title={canStreamLogs ? "查看日志" : "当前连接不支持日志流式"}
                onClick={() => setDrawerTab("logs")}
              >
                日志
              </button>
              {canExec && detail?.summary.running && (
                <button className={`subtab${drawerTab === "terminal" ? " active" : ""}`} onClick={() => setDrawerTab("terminal")}>终端</button>
              )}
            </div>

            <div className="drawer-body">
              {loading && <div className="text-muted text-sm">加载容器详情…</div>}

              {!loading && detail && drawerTab === "info" && (
                <>
                  <div className="drawer-section">
                    <h4>容器信息</h4>
                    <dl className="drawer-kv">
                      <dt>ID</dt><dd className="text-muted">{detail.summary.shortId}</dd>
                      <dt>镜像</dt><dd>{detail.summary.image}</dd>
                      <dt>状态</dt><dd>{detail.summary.statusText || detail.summary.state}</dd>
                      {detail.command && (<><dt>命令</dt><dd className="text-muted">{detail.command}</dd></>)}
                      {detail.restartPolicy && (<><dt>重启策略</dt><dd>{detail.restartPolicy}</dd></>)}
                      {detail.exitCode != null && (<><dt>退出码</dt><dd>{detail.exitCode}</dd></>)}
                    </dl>
                  </div>

                  <div className="drawer-section">
                    <h4>端口</h4>
                    <dl className="drawer-kv">
                      {detail.summary.ports.length > 0 ? (
                        detail.summary.ports.map((p, i) => (
                          <div key={i} style={{ display: "contents" }}>
                            <dt>{i === 0 ? "映射" : `端口 ${i + 1}`}</dt>
                            <dd>{portLabel(p)}</dd>
                          </div>
                        ))
                      ) : (
                        <div style={{ display: "contents" }}><dt>端口</dt><dd>-</dd></div>
                      )}
                    </dl>
                  </div>

                  <div className="drawer-section">
                    <h4>挂载</h4>
                    <dl className="drawer-kv">
                      {detail.mounts.length > 0 ? (
                        detail.mounts.map((m, i) => (
                          <div key={i} style={{ display: "contents" }}>
                            <dt>{m.kind || "mount"}</dt>
                            <dd className="text-sm">{m.source} → {m.destination}{m.readOnly ? " (ro)" : ""}</dd>
                          </div>
                        ))
                      ) : (
                        <div style={{ display: "contents" }}><dt>挂载</dt><dd>-</dd></div>
                      )}
                    </dl>
                  </div>

                  <div className="drawer-section">
                    <h4>网络</h4>
                    <dl className="drawer-kv">
                      {detail.networks.length > 0 ? (
                        detail.networks.map((n, i) => (
                          <div key={i} style={{ display: "contents" }}>
                            <dt>{n.name}</dt>
                            <dd className="text-muted">{n.ipAddress ?? "-"}</dd>
                          </div>
                        ))
                      ) : (
                        <div style={{ display: "contents" }}><dt>网络</dt><dd>-</dd></div>
                      )}
                    </dl>
                  </div>

                  {detail.env.length > 0 && (
                    <div className="drawer-section">
                      <h4>环境变量</h4>
                      <dl className="drawer-kv">
                        {detail.env.map((e) => (
                          <div key={e.key} style={{ display: "contents" }}>
                            <dt>{e.key}</dt><dd className="text-sm">{e.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  )}

                  <div className="drawer-section">
                    <h4>联动</h4>
                    <div className="kv">
                      <span className="k">引擎来源</span>
                      <span className="v">{sourceLabel ?? "—"}</span>
                    </div>
                    <div className="kv">
                      <span className="k">宿主机</span>
                      <span className="v">{hostLabel ?? "—"}</span>
                    </div>
                    <div className="flex gap-2" style={{ flexWrap: "wrap", marginTop: "var(--sp-2)" }}>
                      <Button variant="secondary" size="sm" onClick={() => onNavigate("/ssh")}>
                        打开 SSH
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => onNavigate("/server")}>查看服务器</Button>
                      <Button variant="secondary" size="sm" onClick={() => onSendToAi(detail)}>发送给 AI 分析</Button>
                    </div>
                  </div>
                </>
              )}

              {!loading && detail && drawerTab === "logs" && (
                <LogsView connectionId={connectionId} containerId={containerId} />
              )}

              {!loading && detail && drawerTab === "terminal" && connectionId && containerId && (
                <div className="drawer-section">
                  <h4>容器终端</h4>
                  <DockerExecTerminal connectionId={connectionId} containerId={containerId} />
                </div>
              )}

              {!loading && !detail && (
                <div className="text-muted text-sm">无法获取容器详情，可能已被删除。</div>
              )}

              {detail && (
                <div className="flex gap-2" style={{ marginTop: "var(--sp-4)" }}>
                  {detail.summary.running ? (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => onAction(detail.summary, "restart", "重启")}>重启</Button>
                      <Button variant="secondary" size="sm" onClick={() => onAction(detail.summary, "stop", "停止")}>停止</Button>
                    </>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => onAction(detail.summary, "start", "启动")}>启动</Button>
                  )}
                  <Button variant="danger" size="sm" style={{ marginLeft: "auto" }} onClick={() => onRemove(detail.summary)}>删除</Button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function LogsView({ connectionId, containerId }: { connectionId: string | null; containerId: string | null }) {
  const [follow, setFollow] = useState(true);
  const { lines, streaming, error } = useContainerLogStream(connectionId, containerId, true, follow);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, follow]);

  return (
    <div className="drawer-section">
      <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
        <h4 style={{ margin: 0 }}>日志</h4>
        <span className="text-muted text-xs">{streaming ? "跟随中…" : "已结束"}</span>
        <label className="text-xs flex items-center gap-1" style={{ marginLeft: "auto", cursor: "pointer" }}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          自动滚动
        </label>
      </div>
      {error && <div className="text-danger text-sm" style={{ marginBottom: 6 }}>{error}</div>}
      <div className="log-viewer" ref={scrollRef} style={{ maxHeight: 360, overflow: "auto" }}>
        {lines.length === 0 ? (
          <div className="text-muted text-sm">{streaming ? "等待日志输出…" : "暂无日志"}</div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="log-line">
              <span className={line.stream === "stderr" ? "level-error" : "level-info"}>{line.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ConfirmModal({ confirm, onCancel }: { confirm: ConfirmState; onCancel: () => void }) {
  return (
    <>
      <div className="drawer-overlay show" onClick={onCancel} />
      <div className="confirm-modal">
        <h3>{confirm.title}</h3>
        <p className="text-sm">{confirm.message}</p>
        {confirm.detail && <p className="text-muted text-xs">{confirm.detail}</p>}
        <div className="flex gap-2" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <Button variant="secondary" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="danger" size="sm" onClick={confirm.onConfirm}>{confirm.confirmLabel}</Button>
        </div>
      </div>
    </>
  );
}

