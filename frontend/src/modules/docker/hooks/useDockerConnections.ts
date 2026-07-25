import { useCallback, useEffect, useRef, useState } from "react";
import { commands } from "../../../ipc/bindings";
import type { DockerConnectionInfo, DockerScanResult } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";
import { useConnectionStore } from "../../../stores/connectionStore";
import { registerDockerOfflineHandler } from "../dockerConnectionOffline";

const unwrap = unwrapCommand;

/** 仅加载 Docker 连接列表（不含容器/镜像等业务数据）。 */
export function useDockerConnections() {
  const [connections, setConnections] = useState<DockerConnectionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 已成功拉过一次后，后续刷新不再把侧栏整树切回「加载中」 */
  const hasLoadedOnceRef = useRef(false);

  const markConnectionOffline = useCallback((connectionId: string) => {
    setConnections((prev) => {
      let changed = false;
      const next = prev.map((item) => {
        if (item.connectionId !== connectionId || item.status === "offline") {
          return item;
        }
        changed = true;
        return { ...item, status: "offline" as const };
      });
      return changed ? next : prev;
    });
  }, []);

  useEffect(() => {
    registerDockerOfflineHandler(markConnectionOffline);
    return () => registerDockerOfflineHandler(null);
  }, [markConnectionOffline]);

  const reloadConnections = useCallback(async () => {
    setError(null);
    if (!hasLoadedOnceRef.current) {
      setLoading(true);
    }
    try {
      // 后端 list 会并行 probe，回填真实 online/degraded/offline
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
    markConnectionOffline,
  };
}
