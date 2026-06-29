import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useActionStore } from "../../stores/actionStore";
import { useAiStore } from "../../stores/aiStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useDockerTopbarStore } from "../../stores/dockerTopbarStore";
import { usePoolConnectionRegistration } from "../../stores/connectionPoolStore";
import { ModuleSegmentDock } from "../../components/dock";
import { ModuleWorkspaceLayout } from "../../components/workspace";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
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
import { LogViewer } from "../../components/ui/LogViewer";
import { DetailPanelModeToggle, DetailPanelShell } from "../../components/ui/DetailPanelShell";
import { WorkspaceEmptyPage } from "../../components/ui/WorkspaceEmptyPage";
import type { DockerConnectionDockOpenMode } from "./dockerConnectionWorkspaceTabs";
import { useDockerConnectionWorkspace } from "./hooks/useDockerConnectionWorkspace";
import { DockerConnectionSidebar } from "./DockerConnectionSidebar";
import { DockerSidebarLinkageProvider } from "./DockerSidebarLinkageContext";
import { ModuleEmptyState } from "../../components/ui/ModuleEmptyState";
import { IconAlertTriangle } from "../../components/ui/Icons";
import type { DockerComposeAction } from "../../ipc/bindings";
import { CreateContainerDialog } from "./CreateContainerDialog";
import { DockerOverviewTab } from "./DockerOverviewTab";
import { SwarmPanel } from "./SwarmPanel";
import { formatDockerTime } from "./format";
import {
  CloseIcon,
  ContainerIcon,
  PlayIcon,
  PushIcon,
  RestartIcon,
  StatsIcon,
  StopIcon,
  TagIcon,
  TrashIcon,
} from "./icons";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { dockerTabToSnapshot, addSnapshotToWorkspace } from "../../lib/workspaceTabActions";
import type {
  Connection,
  DockerContainerDetail,
  DockerContainerSummary,
  DockerLocalEngineStatus,
} from "../../ipc/bindings";
import { commands } from "../../ipc/bindings";
import { DOCKER_LOCAL_CONNECTION_ID, isBuiltinLocalDockerConnection } from "./constants";
import { useDockerWorkspaceTabs, type DockerWorkspaceTab, DOCKER_WORKSPACE_TABS } from "./dockerWorkspaceTabs";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";
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
  const isActiveRoute = location.pathname === "/module/docker";
  const navigate = useNavigate();
  const activeWorkspaceId = useWorkspaceStore((state) => state.workspace.id);
  const enqueueAction = useActionStore((s) => s.enqueueAction);
  const setAiDraft = useAiStore((s) => s.setDraftPrompt);
  const openAiDrawer = useAiStore((s) => s.openDrawer);
  const storedConnections = useConnectionStore((s) => s.connections);
  const removeStoredConnection = useConnectionStore((s) => s.remove);

  const [tab, setTab] = usePersistedModuleTab("docker", "overview", DOCKER_WORKSPACE_TABS);
  const docker = useDockerWorkspace(tab);
  const {
    connections,
    selectedConnection,
    selectedConnectionId,
    selectConnection,
    probe,
    overview,
    systemDiskUsage,
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
    pruneBuildCache,
    reloadConnections,
    scanning,
    scanSshDockerHosts,
  } = docker;

  const connectionWorkspace = useDockerConnectionWorkspace(connections);

  usePoolConnectionRegistration("docker", isActiveRoute ? selectedConnectionId : null);

  const isOffline = probe?.status === "offline";
  const partialLoadFailure =
    !dataLoading &&
    !dataRefreshing &&
    !isOffline &&
    (overview?.summary.containersTotal ?? 0) > 0 &&
    containers.length === 0;

  const [filter, setFilter] = useState<ContainerFilter>("all");
  const [query, setQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [partialLoadDismissed, setPartialLoadDismissed] = useState(false);
  const partialLoadAutoRetryRef = useRef(0);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [showAddConn, setShowAddConn] = useState(false);
  const [editDockerConnection, setEditDockerConnection] = useState<Connection | undefined>();
  const [statsContainer, setStatsContainer] = useState<{ id: string; name: string } | null>(null);
  const [imageDrawerId, setImageDrawerId] = useState<string | null>(null);
  const [networkDrawerName, setNetworkDrawerName] = useState<string | null>(null);
  const [volumeDrawerName, setVolumeDrawerName] = useState<string | null>(null);
  const [composeDrawerName, setComposeDrawerName] = useState<string | null>(null);
  const [fileEditor, setFileEditor] = useState<{ path: string; content: string } | null>(null);
  const [showCreateContainer, setShowCreateContainer] = useState(false);
  const [selectedContainers, setSelectedContainers] = useState<Set<string>>(new Set());
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [localEngineStatus, setLocalEngineStatus] = useState<DockerLocalEngineStatus | null>(null);
  const [startingLocalEngine, setStartingLocalEngine] = useState(false);
  const startPollRef = useRef<number | null>(null);
  const [drawerDetail, setDrawerDetail] = useState<DockerContainerDetail | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("info");

  // 抽屉打开 / 切换容器时拉取详情；drwerId 关闭后清空。
  useEffect(() => {
    if (!drawerId) {
      setDrawerDetail(null);
      setDrawerLoading(false);
      return;
    }
    setDrawerTab("info");
    setDrawerLoading(true);
    let cancelled = false;
    void inspect(drawerId).then((d) => {
      if (cancelled) return;
      setDrawerDetail(d);
      setDrawerLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [drawerId, inspect]);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3200);
  };

  const handleEditDockerConnection = (info: { connectionId: string }) => {
    const conn = storedConnections.find((c) => c.id === info.connectionId);
    if (!conn) {
      showToast(t("docker.sidebar.editFailed"));
      return;
    }
    setEditDockerConnection(conn);
    setShowAddConn(true);
  };

  const handleDeleteDockerConnection = async (connectionId: string) => {
    if (isBuiltinLocalDockerConnection(connectionId)) return;
    if (!(await appConfirm(t("docker.sidebar.deleteConfirm")))) return;
    await removeStoredConnection(connectionId);
    void reloadConnections();
    showToast(t("docker.sidebar.deleted"));
  };

  const handleStartLocalEngine = async () => {
    setStartingLocalEngine(true);
    const res = await commands.dockerStartLocalEngine();
    if (res.status === "error") {
      setStartingLocalEngine(false);
      showToast(res.error.message || t("docker.empty.startFailed"));
      return;
    }

    let attempts = 0;
    const poll = window.setInterval(async () => {
      attempts += 1;
      await refresh();
      const statusRes = await commands.dockerGetLocalEngineStatus();
      const running =
        statusRes.status === "ok"
          ? statusRes.data.running
          : probe?.status === "online";
      if (running || attempts >= 45) {
        window.clearInterval(poll);
        startPollRef.current = null;
        setStartingLocalEngine(false);
        if (statusRes.status === "ok") {
          setLocalEngineStatus(statusRes.data);
        }
        if (!running && attempts >= 45) {
          showToast(t("docker.empty.localEngine"));
        }
      }
    }, 2000);
    startPollRef.current = poll;
  };

  // 切换连接时复位抽屉/筛选等本地 UI（顶栏 Tab 与业务数据按模块/连接缓存保留）。
  useEffect(() => {
    setDrawerId(null);
    setFilter("all");
    setQuery("");
    setSearchInput("");
    setErrorDismissed(false);
    setPartialLoadDismissed(false);
    partialLoadAutoRetryRef.current = 0;
    setSelectedContainers(new Set());
    setSelectedImages(new Set());
  }, [selectedConnectionId]);

  // 从其他模块切回 Docker 时静默刷新，保留当前 UI 状态。
  const onDockerRouteRef = useRef(location.pathname === "/module/docker");
  useEffect(() => {
    const onDocker = location.pathname === "/module/docker";
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
          if (drawerId === container.id) {
            setDrawerId(null);
          }
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

  const confirmPruneVolumes = () => {
    setConfirm({
      title: t("docker.overview.disk.volumes"),
      message: t("docker.overview.pruneVolumesConfirm"),
      detail: selectedConnection?.name ?? "",
      confirmLabel: t("docker.overview.disk.release"),
      onConfirm: async () => {
        setConfirm(null);
        const res = await pruneVolumes();
        if (res.ok) {
          showToast(res.message ?? t("docker.overview.pruneDone"));
        } else {
          showToast(res.message ?? t("docker.overview.pruneFailed"));
        }
      },
    });
  };

  const confirmPruneBuildCache = () => {
    setConfirm({
      title: t("docker.overview.disk.buildCache"),
      message: t("docker.overview.pruneBuildCacheConfirm"),
      detail: selectedConnection?.name ?? "",
      confirmLabel: t("docker.overview.disk.release"),
      onConfirm: async () => {
        setConfirm(null);
        const res = await pruneBuildCache();
        if (res.ok) {
          showToast(res.message ?? t("docker.overview.pruneDone"));
        } else {
          showToast(res.message ?? t("docker.overview.pruneFailed"));
        }
      },
    });
  };

  const isLocalEngine = selectedConnection?.source === "local-engine";
  const showLocalEngineWelcome =
    isLocalEngine &&
    selectedConnectionId === DOCKER_LOCAL_CONNECTION_ID &&
    !connectionsLoading &&
    !dataLoading &&
    (isOffline || Boolean(error));

  useEffect(() => {
    if (!showLocalEngineWelcome) {
      setLocalEngineStatus(null);
      return;
    }
    let cancelled = false;
    void commands.dockerGetLocalEngineStatus().then((res) => {
      if (!cancelled && res.status === "ok") {
        setLocalEngineStatus(res.data);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [showLocalEngineWelcome]);

  useEffect(() => {
    return () => {
      if (startPollRef.current != null) {
        window.clearInterval(startPollRef.current);
      }
    };
  }, []);

  const workspaceTopbarTabs = useDockerWorkspaceTabs(tab);
  const dockerSegmentTabs = useMemo(
    () => workspaceTopbarTabs.map(({ id, label }) => ({ id, label })),
    [workspaceTopbarTabs],
  );


  /** dockview 面板内容不随父级 state 自动重绘；数据/筛选/选中变化时 bump */
  const dockerPanelContentKey = useMemo(
    () =>
      [
        selectedConnectionId ?? "",
        tab,
        connectionsLoading ? 1 : 0,
        dataLoading ? 1 : 0,
        dataRefreshing ? 1 : 0,
        connections.length,
        containers.length,
        images.length,
        networks.length,
        volumes.length,
        composeProjects.length,
        overview?.summary.containersTotal ?? -1,
        probe?.status ?? "",
        error ?? "",
        filter,
        query,
        selectedContainers.size,
        selectedImages.size,
        errorDismissed ? 1 : 0,
        partialLoadDismissed ? 1 : 0,
        showLocalEngineWelcome ? 1 : 0,
        startingLocalEngine ? 1 : 0,
      ].join("|"),
    [
      selectedConnectionId,
      tab,
      connectionsLoading,
      dataLoading,
      dataRefreshing,
      connections.length,
      containers.length,
      images.length,
      networks.length,
      volumes.length,
      composeProjects.length,
      overview?.summary.containersTotal,
      probe?.status,
      error,
      filter,
      query,
      selectedContainers.size,
      selectedImages.size,
      errorDismissed,
      partialLoadDismissed,
      showLocalEngineWelcome,
      startingLocalEngine,
    ],
  );
  
  useEffect(() => {
    useDockerTopbarStore.getState().setRefreshing(dataRefreshing);
  }, [dataRefreshing]);

  const refreshSignal = useDockerTopbarStore((s) => s.refreshSignal);
  useEffect(() => {
    if (!refreshSignal) return;
    if (connectionsLoading || !selectedConnectionId) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  // 概览统计已到位但列表未齐时自动重试，避免 SSH 串行加载中途被取消后一直卡住。
  useEffect(() => {
    if (!isActiveRoute || !partialLoadFailure || dataLoading || dataRefreshing) return;
    if (partialLoadAutoRetryRef.current >= 2) return;
    const timer = window.setTimeout(() => {
      partialLoadAutoRetryRef.current += 1;
      refresh();
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [isActiveRoute, partialLoadFailure, dataLoading, dataRefreshing, refresh]);

  useEffect(() => {
    if (!partialLoadFailure) {
      partialLoadAutoRetryRef.current = 0;
    }
  }, [partialLoadFailure]);

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

  const handleScanSshDocker = async () => {
    const result = await scanSshDockerHosts(true);
    if (!result) {
      showToast("扫描失败");
      return;
    }
    showToast(
      `扫描完成：新增 ${result.created}，更新 ${result.updated}，无 Docker ${result.noDocker}，失败 ${result.failed}`,
    );
  };

  const resolvedConnectionId = connectionWorkspace.activeConnectionId ?? selectedConnectionId;

  const sidebarLinkageValue = useMemo(
    () => ({
      activeConnectionId: resolvedConnectionId,
    }),
    [resolvedConnectionId],
  );

  const handleSidebarSelectConnection = useCallback(
    (connectionId: string, mode?: DockerConnectionDockOpenMode) => {
      connectionWorkspace.handleSelectConnection(connectionId, mode);
      selectConnection(connectionId);
    },
    [connectionWorkspace, selectConnection],
  );

  const dockerDeepLinkHandledRef = useRef(false);
  useEffect(() => {
    if (dockerDeepLinkHandledRef.current || connectionsLoading) return;
    const state = location.state as { selectDockerConnectionId?: string } | null;
    const targetId = state?.selectDockerConnectionId;
    if (!targetId || !connections.some((c) => c.connectionId === targetId)) return;
    dockerDeepLinkHandledRef.current = true;
    handleSidebarSelectConnection(targetId);
    window.history.replaceState({}, "");
  }, [connections, connectionsLoading, handleSidebarSelectConnection, location.state]);

  useEffect(() => {
    if (connectionsLoading || !selectedConnectionId) {
      return;
    }
    const { activeConnectionId, handleSelectConnection } = connectionWorkspace;
    if (activeConnectionId !== selectedConnectionId) {
      handleSelectConnection(selectedConnectionId, "permanent");
    }
  }, [
    selectedConnectionId,
    connectionsLoading,
    connectionWorkspace.activeConnectionId,
    connectionWorkspace.handleSelectConnection,
  ]);

  const renderDockerSegmentContent = useCallback(
    (segmentTabId: DockerWorkspaceTab, connectionId: string, isActive: boolean) => {
      if (!isActive) {
        return <div className="docker-connection-tab-pane" aria-hidden />;
      }

      return (
        <div className="docker-main">
          <div className="docker-layout">
        {connectionsLoading ? (
          <div className="docker-empty">正在加载 Docker 连接…</div>
        ) : connections.length === 0 ? (
          <div className="docker-empty">
            <div className="docker-empty-title">暂无 Docker 连接</div>
            <div className="text-muted text-sm" style={{ marginTop: 8 }}>
              {scanning ? "正在扫描 SSH 主机中的 Docker…" : "可扫描已配置 SSH 自动发现 Docker 连接"}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "center" }}>
              <Button variant="secondary" size="sm" disabled={scanning} onClick={() => void handleScanSshDocker()}>
                {scanning ? "扫描中…" : "扫描 SSH Docker"}
              </Button>
              <Button variant="primary" size="sm" onClick={() => setShowAddConn(true)}>
                添加 Docker 连接
              </Button>
            </div>
          </div>
        ) : selectedConnectionId !== connectionId ? (
          <div className="docker-empty">正在切换连接…</div>
        ) : (
          <>
            {isOffline && !showLocalEngineWelcome && (
              <div className="docker-empty" style={{ minHeight: 80, padding: "16px 0" }}>
                <div className="docker-empty-title">Docker 未安装或未启动</div>
                <div className="text-muted text-sm">{probe?.warningMessage ?? error ?? "无法连接到 Docker Engine"}</div>
                <Button variant="secondary" size="sm" style={{ marginTop: 12 }} onClick={refresh}>
                  重试
                </Button>
              </div>
            )}

            {error && !isOffline && !errorDismissed && (
              <div className="docker-error-banner">
                <IconAlertTriangle size={16} className="docker-error-icon" />
                <span className="docker-error-text">{error}</span>
                <button className="docker-error-dismiss" onClick={() => setErrorDismissed(true)}>×</button>
              </div>
            )}

            {partialLoadFailure && !partialLoadDismissed && (
              <div className="docker-floating-notice" role="status">
                <IconAlertTriangle size={16} className="docker-error-icon" />
                <span className="docker-floating-notice-text">部分数据仍在加载，可点击顶栏刷新重试</span>
                <button
                  type="button"
                  className="docker-floating-notice-action"
                  disabled={dataRefreshing}
                  onClick={() => refresh()}
                >
                  {dataRefreshing ? t("docker.overview.refreshing") : t("common.refresh")}
                </button>
                <button
                  type="button"
                  className="docker-floating-notice-dismiss"
                  aria-label={t("common.cancel")}
                  onClick={() => setPartialLoadDismissed(true)}
                >
                  ×
                </button>
              </div>
            )}

            <div key={segmentTabId} className="docker-tab-content">
            {segmentTabId === "overview" && showLocalEngineWelcome && (
              <WorkspaceEmptyPage
                prompt={t("docker.empty.localEngine")}
                actions={
                  <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                    {localEngineStatus?.canStart ? (
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={startingLocalEngine}
                        onClick={() => void handleStartLocalEngine()}
                      >
                        {startingLocalEngine ? t("docker.empty.startingDocker") : t("docker.empty.startDocker")}
                      </Button>
                    ) : null}
                    <Button variant="secondary" size="sm" disabled={startingLocalEngine} onClick={refresh}>
                      {t("common.refresh")}
                    </Button>
                  </div>
                }
              />
            )}
            {segmentTabId === "overview" && !showLocalEngineWelcome && (
              <DockerOverviewTab
                overview={overview}
                systemDiskUsage={systemDiskUsage}
                probe={probe}
                connection={selectedConnection}
                containersTotal={counts.all}
                containersRunning={counts.running}
                images={images}
                composeProjects={composeProjects}
                networks={networks}
                volumes={volumes}
                canManage={probe?.capabilities?.canManageContainers ?? false}
                onNavigateTab={setTab}
                onEditConnection={() => selectedConnection && handleEditDockerConnection(selectedConnection)}
                onPruneImages={confirmPrune}
                onPruneVolumes={confirmPruneVolumes}
                onPruneBuildCache={confirmPruneBuildCache}
              />
            )}

            {segmentTabId === "containers" && (
              <>
                {isOffline ? (
                  <ModuleEmptyState preset="container" title="Docker 未连接" desc={probe?.warningMessage ?? "请先启动 Docker Engine"} />
                ) : (
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
                      {dataLoading && containers.length === 0 ? "加载中…" : partialLoadFailure ? (
                        <div className="text-muted text-sm">容器列表加载未完成，请点击顶栏刷新按钮重试。</div>
                      ) : (
                        <ModuleEmptyState
                          preset="container"
                          title="暂无容器"
                          desc="创建或拉取一个容器开始使用"
                        />
                      )}
                    </div>
                  ) : (
                    filteredContainers.map((container) => (
                      <div
                        key={container.id}
                        className="container-card container-card-5"
                        style={!container.running ? { opacity: 0.65 } : undefined}
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
                        <div className="port-tags">
                          {container.ports.length > 0 ? (
                            container.ports.map((p, i) => (
                              <span key={i} className="tag port-tag" title={portLabel(p)}>
                                {portLabel(p)}
                              </span>
                            ))
                          ) : (
                            <span className="text-sm text-muted">-</span>
                          )}
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
              </>
            )}

            {segmentTabId === "images" && (
              isOffline ? (
                <ModuleEmptyState preset="image" title="Docker 未连接" desc={probe?.warningMessage ?? "请先启动 Docker Engine"} />
              ) : (
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
                  <div className="docker-empty" style={{ minHeight: 120 }}>
                    {dataLoading && images.length === 0 ? "加载中…" : (
                      <ModuleEmptyState preset="image" title="暂无镜像" desc="拉取或构建镜像" />
                    )}
                  </div>
                ) : (
                  images.map((img, idx) => (
                    <div
                      key={`${img.id}-${img.repository}-${img.tag}-${idx}`}
                      className="container-card image-row"
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
              )
            )}

            {segmentTabId === "compose" && (
              isOffline ? (
                <ModuleEmptyState preset="compose" title="Docker 未连接" desc={probe?.warningMessage ?? "请先启动 Docker Engine"} />
              ) : (
              <div className="container-list">
                {composeProjects.length === 0 ? (
                  <div className="docker-empty" style={{ minHeight: 120 }}>
                    {dataLoading && composeProjects.length === 0 ? "加载中…" : (
                      <ModuleEmptyState preset="compose" title="未识别到 Compose 项目" />
                    )}
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
              )
            )}

            {segmentTabId === "networks" && (
              isOffline ? (
                <ModuleEmptyState preset="network" title="Docker 未连接" desc={probe?.warningMessage ?? "请先启动 Docker Engine"} />
              ) : (
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
              )
            )}

            {segmentTabId === "volumes" && (
              isOffline ? (
                <ModuleEmptyState preset="volume" title="Docker 未连接" desc={probe?.warningMessage ?? "请先启动 Docker Engine"} />
              ) : (
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
              )
            )}

            {segmentTabId === "files" && (
              isOffline ? (
                <ModuleEmptyState preset="file" title="Docker 未连接" desc={probe?.warningMessage ?? "请先启动 Docker Engine"} />
              ) : (
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
              )
            )}

            {segmentTabId === "swarm" && selectedConnectionId && (
              isOffline ? (
                <ModuleEmptyState preset="container" title="Docker 未连接" desc={probe?.warningMessage ?? "请先启动 Docker Engine"} />
              ) : (
              <SwarmPanel connectionId={selectedConnectionId} />
              )
            )}
            </div>
          </>
        )}
          </div>
        </div>
      );
    },
    [
      connectionsLoading,
      connections.length,
      scanning,
      selectedConnectionId,
      isOffline,
      showLocalEngineWelcome,
      error,
      errorDismissed,
      partialLoadFailure,
      partialLoadDismissed,
      dataRefreshing,
      dataLoading,
      overview,
      systemDiskUsage,
      probe,
      selectedConnection,
      counts,
      images,
      composeProjects,
      networks,
      volumes,
      filter,
      filteredContainers,
      selectedContainers,
      searchInput,
      containers,
      files,
      filePath,
      fileContainerId,
      localEngineStatus,
      startingLocalEngine,
      t,
      handleScanSshDocker,
      refresh,
      handleStartLocalEngine,
      handleEditDockerConnection,
      confirmPrune,
      confirmPruneVolumes,
      confirmPruneBuildCache,
      setFilter,
      batchRemoveContainers,
      setShowCreateContainer,
      setSearchInput,
      toggleContainerSelect,
      setDrawerId,
      runContainerAction,
      confirmContainerRemove,
      setStatsContainer,
      selectedImages,
      toggleImageSelect,
      batchRemoveImages,
      setImageDrawerId,
      confirmImageRemove,
      pullImage,
      pushImage,
      tagImage,
      buildImage,
      setComposeDrawerName,
      composeAction,
      setNetworkDrawerName,
      createNetwork,
      removeNetwork,
      setVolumeDrawerName,
      createVolume,
      removeVolume,
      listContainerDir,
      readContainerFile,
      setFileEditor,
    ],
  );

  return (
    <>
      <DockerSidebarLinkageProvider value={sidebarLinkageValue}>
        <ModuleWorkspaceLayout
          layoutKey="docker-connections"
          className="docker-connections-workspace"
          leftColumnTitle={t("routes.docker")}
          leftPreset="server"
          leftSidebar={
            <DockerConnectionSidebar
              connections={connections}
              loading={connectionsLoading}
              scanning={scanning}
              onSelectConnection={handleSidebarSelectConnection}
              onCreate={() => {
                setEditDockerConnection(undefined);
                setShowAddConn(true);
              }}
              onScan={() => void handleScanSshDocker()}
              onEditConnection={handleEditDockerConnection}
              onDeleteConnection={(id) => void handleDeleteDockerConnection(id)}
            />
          }
        >
          <ModuleSegmentDock
            className="docker-module-dock"
            variant="function"
            tabs={dockerSegmentTabs}
            activeTabId={tab}
            onActiveTabChange={(id) => setTab(id as DockerWorkspaceTab)}
            enabled={isActiveRoute}
            panelContentKey={dockerPanelContentKey}
            renderPanel={(segmentTabId) =>
              resolvedConnectionId ? (
                renderDockerSegmentContent(
                  segmentTabId as DockerWorkspaceTab,
                  resolvedConnectionId,
                  true,
                )
              ) : (
                <WorkspaceEmptyPage
                  title={t("routes.docker")}
                  prompt={t("docker.sidebar.selectConnection")}
                />
              )
            }
          />
        </ModuleWorkspaceLayout>
      </DockerSidebarLinkageProvider>

      <DetailPanelShell
        open={Boolean(drawerId)}
        onClose={() => setDrawerId(null)}
        ariaLabel={t("docker.drawer.containerDetail")}
        floatingTitle={t("docker.drawer.popoutTitle", {
          name: drawerDetail?.summary.name ?? "…",
        })}
        variant="drawer"
        widthRatio={0.7}
        heightRatio={0.85}
      >
        {drawerId ? (
          <ContainerDrawerBody
            key={`${selectedConnectionId ?? "unknown"}:${drawerId}`}
            connectionId={selectedConnectionId}
            containerId={drawerId}
            activeWorkspaceId={activeWorkspaceId}
            canExec={probe?.capabilities?.canContainerExec ?? false}
            canStreamLogs={probe?.capabilities?.canStreamLogs ?? false}
            hostLabel={selectedConnection?.hostLabel ?? null}
            sourceLabel={selectedConnection ? SOURCE_LABEL[selectedConnection.source] ?? selectedConnection.source : null}
            detail={drawerDetail}
            loading={drawerLoading}
            drawerTab={drawerTab}
            onTabChange={setDrawerTab}
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
            onClose={() => setDrawerId(null)}
          />
        ) : null}
      </DetailPanelShell>

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
        onClose={() => {
          setShowAddConn(false);
          setEditDockerConnection(undefined);
        }}
        editConnection={editDockerConnection}
        onSaved={() => {
          void reloadConnections();
          setEditDockerConnection(undefined);
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
        <DetailPanelShell
          open
          onClose={() => setStatsContainer(null)}
          ariaLabel="资源监控"
          floatingTitle={`资源监控 — ${statsContainer.name}`}
          variant="drawer"
          drawerClassName="docker-stats-drawer"
          widthRatio={0.45}
          heightRatio={0.7}
        >
          <DockerStatsPanel
            connectionId={selectedConnectionId}
            containerId={statsContainer.id}
            containerName={statsContainer.name}
            onClose={() => setStatsContainer(null)}
          />
        </DetailPanelShell>
      )}

      {toast && <div className="docker-toast">{toast}</div>}
    </>
  );
}

function portLabel(p: { ip: string | null; publicPort: number | null; privatePort: number; protocol: string }): string {
  if (p.publicPort != null) {
    return `${p.ip ?? "0.0.0.0"}:${p.publicPort}->${p.privatePort}/${p.protocol}`;
  }
  return `${p.privatePort}/${p.protocol}`;
}

interface ContainerDrawerBodyProps {
  connectionId: string | null;
  containerId: string | null;
  activeWorkspaceId: string;
  canExec: boolean;
  canStreamLogs: boolean;
  hostLabel: string | null;
  sourceLabel: string | null;
  detail: DockerContainerDetail | null;
  loading: boolean;
  drawerTab: DrawerTab;
  onTabChange: (tab: DrawerTab) => void;
  onAction: (c: DockerContainerSummary, action: string, label: string) => void;
  onRemove: (c: DockerContainerSummary) => void;
  onNavigate: (path: string) => void;
  onSendToAi: (detail: DockerContainerDetail) => void;
  onClose?: () => void;
}

type DrawerTab = "info" | "logs" | "terminal";

function ContainerDrawerBody({
  connectionId,
  containerId,
  activeWorkspaceId,
  canExec,
  canStreamLogs,
  hostLabel,
  sourceLabel,
  detail,
  loading,
  drawerTab,
  onTabChange,
  onAction,
  onRemove,
  onNavigate,
  onSendToAi,
  onClose,
}: ContainerDrawerBodyProps) {
  const [logsMounted, setLogsMounted] = useState(false);
  const [terminalMounted, setTerminalMounted] = useState(false);


  const canShowTerminal = Boolean(
    !loading && detail?.summary.running && canExec && connectionId && containerId,
  );

  // 切换容器时重置；同一容器内 Tab 仅隐藏/显示，不断开日志流与 exec PTY。
  useEffect(() => {
    setLogsMounted(false);
    setTerminalMounted(false);
  }, [containerId, connectionId]);

  useEffect(() => {
    if (drawerTab === "logs" && canStreamLogs && connectionId && containerId) {
      setLogsMounted(true);
    }
  }, [drawerTab, canStreamLogs, connectionId, containerId]);

  useEffect(() => {
    if (drawerTab === "terminal" && canShowTerminal) {
      setTerminalMounted(true);
    }
  }, [drawerTab, canShowTerminal]);

  return (
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
        <div className="drawer-header-actions">
          <DetailPanelModeToggle />
          {onClose ? (
            <Button variant="icon" onClick={onClose} title="关闭" aria-label="关闭">
              <CloseIcon size={16} />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="drawer-subtabs">
        <button className={`subtab${drawerTab === "info" ? " active" : ""}`} onClick={() => onTabChange("info")}>详情</button>
        <button
          className={`subtab${drawerTab === "logs" ? " active" : ""}`}
          disabled={!canStreamLogs}
          title={canStreamLogs ? "查看日志" : "当前连接不支持日志流式"}
          onClick={() => onTabChange("logs")}
        >
          日志
        </button>
        {canExec && detail?.summary.running && (
          <button className={`subtab${drawerTab === "terminal" ? " active" : ""}`} onClick={() => onTabChange("terminal")}>终端</button>
        )}
        {(drawerTab === "logs" || drawerTab === "terminal") && connectionId && containerId && (
          <button
            className="subtab subtab--action"
            title="复制到工作区"
            onClick={() => {
              if (!activeWorkspaceId) return;
              const name = detail?.summary.name ?? containerId;
              const snapshot = dockerTabToSnapshot(drawerTab, connectionId, containerId, name);
              addSnapshotToWorkspace(activeWorkspaceId, snapshot);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
              <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
          </button>
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
                <Button variant="secondary" size="sm" onClick={() => onNavigate("/module/ssh")}>
                  打开 SSH
                </Button>
                <Button variant="secondary" size="sm" onClick={() => onNavigate("/module/server")}>查看服务器</Button>
                <Button variant="secondary" size="sm" onClick={() => onSendToAi(detail)}>发送给 AI 分析</Button>
              </div>
            </div>
          </>
        )}

        {!loading && detail && logsMounted && (
          <div className="drawer-section docker-drawer-tab-panel" hidden={drawerTab !== "logs"}>
            <LogsView
              connectionId={connectionId}
              containerId={containerId}
              visible={drawerTab === "logs"}
            />
          </div>
        )}

        {canShowTerminal && terminalMounted && (
          <div className="drawer-section docker-exec-drawer-section" hidden={drawerTab !== "terminal"}>
            <h4>容器终端</h4>
            <DockerExecTerminal
              connectionId={connectionId!}
              containerId={containerId!}
              visible={drawerTab === "terminal"}
            />
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
  );
}

function LogsView({
  connectionId,
  containerId,
  visible,
}: {
  connectionId: string | null;
  containerId: string | null;
  visible: boolean;
}) {
  const { t } = useI18n();
  const [follow, setFollow] = useState(true);
  const { lines, streaming, error } = useContainerLogStream(connectionId, containerId, true, follow);

  const logText = useMemo(
    () => lines.map((line) => line.message).join("\n"),
    [lines],
  );

  return (
    <LogViewer
      className="docker-drawer-logs"
      text={logText}
      streaming
      visible={visible}
      autoScroll={follow}
      copyOnSelect
      loading={streaming && lines.length === 0}
      loadingText={t("docker.logs.waiting")}
      emptyText={streaming ? t("docker.logs.waiting") : t("logViewer.empty")}
      error={error}
      toolbar={
        <>
          <h4 style={{ margin: 0, fontSize: 13 }}>日志</h4>
          <span className="text-muted text-xs">{streaming ? "跟随中…" : "已结束"}</span>
          <label className="text-xs flex items-center gap-1 log-viewer-panel__hint" style={{ marginLeft: "auto", cursor: "pointer" }}>
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            自动滚动
          </label>
        </>
      }
      footer={<span className="log-viewer-panel__footer-text">{t("logViewer.lineCount", { count: lines.length })}</span>}
    />
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

