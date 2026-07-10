import { useCallback, useEffect, useState } from "react";
import { commands } from "../../../ipc/bindings";
import type { DockerConnectionInfo, DockerScanResult } from "../../../ipc/bindings";
import { useConnectionStore } from "../../../stores/connectionStore";

async function unwrap<T>(
  promise: Promise<{ status: "ok"; data: T } | { status: "error"; error: { message: string } }>,
): Promise<T> {
  const res = await promise;
  if (res.status === "ok") return res.data;
  throw new Error(res.error.message);
}

/** 仅加载 Docker 连接列表（不含容器/镜像等业务数据）。 */
export function useDockerConnections() {
  const [connections, setConnections] = useState<DockerConnectionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadConnections = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await unwrap(commands.dockerListConnections());
      setConnections(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadConnections();
  }, [reloadConnections]);

  const scanSshDockerHosts = useCallback(
    async (autoSave = true): Promise<DockerScanResult | null> => {
      setScanning(true);
      try {
        const result = await unwrap(commands.dockerScanSshDockerHosts(autoSave));
        if (autoSave && (result.created > 0 || result.updated > 0)) {
          await useConnectionStore.getState().refresh();
          await reloadConnections();
        }
        return result;
      } catch (e) {
        setError(String(e));
        return null;
      } finally {
        setScanning(false);
      }
    },
    [reloadConnections],
  );

  return {
    connections,
    loading,
    scanning,
    error,
    reloadConnections,
    scanSshDockerHosts,
  };
}
