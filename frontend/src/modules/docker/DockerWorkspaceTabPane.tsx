import { useEffect, useMemo, useState } from "react";
import { DockerExecTerminal } from "./DockerExecTerminal";
import { useContainerLogStream } from "./useDockerWorkspace";
import { LogViewer } from "../../components/ui/LogViewer";
import { useI18n } from "../../i18n";
import type { DockerTabSnapshot } from "../../stores/workspaceTabStore";
import {
  dockerPreviewKey,
  setDockerLogPreview,
} from "../../stores/workspacePreviewStore";

interface DockerWorkspaceTabPaneProps {
  snapshot: DockerTabSnapshot;
  isActive: boolean;
}

function DockerLogsPane({
  connectionId,
  containerId,
  visible,
}: {
  connectionId: string;
  containerId: string;
  visible: boolean;
}) {
  const { t } = useI18n();
  const [follow, setFollow] = useState(true);
  const { lines, streaming, error } = useContainerLogStream(
    connectionId,
    containerId,
    visible,
    follow,
  );

  const logText = useMemo(
    () => lines.map((line) => line.message).join("\n"),
    [lines],
  );

  useEffect(() => {
    if (!logText) return;
    setDockerLogPreview(dockerPreviewKey(connectionId, containerId), logText);
  }, [connectionId, containerId, logText]);

  return (
    <LogViewer
      className="docker-drawer-logs docker-workspace-logs"
      text={logText}
      streaming
      visible={visible}
      autoScroll={follow}
      copyOnSelect
      loading={visible && streaming && lines.length === 0}
      loadingText={t("docker.logs.waiting")}
      emptyText={streaming ? t("docker.logs.waiting") : t("logViewer.empty")}
      error={error}
      toolbar={
        <>
          <h4 style={{ margin: 0, fontSize: 13 }}>日志</h4>
          <span className="text-muted text-xs">{streaming ? "跟随中…" : "已结束"}</span>
          <label
            className="text-xs flex items-center gap-1 log-viewer-panel__hint"
            style={{ marginLeft: "auto", cursor: "pointer" }}
          >
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            自动滚动
          </label>
        </>
      }
      footer={
        <span className="log-viewer-panel__footer-text">
          {t("logViewer.lineCount", { count: lines.length })}
        </span>
      }
    />
  );
}

/** 工作区内 Docker 容器日志 / exec 终端面板 */
export function DockerWorkspaceTabPane({ snapshot, isActive }: DockerWorkspaceTabPaneProps) {
  const { connectionId, containerId, subTab } = snapshot;
  const [mounted, setMounted] = useState(isActive);

  useEffect(() => {
    if (isActive) setMounted(true);
  }, [isActive]);

  if (!connectionId || !containerId) {
    return (
      <div className="workspace-payload-fallback">
        <p>容器信息不完整，无法打开面板。</p>
      </div>
    );
  }

  if (!mounted) {
    return <div className="docker-workspace-tab-pane" aria-hidden />;
  }

  return (
    <div className="docker-workspace-tab-pane">
      {subTab === "logs" ? (
        <DockerLogsPane
          connectionId={connectionId}
          containerId={containerId}
          visible={isActive}
        />
      ) : (
        <DockerExecTerminal
          connectionId={connectionId}
          containerId={containerId}
          visible={isActive}
        />
      )}
    </div>
  );
}
