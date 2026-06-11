import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands } from "../../ipc/bindings";
import { useConnectionStore } from "../../stores/connectionStore";
import type {
  DockerComposeProject,
  DockerConnectionInfo,
  DockerContainerDetail,
  DockerContainerSummary,
  DockerCreateNetworkRequest,
  DockerCreateVolumeRequest,
  DockerFileEntry,
  DockerImageDetail,
  DockerImageHistoryLayer,
  DockerImageSummary,
  DockerLogLine,
  DockerNetworkDetail,
  DockerNetworkSummary,
  DockerOverview,
  DockerProbe,
  DockerScanResult,
  DockerVolumeDetail,
  DockerVolumeSummary,
} from "../../ipc/bindings";

/**
 * 与后端 `DockerImageProgress` 对应：镜像拉取/推送/构建进度事件。
 * 该类型通过 `app.emit` 推送，不在 IPC 命令签名中，故不在 bindings.ts 自动导出；
 * 此处手动声明一份以保持类型安全。
 */
export interface DockerImageProgress {
  id: string;
  status: string;
  progress: number | null;
  detail: string | null;
}

export type ContainerFilter = "all" | "running" | "stopped";

export interface DockerActionResult {
  ok: boolean;
  message?: string;
}

interface DockerWorkspaceState {
  connections: DockerConnectionInfo[];
  selectedConnectionId: string | null;
  probe: DockerProbe | null;
  overview: DockerOverview | null;
  containers: DockerContainerSummary[];
  images: DockerImageSummary[];
  composeProjects: DockerComposeProject[];
  networks: DockerNetworkSummary[];
  volumes: DockerVolumeSummary[];
  files: DockerFileEntry[];
  filePath: string;
  fileContainerId: string | null;
  connectionsLoading: boolean;
  /** 首次加载或无缓存数据时为 true，会显示列表占位「加载中」 */
  dataLoading: boolean;
  /** 后台刷新中为 true，仅用于刷新按钮状态，不遮挡内容 */
  dataRefreshing: boolean;
  error: string | null;
}

/** 统一处理 typedError 结果，返回数据或抛出消息。 */
async function unwrap<T>(promise: Promise<{ status: "ok"; data: T } | { status: "error"; error: { message: string } }>): Promise<T> {
  const res = await promise;
  if (res.status === "ok") return res.data;
  throw new Error(res.error.message);
}

/**
 * Docker 工作区数据入口：统一管理连接、探测、容器/镜像/Compose 列表与生命周期动作。
 * 所有数据来自真实 IPC（omnipanel-docker），不再依赖 mock。
 */
export function useDockerWorkspace() {
  const [state, setState] = useState<DockerWorkspaceState>({
    connections: [],
    selectedConnectionId: null,
    probe: null,
    overview: null,
    containers: [],
    images: [],
    composeProjects: [],
    networks: [],
    volumes: [],
    files: [],
    filePath: "/",
    fileContainerId: null,
    connectionsLoading: true,
    dataLoading: false,
    dataRefreshing: false,
    error: null,
  });

  // 用 ref 保存当前选中连接与镜像列表，避免闭包捕获过期值。
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = state.selectedConnectionId;
  const loadedConnectionsRef = useRef<Set<string>>(new Set());
  const prevConnectionRef = useRef<string | null>(null);
  const imagesRef = useRef<DockerImageSummary[]>([]);
  imagesRef.current = state.images;
  const [scanning, setScanning] = useState(false);
  const [lastScanResult, setLastScanResult] = useState<DockerScanResult | null>(null);
  const autoScanDoneRef = useRef(false);

  const loadConnections = useCallback(async () => {
    setState((s) => ({ ...s, connectionsLoading: true }));
    try {
      const connections = await unwrap(commands.dockerListConnections());
      setState((s) => {
        const stillValid = connections.some((c) => c.connectionId === s.selectedConnectionId);
        return {
          ...s,
          connections,
          selectedConnectionId: stillValid ? s.selectedConnectionId : connections[0]?.connectionId ?? null,
          connectionsLoading: false,
        };
      });
    } catch (e) {
      setState((s) => ({ ...s, connectionsLoading: false, error: String(e) }));
    }
  }, []);

  const scanSshDockerHosts = useCallback(
    async (autoSave = true): Promise<DockerScanResult | null> => {
      setScanning(true);
      try {
        const result = await unwrap(commands.dockerScanSshDockerHosts(autoSave));
        setLastScanResult(result);
        if (autoSave && (result.created > 0 || result.updated > 0)) {
          await useConnectionStore.getState().refresh();
          await loadConnections();
        }
        return result;
      } catch (e) {
        setState((s) => ({ ...s, error: String(e) }));
        return null;
      } finally {
        setScanning(false);
      }
    },
    [loadConnections],
  );

  useEffect(() => {
    if (autoScanDoneRef.current) return;
    autoScanDoneRef.current = true;
    void scanSshDockerHosts(true);
  }, [scanSshDockerHosts]);

  /** 加载选中连接的探测、总览、容器、镜像、Compose。 */
  const loadConnectionData = useCallback(async (connectionId: string, options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    setState((s) => ({
      ...s,
      error: null,
      dataLoading: silent ? s.dataLoading : true,
      dataRefreshing: silent ? true : s.dataRefreshing,
    }));

    const finishLoading = (patch: Partial<DockerWorkspaceState>) => {
      setState((s) => ({
        ...s,
        ...patch,
        dataLoading: false,
        dataRefreshing: false,
      }));
    };

    // 先探测连通性。
    let probe: DockerProbe | null = null;
    try {
      probe = await unwrap(commands.dockerProbeConnection(connectionId));
    } catch (e) {
      if (silent) {
        setState((s) => ({ ...s, dataRefreshing: false, error: String(e) }));
        return;
      }
      finishLoading({
        probe: null,
        overview: null,
        containers: [],
        images: [],
        composeProjects: [],
        networks: [],
        volumes: [],
        files: [],
        error: String(e),
      });
      return;
    }

    if (selectedRef.current !== connectionId) {
      setState((s) => ({ ...s, dataLoading: false, dataRefreshing: false }));
      return;
    }

    // 把探测得到的状态/版本回填到连接列表。
    setState((s) => ({
      ...s,
      probe,
      connections: s.connections.map((c) =>
        c.connectionId === connectionId
          ? {
              ...c,
              status: probe!.status,
              engineVersion: probe!.engineVersion,
              apiVersion: probe!.apiVersion,
              warningMessage: probe!.warningMessage,
            }
          : c
      ),
    }));

    if (probe.status === "offline") {
      if (silent) {
        setState((s) => ({
          ...s,
          probe,
          dataRefreshing: false,
          error: probe?.warningMessage ?? "Docker 未安装或未启动",
        }));
        return;
      }
      finishLoading({
        overview: null,
        containers: [],
        images: [],
        composeProjects: [],
        networks: [],
        volumes: [],
        error: probe?.warningMessage ?? "Docker 未安装或未启动",
      });
      return;
    }

    // 并行拉取业务数据；单项失败不阻断其余。
    const [overview, containers, images, composeProjects, networks, volumes] = await Promise.all([
      unwrap(commands.dockerGetOverview(connectionId)).catch(() => null),
      unwrap(commands.dockerListContainers(connectionId, null)).catch(() => []),
      unwrap(commands.dockerListImages(connectionId)).catch(() => []),
      unwrap(commands.dockerListComposeProjects(connectionId)).catch(() => []),
      unwrap(commands.dockerListNetworks(connectionId)).catch(() => []),
      unwrap(commands.dockerListVolumes(connectionId)).catch(() => []),
    ]);

    if (selectedRef.current !== connectionId) {
      setState((s) => ({ ...s, dataLoading: false, dataRefreshing: false }));
      return;
    }
    loadedConnectionsRef.current.add(connectionId);
    finishLoading({
      overview,
      containers,
      images,
      composeProjects,
      networks,
      volumes,
    });
  }, []);

  // 初始化加载连接列表。
  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  // 选中连接变化时加载数据。
  useEffect(() => {
    const id = state.selectedConnectionId;
    if (!id) return;

    const switched =
      prevConnectionRef.current !== null && prevConnectionRef.current !== id;
    prevConnectionRef.current = id;

    if (switched) {
      setState((s) => ({
        ...s,
        probe: null,
        overview: null,
        containers: [],
        images: [],
        composeProjects: [],
        networks: [],
        volumes: [],
        files: [],
        filePath: "/",
        fileContainerId: null,
      }));
    }

    const silent = loadedConnectionsRef.current.has(id);
    void loadConnectionData(id, { silent });
  }, [state.selectedConnectionId, loadConnectionData]);

  const selectConnection = useCallback((id: string) => {
    setState((s) => (s.selectedConnectionId === id ? s : { ...s, selectedConnectionId: id }));
  }, []);

  const refresh = useCallback(() => {
    const id = selectedRef.current;
    if (id) void loadConnectionData(id, { silent: true });
  }, [loadConnectionData]);

  /** 仅刷新容器列表（动作后轻量刷新）。 */
  const refreshContainers = useCallback(async () => {
    const id = selectedRef.current;
    if (!id) return;
    try {
      const containers = await unwrap(commands.dockerListContainers(id, null));
      if (selectedRef.current === id) setState((s) => ({ ...s, containers }));
    } catch {
      /* 忽略，保留旧数据 */
    }
  }, []);

  const containerAction = useCallback(
    async (containerId: string, action: string): Promise<DockerActionResult> => {
      const id = selectedRef.current;
      if (!id) return { ok: false, message: "未选择连接" };
      try {
        await unwrap(commands.dockerContainerAction(id, containerId, action));
        await refreshContainers();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    },
    [refreshContainers]
  );

  const inspect = useCallback(
    async (containerId: string): Promise<DockerContainerDetail | null> => {
      const id = selectedRef.current;
      if (!id) return null;
      try {
        return await unwrap(commands.dockerInspectContainer(id, containerId));
      } catch {
        return null;
      }
    },
    []
  );

  const inspectImage = useCallback(
    async (imageId: string): Promise<DockerImageDetail | null> => {
      const id = selectedRef.current;
      if (!id) return null;
      try {
        return await unwrap(commands.dockerInspectImage(id, imageId));
      } catch {
        return null;
      }
    },
    []
  );

  const imageHistory = useCallback(
    async (imageId: string): Promise<DockerImageHistoryLayer[] | null> => {
      const id = selectedRef.current;
      if (!id) return null;
      try {
        return await unwrap(commands.dockerImageHistory(id, imageId));
      } catch {
        return null;
      }
    },
    []
  );

  const inspectNetwork = useCallback(
    async (name: string): Promise<DockerNetworkDetail | null> => {
      const id = selectedRef.current;
      if (!id) return null;
      try {
        return await unwrap(commands.dockerInspectNetwork(id, name));
      } catch {
        return null;
      }
    },
    []
  );

  const inspectVolume = useCallback(
    async (name: string): Promise<DockerVolumeDetail | null> => {
      const id = selectedRef.current;
      if (!id) return null;
      try {
        return await unwrap(commands.dockerInspectVolume(id, name));
      } catch {
        return null;
      }
    },
    []
  );

  const removeImage = useCallback(
    async (imageId: string, force: boolean): Promise<DockerActionResult> => {
      const id = selectedRef.current;
      if (!id) return { ok: false, message: "未选择连接" };
      try {
        await unwrap(commands.dockerRemoveImage(id, imageId, force));
        const images = await unwrap(commands.dockerListImages(id)).catch(() => imagesRef.current);
        setState((s) => ({ ...s, images }));
        return { ok: true };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    },
    []
  );

  const pruneImages = useCallback(async (): Promise<DockerActionResult> => {
    const id = selectedRef.current;
    if (!id) return { ok: false, message: "未选择连接" };
    try {
      const result = await unwrap(commands.dockerPruneImages(id));
      refresh();
      const freed = (result.freedSpaceBytes ?? 0) / 1_000_000;
      return { ok: true, message: `已释放约 ${freed.toFixed(1)} MB，删除 ${result.deleted.length} 项` };
    } catch (e) {
      return { ok: false, message: String(e) };
    }
  }, [refresh]);

  const pullImage = useCallback(
    async (
      image: string,
      onProgress?: (p: DockerImageProgress) => void
    ): Promise<DockerActionResult> => {
      const id = selectedRef.current;
      if (!id) return { ok: false, message: "未选择连接" };
      const channel = `docker-image-progress:${id}:${Date.now()}`;
      let unlisten: UnlistenFn | null = null;
      try {
        unlisten = await listen<DockerImageProgress>(channel, (e) => onProgress?.(e.payload));
        await unwrap(commands.dockerPullImage(id, image, channel));
        const images = await unwrap(commands.dockerListImages(id)).catch(() => imagesRef.current);
        setState((s) => ({ ...s, images }));
        return { ok: true, message: `已拉取 ${image}` };
      } catch (e) {
        return { ok: false, message: String(e) };
      } finally {
        unlisten?.();
      }
    },
    []
  );

  const pushImage = useCallback(
    async (
      image: string,
      onProgress?: (p: DockerImageProgress) => void
    ): Promise<DockerActionResult> => {
      const id = selectedRef.current;
      if (!id) return { ok: false, message: "未选择连接" };
      const channel = `docker-image-progress:${id}:${Date.now()}`;
      let unlisten: UnlistenFn | null = null;
      try {
        unlisten = await listen<DockerImageProgress>(channel, (e) => onProgress?.(e.payload));
        await unwrap(commands.dockerPushImage(id, image, channel));
        return { ok: true, message: `已推送 ${image}` };
      } catch (e) {
        return { ok: false, message: String(e) };
      } finally {
        unlisten?.();
      }
    },
    []
  );

  const tagImage = useCallback(
    async (source: string, target: string): Promise<DockerActionResult> => {
      const id = selectedRef.current;
      if (!id) return { ok: false, message: "未选择连接" };
      try {
        await unwrap(commands.dockerTagImage(id, source, target));
        const images = await unwrap(commands.dockerListImages(id)).catch(() => imagesRef.current);
        setState((s) => ({ ...s, images }));
        return { ok: true, message: `已打 tag: ${target}` };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    },
    []
  );

  const buildImage = useCallback(
    async (
      contextDir: string,
      tag: string,
      dockerfile: string | null,
      onProgress?: (p: DockerImageProgress) => void
    ): Promise<DockerActionResult> => {
      const id = selectedRef.current;
      if (!id) return { ok: false, message: "未选择连接" };
      const channel = `docker-image-progress:${id}:${Date.now()}`;
      let unlisten: UnlistenFn | null = null;
      try {
        unlisten = await listen<DockerImageProgress>(channel, (e) => onProgress?.(e.payload));
        const ctx = {
          contextDir,
          tag,
          dockerfile,
          buildArgs: [],
          useBuildKit: true,
        };
        await unwrap(commands.dockerBuildImage(id, ctx, channel));
        const images = await unwrap(commands.dockerListImages(id)).catch(() => imagesRef.current);
        setState((s) => ({ ...s, images }));
        return { ok: true, message: `已构建 ${tag}` };
      } catch (e) {
        return { ok: false, message: String(e) };
      } finally {
        unlisten?.();
      }
    },
    []
  );

  const composeAction = useCallback(
    async (
      action: "up" | "down" | "restart" | "pull" | "logs",
      project: string,
      services: string[] = [],
      detached = true,
      workingDir?: string | null,
      configFile?: string | null
    ): Promise<DockerActionResult> => {
      const id = selectedRef.current;
      if (!id) return { ok: false, message: "未选择连接" };
      try {
        const req = {
          project,
          workingDir: workingDir ?? null,
          configFile: configFile ?? null,
          services,
          detached,
        };
        const result = await unwrap(commands.dockerComposeAction(id, action, req));
        if (result.exitCode !== 0) {
          return {
            ok: false,
            message: `Compose ${action} 退出码 ${result.exitCode}：${result.stderrExcerpt || result.stdoutExcerpt || ""}`,
          };
        }
        refresh();
        return { ok: true, message: `Compose ${action} 完成` };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    },
    [refresh]
  );

  const selectedConnection =
    state.connections.find((c) => c.connectionId === state.selectedConnectionId) ?? null;

  const listNetworks = useCallback(async (): Promise<void> => {
    const id = selectedRef.current;
    if (!id) return;
    try {
      const networks = await unwrap(commands.dockerListNetworks(id));
      setState((s) => ({ ...s, networks }));
    } catch (e) {
      setState((s) => ({ ...s, error: String(e) }));
    }
  }, []);

  const createNetwork = useCallback(
    async (req: DockerCreateNetworkRequest): Promise<DockerActionResult> => {
      const id = selectedRef.current;
      if (!id) return { ok: false, message: "未选择连接" };
      try {
        await unwrap(commands.dockerCreateNetwork(id, req));
        await listNetworks();
        return { ok: true, message: `已创建网络 ${req.name}` };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    },
    [listNetworks]
  );

  const removeNetwork = useCallback(
    async (name: string): Promise<DockerActionResult> => {
      const id = selectedRef.current;
      if (!id) return { ok: false, message: "未选择连接" };
      try {
        await unwrap(commands.dockerRemoveNetwork(id, name));
        await listNetworks();
        return { ok: true, message: `已删除网络 ${name}` };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    },
    [listNetworks]
  );

  const listVolumes = useCallback(async (): Promise<void> => {
    const id = selectedRef.current;
    if (!id) return;
    try {
      const volumes = await unwrap(commands.dockerListVolumes(id));
      setState((s) => ({ ...s, volumes }));
    } catch (e) {
      setState((s) => ({ ...s, error: String(e) }));
    }
  }, []);

  const createVolume = useCallback(
    async (req: DockerCreateVolumeRequest): Promise<DockerActionResult> => {
      const id = selectedRef.current;
      if (!id) return { ok: false, message: "未选择连接" };
      try {
        await unwrap(commands.dockerCreateVolume(id, req));
        await listVolumes();
        return { ok: true, message: `已创建卷 ${req.name}` };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    },
    [listVolumes]
  );

  const removeVolume = useCallback(
    async (name: string, force: boolean): Promise<DockerActionResult> => {
      const id = selectedRef.current;
      if (!id) return { ok: false, message: "未选择连接" };
      try {
        await unwrap(commands.dockerRemoveVolume(id, name, force));
        await listVolumes();
        return { ok: true, message: `已删除卷 ${name}` };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    },
    [listVolumes]
  );

  const pruneVolumes = useCallback(async (): Promise<DockerActionResult> => {
    const id = selectedRef.current;
    if (!id) return { ok: false, message: "未选择连接" };
    try {
      const result = await unwrap(commands.dockerPruneVolumes(id));
      await listVolumes();
      return {
        ok: true,
        message: `已清理 ${result.deleted.length} 个卷，释放约 ${((result.freedSpaceBytes ?? 0) / 1_000_000).toFixed(1)} MB`,
      };
    } catch (e) {
      return { ok: false, message: String(e) };
    }
  }, [listVolumes]);

  const listContainerDir = useCallback(
    async (containerId: string, path: string): Promise<DockerFileEntry[]> => {
      const id = selectedRef.current;
      if (!id) return [];
      try {
        const files = await unwrap(commands.dockerListContainerDir(id, containerId, path));
        setState((s) => ({ ...s, files, filePath: path, fileContainerId: containerId }));
        return files;
      } catch (e) {
        setState((s) => ({ ...s, error: String(e) }));
        return [];
      }
    },
    []
  );

  const readContainerFile = useCallback(
    async (containerId: string, path: string, maxBytes: number): Promise<string> => {
      const id = selectedRef.current;
      if (!id) return "";
      try {
        const bytes = await unwrap(commands.dockerReadContainerFile(id, containerId, path, maxBytes));
        return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
      } catch (e) {
        return `[读取失败] ${e}`;
      }
    },
    []
  );

  const writeContainerFile = useCallback(
    async (containerId: string, path: string, data: string): Promise<DockerActionResult> => {
      const id = selectedRef.current;
      if (!id) return { ok: false, message: "未选择连接" };
      try {
        const bytes = Array.from(new TextEncoder().encode(data));
        await unwrap(commands.dockerWriteContainerFile(id, containerId, path, bytes));
        return { ok: true, message: `已写入 ${path}` };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    },
    []
  );

  return {
    ...state,
    selectedConnection,
    selectConnection,
    refresh,
    refreshContainers,
    containerAction,
    inspect,
    inspectImage,
    imageHistory,
    inspectNetwork,
    inspectVolume,
    removeImage,
    pruneImages,
    pullImage,
    pushImage,
    tagImage,
    buildImage,
    composeAction,
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
    reloadConnections: loadConnections,
    scanning,
    lastScanResult,
    scanSshDockerHosts,
  };
}

/**
 * 容器日志流：开始跟随后通过 `docker-log` 事件累积行，`docker-log-end` 结束。
 * 组件卸载或切换容器时自动停止后端流。
 */
export function useContainerLogStream(
  connectionId: string | null,
  containerId: string | null,
  active: boolean,
  follow: boolean,
  tail = 200
) {
  const [lines, setLines] = useState<DockerLogLine[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!active || !connectionId || !containerId) return;

    let disposed = false;
    let unlistenLog: (() => void) | null = null;
    let unlistenEnd: (() => void) | null = null;

    setLines([]);
    setError(null);
    setStreaming(true);

    const start = async () => {
      try {
        unlistenLog = await listen<{ streamId: string; stream: string; message: string }>(
          "docker-log",
          (event) => {
            if (event.payload.streamId !== streamIdRef.current) return;
            setLines((prev) => {
              const next = [...prev, { stream: event.payload.stream, message: event.payload.message }];
              return next.length > 2000 ? next.slice(next.length - 2000) : next;
            });
          }
        );
        unlistenEnd = await listen<{ streamId: string; error: string | null }>(
          "docker-log-end",
          (event) => {
            if (event.payload.streamId !== streamIdRef.current) return;
            setStreaming(false);
            if (event.payload.error) setError(event.payload.error);
          }
        );

        const res = await commands.dockerStreamContainerLogs(connectionId, containerId, tail, follow);
        if (res.status === "ok") {
          if (disposed) {
            void commands.dockerStopLogStream(res.data);
          } else {
            streamIdRef.current = res.data;
          }
        } else {
          setError(res.error.message);
          setStreaming(false);
        }
      } catch (e) {
        setError(String(e));
        setStreaming(false);
      }
    };

    void start();

    return () => {
      disposed = true;
      if (streamIdRef.current) {
        void commands.dockerStopLogStream(streamIdRef.current);
        streamIdRef.current = null;
      }
      unlistenLog?.();
      unlistenEnd?.();
    };
  }, [connectionId, containerId, active, follow, tail]);

  return { lines, streaming, error };
}
