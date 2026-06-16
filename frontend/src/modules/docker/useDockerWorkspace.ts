import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands } from "../../ipc/bindings";
import { useConnectionStore } from "../../stores/connectionStore";
import type { DockerWorkspaceTab } from "./dockerWorkspaceTabs";
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
  DockerSystemDiskUsage,
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

export type DockerResourceKey =
  | "overview"
  | "systemDiskUsage"
  | "containers"
  | "images"
  | "composeProjects"
  | "networks"
  | "volumes";

const TAB_RESOURCES: Record<DockerWorkspaceTab, DockerResourceKey[]> = {
  // overview 放最后：SSH 模式下它会重复执行 docker ps / docker images，避免与其他请求抢会话。
  overview: ["containers", "images", "networks", "volumes", "systemDiskUsage", "composeProjects", "overview"],
  containers: ["containers"],
  images: ["images"],
  compose: ["composeProjects"],
  networks: ["networks"],
  volumes: ["volumes"],
  files: ["containers"],
  swarm: [],
};

const RESOURCE_LOAD_ROUNDS = 3;
const RESOURCE_RETRY_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export interface DockerActionResult {
  ok: boolean;
  message?: string;
}

/** 单个 Docker 连接的业务数据快照，用于切换连接时即时展示。 */
interface DockerConnectionCache {
  probe: DockerProbe | null;
  overview: DockerOverview | null;
  systemDiskUsage: DockerSystemDiskUsage | null;
  containers: DockerContainerSummary[];
  images: DockerImageSummary[];
  composeProjects: DockerComposeProject[];
  networks: DockerNetworkSummary[];
  volumes: DockerVolumeSummary[];
  files: DockerFileEntry[];
  filePath: string;
  fileContainerId: string | null;
  error: string | null;
  /** 已拉取过的资源键，用于 Tab 懒加载判断（空列表也算已加载）。 */
  fetchedResources: Partial<Record<DockerResourceKey, boolean>>;
}

interface DockerWorkspaceState extends DockerConnectionCache {
  connections: DockerConnectionInfo[];
  selectedConnectionId: string | null;
  connectionsLoading: boolean;
  /** 首次加载且无缓存时为 true，会显示列表占位「加载中」 */
  dataLoading: boolean;
  /** 后台刷新中为 true，仅用于刷新按钮状态，不遮挡内容 */
  dataRefreshing: boolean;
}

function emptyConnectionCache(): DockerConnectionCache {
  return {
    probe: null,
    overview: null,
    systemDiskUsage: null,
    containers: [],
    images: [],
    composeProjects: [],
    networks: [],
    volumes: [],
    files: [],
    filePath: "/",
    fileContainerId: null,
    error: null,
    fetchedResources: {},
  };
}

/** 统一处理 typedError 结果，返回数据或抛出消息。 */
async function unwrap<T>(promise: Promise<{ status: "ok"; data: T } | { status: "error"; error: { message: string } }>): Promise<T> {
  const res = await promise;
  if (res.status === "ok") return res.data;
  throw new Error(res.error.message);
}

/**
 * Docker 工作区数据入口：统一管理连接、探测、容器/镜像/Compose 列表与生命周期动作。
 * 按当前 Tab 懒加载资源，避免切换连接时一次性拉取全部数据。
 */
export function useDockerWorkspace(activeTab: DockerWorkspaceTab) {
  const [state, setState] = useState<DockerWorkspaceState>({
    connections: [],
    selectedConnectionId: null,
    probe: null,
    overview: null,
    systemDiskUsage: null,
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
    fetchedResources: {},
  });

  // 用 ref 保存当前选中连接与镜像列表，避免闭包捕获过期值。
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = state.selectedConnectionId;
  const connectionsRef = useRef(state.connections);
  connectionsRef.current = state.connections;
  const connectionCacheRef = useRef<Map<string, DockerConnectionCache>>(new Map());
  const imagesRef = useRef<DockerImageSummary[]>([]);
  imagesRef.current = state.images;
  const [scanning, setScanning] = useState(false);
  const [lastScanResult, setLastScanResult] = useState<DockerScanResult | null>(null);
  /** 探测与资源加载使用独立序号，避免 probe 取消进行中的列表请求。 */
  const probeSeqRef = useRef(0);
  const resourceSeqRef = useRef(0);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const saveConnectionCache = useCallback(
    (connectionId: string, patch: Partial<DockerConnectionCache>): DockerConnectionCache => {
      const prev = connectionCacheRef.current.get(connectionId) ?? emptyConnectionCache();
      const next = {
        ...prev,
        ...patch,
        fetchedResources: patch.fetchedResources
          ? { ...prev.fetchedResources, ...patch.fetchedResources }
          : prev.fetchedResources,
      };
      connectionCacheRef.current.set(connectionId, next);
      return next;
    },
    [],
  );

  const patchSelectedConnectionData = useCallback(
    (patch: Partial<DockerConnectionCache>) => {
      const id = selectedRef.current;
      if (!id) return;
      saveConnectionCache(id, patch);
      setState((s) => ({ ...s, ...patch }));
    },
    [saveConnectionCache],
  );

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

  const isResourceLoaded = useCallback((cache: DockerConnectionCache, key: DockerResourceKey): boolean => {
    return cache.fetchedResources[key] === true;
  }, []);

  /** 按 Tab 懒加载缺失资源，各资源独立返回并渐进更新 UI。 */
  const loadTabResources = useCallback(
    async (connectionId: string, tab: DockerWorkspaceTab, options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      const resourceSeq = ++resourceSeqRef.current;
      const resources = TAB_RESOURCES[tab];
      if (resources.length === 0) return;

      const fetchers: Record<DockerResourceKey, () => Promise<unknown>> = {
        overview: () => unwrap(commands.dockerGetOverview(connectionId)),
        systemDiskUsage: () => unwrap(commands.dockerGetSystemDiskUsage(connectionId)),
        containers: () => unwrap(commands.dockerListContainers(connectionId, null)),
        images: () => unwrap(commands.dockerListImages(connectionId)),
        composeProjects: () => unwrap(commands.dockerListComposeProjects(connectionId)),
        networks: () => unwrap(commands.dockerListNetworks(connectionId)),
        volumes: () => unwrap(commands.dockerListVolumes(connectionId)),
      };

      const getMissing = () => {
        const cached = connectionCacheRef.current.get(connectionId);
        return resources.filter((key) => !cached || !isResourceLoaded(cached, key));
      };

      const fetchBatch = async (
        keys: DockerResourceKey[],
        applyPatch: (patch: Partial<DockerConnectionCache>) => void,
      ): Promise<string | null> => {
        let lastError: string | null = null;
        for (const key of keys) {
          if (resourceSeq !== resourceSeqRef.current || selectedRef.current !== connectionId) return lastError;
          try {
            const data = await fetchers[key]();
            if (resourceSeq !== resourceSeqRef.current || selectedRef.current !== connectionId) return lastError;
            applyPatch({
              [key]: data,
              error: null,
              fetchedResources: {
                ...connectionCacheRef.current.get(connectionId)?.fetchedResources,
                [key]: true,
              },
            } as Partial<DockerConnectionCache>);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            lastError = message;
          }
        }
        return lastError;
      };

      let missing = getMissing();
      if (missing.length === 0) {
        if (!silent) {
          setState((s) => ({ ...s, dataLoading: false, dataRefreshing: false }));
        }
        return;
      }

      setState((s) => ({
        ...s,
        dataRefreshing: silent ? true : s.dataRefreshing,
        dataLoading: silent ? false : true,
      }));

      const applyPatch = (patch: Partial<DockerConnectionCache>) => {
        if (resourceSeq !== resourceSeqRef.current || selectedRef.current !== connectionId) return;
        saveConnectionCache(connectionId, patch);
        setState((s) => ({
          ...s,
          ...patch,
          dataLoading: false,
          dataRefreshing: false,
        }));
      };

      let lastBatchError = await fetchBatch(missing, applyPatch);

      for (let round = 1; round < RESOURCE_LOAD_ROUNDS; round += 1) {
        missing = getMissing();
        if (missing.length === 0) break;
        if (resourceSeq !== resourceSeqRef.current || selectedRef.current !== connectionId) break;
        if (
          connectionsRef.current.find((c) => c.connectionId === connectionId)?.source === "ssh-engine"
        ) {
          try {
            await commands.dockerResetSshSession(connectionId);
          } catch {
            // 重置失败不阻断后续重试
          }
        }
        await sleep(RESOURCE_RETRY_DELAY_MS);
        lastBatchError = (await fetchBatch(missing, applyPatch)) ?? lastBatchError;
      }

      if (
        getMissing().length > 0 &&
        lastBatchError &&
        resourceSeq === resourceSeqRef.current &&
        selectedRef.current === connectionId
      ) {
        saveConnectionCache(connectionId, { error: lastBatchError });
        setState((s) => ({ ...s, error: lastBatchError }));
      }

      if (resourceSeq === resourceSeqRef.current && selectedRef.current === connectionId) {
        setState((s) => ({ ...s, dataLoading: false, dataRefreshing: false }));
      }
    },
    [isResourceLoaded, saveConnectionCache],
  );

  /** 探测连通性；离线时不拉业务数据。 */
  const loadConnectionProbe = useCallback(
    async (connectionId: string, options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      const probeSeq = ++probeSeqRef.current;

      setState((s) => ({
        ...s,
        error: silent ? s.error : null,
        dataLoading: silent ? false : true,
        dataRefreshing: silent ? true : s.dataRefreshing,
      }));

      const applyToSelected = (patch: Partial<DockerWorkspaceState>) => {
        if (probeSeq !== probeSeqRef.current || selectedRef.current !== connectionId) return;
        setState((s) => ({
          ...s,
          ...patch,
          dataLoading: false,
          dataRefreshing: false,
        }));
      };

      let probe: DockerProbe | null = null;
      try {
        probe = await unwrap(commands.dockerProbeConnection(connectionId));
      } catch (e) {
        const message = String(e);
        saveConnectionCache(connectionId, { ...emptyConnectionCache(), error: message });
        applyToSelected({ ...emptyConnectionCache(), error: message });
        return;
      }

      setState((s) => ({
        ...s,
        connections: s.connections.map((c) =>
          c.connectionId === connectionId
            ? {
                ...c,
                status: probe!.status,
                engineVersion: probe!.engineVersion,
                apiVersion: probe!.apiVersion,
                warningMessage: probe!.warningMessage,
              }
            : c,
        ),
        probe: selectedRef.current === connectionId ? probe : s.probe,
      }));

      if (probe.status === "offline") {
        const offlinePatch: Partial<DockerConnectionCache> = {
          probe,
          overview: null,
          systemDiskUsage: null,
          containers: [],
          images: [],
          composeProjects: [],
          networks: [],
          volumes: [],
          error: probe.warningMessage ?? "Docker 未安装或未启动",
          fetchedResources: {},
        };
        saveConnectionCache(connectionId, offlinePatch);
        applyToSelected(offlinePatch);
        return;
      }

      saveConnectionCache(connectionId, { probe, error: null });
      applyToSelected({ probe, error: null, dataLoading: false, dataRefreshing: silent });

      void loadTabResources(connectionId, activeTabRef.current, { silent: true });
    },
    [loadTabResources, saveConnectionCache],
  );

  // 初始化加载连接列表。
  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  const prevSelectedConnectionIdRef = useRef<string | null>(null);

  // 选中连接变化：有缓存则先展示，再探测并懒加载当前 Tab。
  useEffect(() => {
    const id = state.selectedConnectionId;
    if (!id) {
      prevSelectedConnectionIdRef.current = null;
      return;
    }

    if (prevSelectedConnectionIdRef.current !== id) {
      resourceSeqRef.current += 1;
      prevSelectedConnectionIdRef.current = id;
    }

    const cached = connectionCacheRef.current.get(id);
    if (cached) {
      setState((s) => ({
        ...s,
        ...cached,
        error: null,
        dataLoading: false,
        dataRefreshing: true,
      }));
      void loadConnectionProbe(id, { silent: true });
      return;
    }

    setState((s) => ({
      ...s,
      ...emptyConnectionCache(),
      dataLoading: true,
      dataRefreshing: false,
    }));
    void loadConnectionProbe(id, { silent: false });
  }, [state.selectedConnectionId, loadConnectionProbe]);

  // Tab 切换：在线连接仅补拉当前 Tab 缺失资源（连接切换由 loadConnectionProbe 负责，避免重复触发互相取消）。
  useEffect(() => {
    const id = selectedRef.current;
    if (!id) return;
    const cached = connectionCacheRef.current.get(id);
    if (cached?.probe?.status !== "online") return;
    void loadTabResources(id, activeTab, { silent: true });
  }, [activeTab, loadTabResources]);

  // 连接被删除后清理对应缓存。
  useEffect(() => {
    const alive = new Set(state.connections.map((c) => c.connectionId));
    for (const id of connectionCacheRef.current.keys()) {
      if (!alive.has(id)) connectionCacheRef.current.delete(id);
    }
  }, [state.connections]);

  const selectConnection = useCallback((id: string) => {
    setState((s) => (s.selectedConnectionId === id ? s : { ...s, selectedConnectionId: id }));
  }, []);

  const refresh = useCallback(() => {
    const id = selectedRef.current;
    if (!id) return;
    const tab = activeTabRef.current;
    const cached = connectionCacheRef.current.get(id);
    if (cached) {
      const clearedFetched = { ...cached.fetchedResources };
      for (const key of TAB_RESOURCES[tab]) {
        delete clearedFetched[key];
      }
      saveConnectionCache(id, { fetchedResources: clearedFetched, error: null });
    }
    resourceSeqRef.current += 1;
    setState((s) => ({ ...s, error: null, dataRefreshing: true }));

    const isSshEngine =
      connectionsRef.current.find((c) => c.connectionId === id)?.source === "ssh-engine";
    const reload = () => {
      void loadConnectionProbe(id, { silent: true });
    };
    if (isSshEngine) {
      void commands.dockerResetSshSession(id).finally(reload);
    } else {
      reload();
    }
  }, [loadConnectionProbe, saveConnectionCache]);

  /** 仅刷新容器列表（动作后轻量刷新）。 */
  const refreshContainers = useCallback(async () => {
    const id = selectedRef.current;
    if (!id) return;
    try {
      const containers = await unwrap(commands.dockerListContainers(id, null));
      patchSelectedConnectionData({ containers, error: null });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patchSelectedConnectionData({ error: message });
      setState((s) => ({ ...s, error: message }));
    }
  }, [patchSelectedConnectionData]);

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
    [],
  );

  const removeImage = useCallback(
    async (imageId: string, force: boolean): Promise<DockerActionResult> => {
      const id = selectedRef.current;
      if (!id) return { ok: false, message: "未选择连接" };
      try {
        await unwrap(commands.dockerRemoveImage(id, imageId, force));
        const images = await unwrap(commands.dockerListImages(id)).catch(() => imagesRef.current);
        patchSelectedConnectionData({ images });
        return { ok: true };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    },
    [patchSelectedConnectionData],
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
        patchSelectedConnectionData({ images });
        return { ok: true, message: `已拉取 ${image}` };
      } catch (e) {
        return { ok: false, message: String(e) };
      } finally {
        unlisten?.();
      }
    },
    [patchSelectedConnectionData],
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
        patchSelectedConnectionData({ images });
        return { ok: true, message: `已打 tag: ${target}` };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    },
    [patchSelectedConnectionData],
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
        patchSelectedConnectionData({ images });
        return { ok: true, message: `已构建 ${tag}` };
      } catch (e) {
        return { ok: false, message: String(e) };
      } finally {
        unlisten?.();
      }
    },
    [patchSelectedConnectionData],
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
      patchSelectedConnectionData({ networks });
    } catch (e) {
      setState((s) => ({ ...s, error: String(e) }));
    }
  }, [patchSelectedConnectionData]);

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
      patchSelectedConnectionData({ volumes });
    } catch (e) {
      setState((s) => ({ ...s, error: String(e) }));
    }
  }, [patchSelectedConnectionData]);

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
      refresh();
      return {
        ok: true,
        message: `已清理 ${result.deleted.length} 个卷，释放约 ${((result.freedSpaceBytes ?? 0) / 1_000_000).toFixed(1)} MB`,
      };
    } catch (e) {
      return { ok: false, message: String(e) };
    }
  }, [listVolumes, refresh]);

  const pruneBuildCache = useCallback(async (): Promise<DockerActionResult> => {
    const id = selectedRef.current;
    if (!id) return { ok: false, message: "未选择连接" };
    try {
      const result = await unwrap(commands.dockerPruneBuildCache(id));
      refresh();
      return {
        ok: true,
        message: `已清理 ${result.deleted.length} 项构建缓存，释放约 ${((result.freedSpaceBytes ?? 0) / 1_000_000).toFixed(1)} MB`,
      };
    } catch (e) {
      return { ok: false, message: String(e) };
    }
  }, [refresh]);

  const listContainerDir = useCallback(
    async (containerId: string, path: string): Promise<DockerFileEntry[]> => {
      const id = selectedRef.current;
      if (!id) return [];
      try {
        const files = await unwrap(commands.dockerListContainerDir(id, containerId, path));
        patchSelectedConnectionData({ files, filePath: path, fileContainerId: containerId });
        return files;
      } catch (e) {
        setState((s) => ({ ...s, error: String(e) }));
        return [];
      }
    },
    [patchSelectedConnectionData],
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
    pruneBuildCache,
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
