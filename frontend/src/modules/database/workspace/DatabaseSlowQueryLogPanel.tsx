import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { LogViewer } from "../../../components/ui/LogViewer";
import type { DbConnectionConfig } from "../api";
import {
  MYSQL_SLOW_LOG_CHUNK_BYTES,
  readMysqlSlowLogFileSize,
  readMysqlSlowLogTail,
} from "../mysqlSlowQueryLog";

interface DatabaseSlowQueryLogPanelProps {
  connection: DbConnectionConfig;
  sshConnectionId: string;
  logFilePath: string;
  active: boolean;
}

export function DatabaseSlowQueryLogPanel({
  connection,
  sshConnectionId,
  logFilePath,
  active,
}: DatabaseSlowQueryLogPanelProps) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [loadedBytes, setLoadedBytes] = useState(0);
  const loadedBytesRef = useRef(0);

  const loadTail = useCallback(
    async (bytesFromEnd: number) => {
      setLoading(true);
      setError(null);
      try {
        const [size, chunk] = await Promise.all([
          readMysqlSlowLogFileSize(sshConnectionId, logFilePath),
          readMysqlSlowLogTail(sshConnectionId, logFilePath, bytesFromEnd),
        ]);
        setFileSize(size);
        setText(chunk);
        const loaded = Math.min(bytesFromEnd, size);
        loadedBytesRef.current = loaded;
        setLoadedBytes(loaded);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [logFilePath, sshConnectionId],
  );

  useEffect(() => {
    if (!active) return;
    void loadTail(MYSQL_SLOW_LOG_CHUNK_BYTES);
  }, [active, connection.id, loadTail]);

  const handleRefresh = useCallback(() => {
    void loadTail(loadedBytesRef.current || MYSQL_SLOW_LOG_CHUNK_BYTES);
  }, [loadTail]);

  const handleLoadMore = useCallback(() => {
    const next = Math.min(
      (fileSize ?? loadedBytesRef.current) || MYSQL_SLOW_LOG_CHUNK_BYTES,
      loadedBytesRef.current + MYSQL_SLOW_LOG_CHUNK_BYTES,
    );
    if (next <= loadedBytesRef.current) return;
    void loadTail(next);
  }, [fileSize, loadTail]);

  const canLoadMore = fileSize !== null && loadedBytes < fileSize;

  const footer =
    fileSize !== null ? (
      <span className="db-slow-log-panel__meta">
        {t("database.slowQueryLog.loadedBytes", {
          loaded: formatBytes(loadedBytes),
          total: formatBytes(fileSize),
        })}
        {" · "}
        {logFilePath}
      </span>
    ) : (
      <span className="db-slow-log-panel__meta">{logFilePath}</span>
    );

  return (
    <div className="db-slow-log-panel">
      <LogViewer
        text={text}
        loading={loading}
        loadingText={t("database.slowQueryLog.loading")}
        emptyText={t("database.slowQueryLog.empty")}
        error={error}
        visible={active}
        streaming
        autoScroll
        className="db-slow-log-panel__viewer"
        toolbar={
          <>
            <button
              type="button"
              className="log-viewer-panel__btn"
              disabled={loading}
              onClick={handleRefresh}
            >
              {t("common.refresh")}
            </button>
            <button
              type="button"
              className="log-viewer-panel__btn"
              disabled={loading || !canLoadMore}
              onClick={handleLoadMore}
            >
              {t("database.slowQueryLog.loadMore")}
            </button>
          </>
        }
        footer={footer}
      />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
