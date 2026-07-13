import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LogViewer } from "../../../components/ui/LogViewer";
import { Button } from "../../../components/ui/Button";
import { IconDropdownButton } from "../../../components/ui/IconDropdownButton";
import { IconClock, IconRefresh } from "../../../components/ui/Icons";
import { useI18n } from "../../../i18n";
import { appConfirm } from "../../../lib/appConfirm";
import { safeTauriUnlisten } from "../../../lib/safeTauriUnlisten";
import { DownloadIcon, FollowIcon, TrashIcon } from "../icons";
import {
  clearDockerContainerLogs,
  fetchDockerContainerLogs,
  startDockerContainerLogStream,
  stopDockerContainerLogStream,
} from "./dockerContainerApi";

interface DockerContainerLogsViewProps {
  connectionId: string;
  containerId: string;
  containerName?: string;
  visible: boolean;
}

const LOG_TAIL = 500;

type LogSinceRange = "all" | "15m" | "1h" | "6h" | "24h" | "7d";

const LOG_SINCE_OPTIONS: LogSinceRange[] = ["all", "15m", "1h", "6h", "24h", "7d"];

function sinceParam(range: LogSinceRange): string | null {
  return range === "all" ? null : range;
}

function sinceLabel(range: LogSinceRange, t: (key: string) => string): string {
  switch (range) {
    case "all":
      return t("docker.dockPanel.logsSinceAll");
    case "15m":
      return t("docker.dockPanel.logsSince15m");
    case "1h":
      return t("docker.dockPanel.logsSince1h");
    case "6h":
      return t("docker.dockPanel.logsSince6h");
    case "24h":
      return t("docker.dockPanel.logsSince24h");
    case "7d":
      return t("docker.dockPanel.logsSince7d");
  }
}

interface DockerLogEventPayload {
  streamId: string;
  stream: string;
  message: string;
}

interface DockerLogEndPayload {
  streamId: string;
  error?: string | null;
}

export function DockerContainerLogsView({
  connectionId,
  containerId,
  containerName,
  visible,
}: DockerContainerLogsViewProps) {
  const { t } = useI18n();
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sinceRange, setSinceRange] = useState<LogSinceRange>("all");
  const [following, setFollowing] = useState(false);
  const [streamBusy, setStreamBusy] = useState(false);

  const streamIdRef = useRef<string | null>(null);
  const unlistenRefs = useRef<Array<() => void>>([]);

  const stopFollowStream = useCallback(async () => {
    for (const unlisten of unlistenRefs.current) {
      safeTauriUnlisten(unlisten);
    }
    unlistenRefs.current = [];
    const streamId = streamIdRef.current;
    streamIdRef.current = null;
    if (streamId) {
      try {
        await stopDockerContainerLogStream(streamId);
      } catch {
        // 流可能已结束，忽略停止失败
      }
    }
    setFollowing(false);
    setStreamBusy(false);
  }, []);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchDockerContainerLogs(
        connectionId,
        containerId,
        LOG_TAIL,
        sinceParam(sinceRange),
      );
      setLines(data.map((line) => line.message));
      setError(null);
    } catch (e) {
      setError(String(e));
      setLines([]);
    } finally {
      setLoading(false);
    }
  }, [connectionId, containerId, sinceRange]);

  const startFollowStream = useCallback(async () => {
    if (streamBusy || streamIdRef.current) return;
    setStreamBusy(true);
    setError(null);
    setLines([]);
    try {
      const streamId = await startDockerContainerLogStream(
        connectionId,
        containerId,
        LOG_TAIL,
        sinceParam(sinceRange),
        true,
      );
      streamIdRef.current = streamId;
      setFollowing(true);

      const unlistenLog = await listen<DockerLogEventPayload>("docker-log", (event) => {
        if (event.payload.streamId !== streamId) return;
        const message = event.payload.message;
        if (!message) return;
        setLines((current) => [...current, message]);
      });
      const unlistenEnd = await listen<DockerLogEndPayload>("docker-log-end", (event) => {
        if (event.payload.streamId !== streamId) return;
        if (event.payload.error) {
          setError(event.payload.error);
        }
        void stopFollowStream();
      });
      unlistenRefs.current = [unlistenLog, unlistenEnd];
    } catch (e) {
      setError(String(e));
      await stopFollowStream();
    } finally {
      setStreamBusy(false);
    }
  }, [connectionId, containerId, sinceRange, stopFollowStream, streamBusy]);

  const handleToggleFollow = useCallback(() => {
    if (following || streamBusy) {
      void stopFollowStream();
      return;
    }
    void startFollowStream();
  }, [following, startFollowStream, stopFollowStream, streamBusy]);

  const handleRefresh = useCallback(async () => {
    await stopFollowStream();
    await loadLogs();
  }, [loadLogs, stopFollowStream]);

  const handleSinceChange = useCallback(
    (range: LogSinceRange) => {
      void stopFollowStream().then(() => setSinceRange(range));
    },
    [stopFollowStream],
  );

  const handleDownload = useCallback(() => {
    const text = lines.join("\n");
    if (!text) return;
    const safeName = (containerName ?? containerId).replace(/[^\w.-]+/g, "_");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeName}-logs.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [containerId, containerName, lines]);

  const handleClear = useCallback(async () => {
    const confirmed = await appConfirm(t("docker.dockPanel.logsClearConfirm"));
    if (!confirmed) return;
    await stopFollowStream();
    setLoading(true);
    try {
      await clearDockerContainerLogs(connectionId, containerId);
      setLines([]);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [connectionId, containerId, stopFollowStream, t]);

  useEffect(() => {
    if (!visible) {
      void stopFollowStream();
      return;
    }
    if (!following) {
      void loadLogs();
    }
  }, [visible, sinceRange, following, loadLogs, stopFollowStream]);

  useEffect(
    () => () => {
      void stopFollowStream();
    },
    [stopFollowStream],
  );

  const text = useMemo(() => lines.join("\n"), [lines]);

  const sinceMenuItems = useMemo(
    () =>
      LOG_SINCE_OPTIONS.map((range) => ({
        id: range,
        label: sinceLabel(range, t),
        onSelect: () => handleSinceChange(range),
      })),
    [handleSinceChange, t],
  );

  return (
    <div className="docker-container-subwindow docker-container-subwindow--logs">
      <LogViewer
        visible={visible}
        text={text}
        loading={loading && !following}
        loadingText={t("docker.dockPanel.subwindowLoading")}
        emptyText={t("docker.dockPanel.subwindowEmptyLogs")}
        error={error}
        streaming={following}
        autoScroll={following}
        footer={
          <div className="log-viewer-panel__footer-inner">
            <span className="log-viewer-panel__footer-text">
              {t("logViewer.lineCount", { count: lines.length })}
              {sinceRange !== "all" ? (
                <span className="log-viewer-panel__footer-meta">
                  {" · "}
                  {sinceLabel(sinceRange, t)}
                </span>
              ) : null}
            </span>
            <div className="log-viewer-panel__footer-actions">
              <IconDropdownButton
                title={t("docker.dockPanel.logsSinceFilter")}
                ariaLabel={t("docker.dockPanel.logsSinceFilter")}
                icon={<IconClock size={14} />}
                size="icon-xs"
                items={sinceMenuItems}
                disabled={loading || streamBusy}
              />
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                title={
                  following
                    ? t("docker.dockPanel.logsStopFollow")
                    : t("docker.dockPanel.logsFollow")
                }
                aria-pressed={following}
                className={following ? "is-active" : undefined}
                onClick={() => void handleToggleFollow()}
                disabled={streamBusy}
              >
                <FollowIcon active={following} />
              </Button>
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                title={t("docker.dockPanel.logsDownload")}
                onClick={handleDownload}
                disabled={!text}
              >
                <DownloadIcon />
              </Button>
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                title={t("docker.dockPanel.logsClear")}
                onClick={() => void handleClear()}
                disabled={loading || streamBusy}
              >
                <TrashIcon />
              </Button>
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                title={t("docker.dockPanel.subwindowRefresh")}
                onClick={() => void handleRefresh()}
                disabled={loading || streamBusy}
              >
                <IconRefresh size={14} />
              </Button>
            </div>
          </div>
        }
      />
    </div>
  );
}
