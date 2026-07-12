import { useCallback, useEffect, useMemo, useState } from "react";
import { LogViewer } from "../../../components/ui/LogViewer";
import { Button } from "../../../components/ui/Button";
import { useI18n } from "../../../i18n";
import { fetchDockerContainerLogs } from "./dockerContainerApi";

interface DockerContainerLogsViewProps {
  connectionId: string;
  containerId: string;
  visible: boolean;
}

const LOG_TAIL = 500;

export function DockerContainerLogsView({ connectionId, containerId, visible }: DockerContainerLogsViewProps) {
  const { t } = useI18n();
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchDockerContainerLogs(connectionId, containerId, LOG_TAIL);
      setLines(data.map((line) => line.message));
      setError(null);
    } catch (e) {
      setError(String(e));
      setLines([]);
    } finally {
      setLoading(false);
    }
  }, [connectionId, containerId]);

  useEffect(() => {
    if (!visible) return;
    void loadLogs();
  }, [visible, loadLogs]);

  const text = useMemo(() => lines.join("\n"), [lines]);

  return (
    <div className="docker-container-subwindow docker-container-subwindow--logs">
      <LogViewer
        visible={visible}
        text={text}
        loading={loading}
        loadingText={t("docker.dockPanel.subwindowLoading")}
        emptyText={t("docker.dockPanel.subwindowEmptyLogs")}
        error={error}
        toolbar={
          <Button type="button" variant="ghost" size="sm" onClick={() => void loadLogs()} disabled={loading}>
            {t("docker.dockPanel.subwindowRefresh")}
          </Button>
        }
        footer={
          <span className="log-viewer-panel__footer-text">
            {t("logViewer.lineCount", { count: lines.length })}
          </span>
        }
      />
    </div>
  );
}
