import { useCallback, useEffect, useState } from "react";
import { FileConnectionPanel } from "../../modules/files/FileConnectionPanel";
import {
  listFileConnections,
  loadLocalSystemInfo,
  loadQuickPaths,
} from "../../modules/files/fileApi";
import type {
  FileLocalSystemInfo,
  FileManagerConnectionInfo,
} from "../../ipc/bindings";
import { parseFileConnPanelId } from "../../modules/files/filesWorkspacePanels";
import { useFilesWorkspaceSessionStore } from "../../stores/filesWorkspaceSessionStore";

interface WorkspaceFilesMirrorPanelProps {
  originPanelId: string;
  isActive: boolean;
}

/** 工程工作区中镜像展示的文件连接面板 */
export function WorkspaceFilesMirrorPanel({
  originPanelId,
  isActive,
}: WorkspaceFilesMirrorPanelProps) {
  const connId = parseFileConnPanelId(originPanelId) ?? originPanelId;
  const [connection, setConnection] = useState<FileManagerConnectionInfo | null>(null);
  const [quickPaths, setQuickPaths] = useState<Awaited<ReturnType<typeof loadQuickPaths>> | null>(
    null,
  );
  const [localSystemInfo, setLocalSystemInfo] = useState<FileLocalSystemInfo | null>(null);
  const panelStates = useFilesWorkspaceSessionStore((state) => state.panelStates);

  const patchConnectionStatus = useCallback((id: string, status: "online" | "offline") => {
    setConnection((prev) => (prev && prev.id === id ? { ...prev, status } : prev));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [list, paths, systemInfo] = await Promise.all([
          listFileConnections(),
          loadQuickPaths().catch(() => null),
          loadLocalSystemInfo().catch(() => null),
        ]);
        if (cancelled) return;
        setQuickPaths(paths);
        setLocalSystemInfo(systemInfo);
        setConnection(list.find((item) => item.id === connId) ?? null);
      } catch {
        if (!cancelled) setConnection(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connId]);

  if (!connection) return null;

  return (
    <div className="workspace-files-mirror fm-workspace">
      <FileConnectionPanel
        connection={connection}
        quickPaths={quickPaths}
        localSystemInfo={localSystemInfo}
        isActive={isActive}
        savedState={panelStates[connId] ?? null}
        onPatchStatus={patchConnectionStatus}
      />
    </div>
  );
}
