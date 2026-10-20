import { useCallback, useEffect, useRef, useState } from "react";
import { commands } from "../../../ipc/bindings";
import type { DockerConnectionInfo, DockerScanResult } from "../../../ipc/bindings";
import { asArray } from "../../../ipc/asArray";
import { unwrapCommand } from "../../../ipc/result";
import { listOnlineSyncPeers } from "../../../lib/auth/syncKeyRelayApi";
import { useAuthStore } from "../../../stores/authStore";
import { getCurrentSyncTeamId } from "../../../stores/currentSyncTeamStore";
import { CLIENT_SYNC_MODULES_APPLIED_EVENT } from "../../clientSync/moduleSync";
import { useConnectionStore } from "../../../stores/connectionStore";
import { isDiscoverySkip, runDiscoveryProbe, sshDiscoveryScope } from "../../../lib/discoveryBus";
import { registerDockerOfflineHandler } from "../dockerConnectionOffline";
import {
  applyProbedDockerConnections,
  clearAllDockerProbePending,
  clearDockerProbePending,
  markDockerProbePending,
  reconcileDockerConnections,
} from "../dockerConnectionList";

const unwrap = unwrapCommand;

/** 仅加载 Docker 连接列表（不含容器/镜像等业务数据）。 */
export function useDockerConnections() {
  const [connections, setConnections] = useState<DockerConnectionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 已成功拉过一次后，后续刷新不再把侧栏整树切回「加载中」 */
  const hasLoadedOnceRef = useRef(false);
  const reloadEpochRef = useRef(0);
  const storedConnections = useConnectionStore((state) => state.connections);

  useEffect(() => {
    setConnections((prev) => {
      const { connections: next, addedIds } = reconcileDockerConnections(prev, storedConnections);
      if (addedIds.length > 0) markDockerProbePending(addedIds);
      if (next === prev) return prev;
      const alive = new Set(next.map((item) => item.connectionId));
      const dropped: string[] = [];
      for (const item of prev) {
        if (!alive.has(item.connectionId)) dropped.push(item.connectionId);
      }
      if (dropped.length > 0) clearDockerProbePending(dropped);
      return next;
    });
  }, [storedConnections]);

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
    const epoch = ++reloadEpochRef.current;
    setError(null);
    if (!hasLoadedOnceRef.current) {
      setLoading(true);
    }
    try {
      // 后端 list 会并行 probe，回填真实 online/degraded/offline
      const list = asArray(await unwrap(commands.dockerListConnections()));
      const token = useAuthStore.getState().token;
      const teamId = getCurrentSyncTeamId();
      let shared: DockerConnectionInfo[] = [];
      if (token && teamId && teamId > 0) {
        try {
          const peers = await listOnlineSyncPeers(token, teamId);
          shared = asArray(
            await unwrap(
              commands.dockerQuerySharedEngines(
                teamId,
                peers
                  .filter((peer) => peer.deviceId.trim())
                  .map((peer) => ({
                    deviceId: peer.deviceId,
                    deviceName: peer.deviceName ?? "",
                  })),
              ),
              { quiet: true },
            ),
          );
        } catch {
          shared = [];
        }
      }
      if (epoch !== reloadEpochRef.current) return;
      clearDockerProbePending([...list, ...shared].map((item) => item.connectionId));
      const stored = useConnectionStore.getState().connections;
      setConnections((prev) => applyProbedDockerConnections(prev, [...list, ...shared], stored));
      hasLoadedOnceRef.current = true;
    } catch (e) {
      if (epoch !== reloadEpochRef.current) return;
      setError(String(e));
      clearAllDockerProbePending();
    } finally {
      if (epoch === reloadEpochRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadConnections();
  }, [reloadConnections]);

  useEffect(() => {
    const onSynced = () => {
      void reloadConnections();
    };
    window.addEventListener(CLIENT_SYNC_MODULES_APPLIED_EVENT, onSynced);
    return () => window.removeEventListener(CLIENT_SYNC_MODULES_APPLIED_EVENT, onSynced);
  }, [reloadConnections]);

  const scanSshDockerHosts = useCallback(
    async (autoSave = true): Promise<DockerScanResult | null> => {
      setScanning(true);
      try {
        const result = autoSave
          ? await runDiscoveryProbe(
              "ssh-docker",
              sshDiscoveryScope(useConnectionStore.getState().connections).scope,
            )
          : await unwrap(commands.dockerScanSshDockerHosts(false));
        if (isDiscoverySkip(result)) {
          setError("生产环境 SSH 主机不会自动扫描 Docker");
          return null;
        }
        const scan = result as DockerScanResult;
        if (autoSave && (scan.created > 0 || scan.updated > 0)) {
          await useConnectionStore.getState().refresh();
          await reloadConnections();
        }
        return scan;
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
