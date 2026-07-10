import { useCallback, useEffect, useState } from "react";
import { commands } from "../../../ipc/bindings";
import type {
  DockerConnectionInfo,
  DockerContainerSummary,
  DockerImageSummary,
  DockerNetworkSummary,
  DockerVolumeSummary,
} from "../../../ipc/bindings";
import { isOnePanelDockerSource } from "../dockerConnectionSource";

async function unwrap<T>(
  promise: Promise<{ status: "ok"; data: T } | { status: "error"; error: { message: string } }>,
): Promise<T> {
  const res = await promise;
  if (res.status === "ok") return res.data;
  throw new Error(res.error.message);
}

export interface DockerConnectionResources {
  loading: boolean;
  error: string | null;
  images: DockerImageSummary[];
  containers: DockerContainerSummary[];
  networks: DockerNetworkSummary[];
  volumes: DockerVolumeSummary[];
}

const EMPTY_RESOURCES: DockerConnectionResources = {
  loading: false,
  error: null,
  images: [],
  containers: [],
  networks: [],
  volumes: [],
};

/** 侧栏资源树当前优先支持 1Panel / 面板适配来源。 */
export function connectionSupportsSidebarResources(connection: DockerConnectionInfo): boolean {
  return isOnePanelDockerSource(connection.source);
}

/**
 * 加载单个 Docker 连接下的镜像 / 容器 / 网络 / 卷（走统一 IPC，1Panel 由后端适配器处理）。
 */
export function useDockerConnectionResources(connection: DockerConnectionInfo | null) {
  const [state, setState] = useState<DockerConnectionResources>(EMPTY_RESOURCES);

  const reload = useCallback(async (connectionId: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const [containers, images, networks, volumes] = await Promise.all([
        unwrap(commands.dockerListContainers(connectionId, null)),
        unwrap(commands.dockerListImages(connectionId)),
        unwrap(commands.dockerListNetworks(connectionId)),
        unwrap(commands.dockerListVolumes(connectionId)),
      ]);
      setState({
        loading: false,
        error: null,
        containers,
        images,
        networks,
        volumes,
      });
    } catch (e) {
      setState({
        loading: false,
        error: String(e),
        containers: [],
        images: [],
        networks: [],
        volumes: [],
      });
    }
  }, []);

  useEffect(() => {
    if (!connection) {
      setState(EMPTY_RESOURCES);
      return;
    }
    if (!connectionSupportsSidebarResources(connection)) {
      setState(EMPTY_RESOURCES);
      return;
    }

    let cancelled = false;
    const load = async () => {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const [containers, images, networks, volumes] = await Promise.all([
          unwrap(commands.dockerListContainers(connection.connectionId, null)),
          unwrap(commands.dockerListImages(connection.connectionId)),
          unwrap(commands.dockerListNetworks(connection.connectionId)),
          unwrap(commands.dockerListVolumes(connection.connectionId)),
        ]);
        if (cancelled) return;
        setState({
          loading: false,
          error: null,
          containers,
          images,
          networks,
          volumes,
        });
      } catch (e) {
        if (cancelled) return;
        setState({
          loading: false,
          error: String(e),
          containers: [],
          images: [],
          networks: [],
          volumes: [],
        });
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [connection?.connectionId, connection?.source]);

  const refresh = useCallback(() => {
    if (!connection?.connectionId) return;
    if (!connectionSupportsSidebarResources(connection)) return;
    void reload(connection.connectionId);
  }, [connection, reload]);

  return { ...state, refresh };
}
