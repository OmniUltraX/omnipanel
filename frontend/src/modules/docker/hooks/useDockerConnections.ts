import { useCallback, useEffect, useRef, useState } from "react";
import { commands } from "../../../ipc/bindings";
import type { DockerConnectionInfo, DockerScanResult } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";
import { useConnectionStore } from "../../../stores/connectionStore";

const unwrap = unwrapCommand;

/** 仅加载 Docker 连接列表（不含容器/镜像等业务数据）。 */
export function useDockerConnections() {
  const [connections, setConnections] = useState<DockerConnectionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 已成功拉过一次后，后续刷新不再把侧栏整树切回「加载中」 */
  const hasLoadedOnceRef = useRef(false);

  const reloadConnections = useCallback(async () => {
    setError(null);
    if (!hasLoadedOnceRef.current) {
      setLoading(true);
    }
    try {
      const list = await unwrap(commands.dockerListConnections());
      setConnections(list);
      hasLoadedOnceRef.current = true;
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
