import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../components/ui/primitives/Button";
import { useI18n } from "../../../i18n";
import {
  isRedisConnection,
  redisSlowlog,
  type DbConnectionConfig,
  type RedisSlowLogEntry,
} from "../api";
import { connectionWithDatabase } from "../toolbox/types";
import { DbTablesPanelGrid, type DbTablesPanelGridColumn } from "../workspace/DbTablesPanelGrid";

interface RedisSlowLogPanelProps {
  connection: DbConnectionConfig;
  dbName: string;
  active?: boolean;
}

function formatTime(ts: number): string {
  if (!ts) {
    return "—";
  }
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return String(ts);
  }
}

function formatDurationUs(us: number): string {
  if (us >= 1_000_000) {
    return `${(us / 1_000_000).toFixed(2)} s`;
  }
  if (us >= 1000) {
    return `${(us / 1000).toFixed(2)} ms`;
  }
  return `${us} μs`;
}

function formatClient(entry: RedisSlowLogEntry): string {
  const addr = entry.clientAddr?.trim();
  const name = entry.clientName?.trim();
  if (addr && name) {
    return `${addr} (${name})`;
  }
  return addr || name || "—";
}

export function RedisSlowLogPanel({
  connection,
  dbName,
  active = true,
}: RedisSlowLogPanelProps) {
  const { t } = useI18n();
  const capable = isRedisConnection(connection);
  const [entries, setEntries] = useState<RedisSlowLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasEntriesRef = useRef(false);
  hasEntriesRef.current = entries.length > 0;

  const refresh = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!capable) {
        return;
      }
      const silent = options?.silent ?? false;
      if (!silent) {
        setLoading(true);
      }
      setError(null);
      try {
        const scoped = connectionWithDatabase(connection, dbName);
        const next = await redisSlowlog(scoped, 64);
        setEntries(next);
      } catch (e) {
        setError(typeof e === "string" ? e : JSON.stringify(e));
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [capable, connection, dbName],
  );

  useEffect(() => {
    if (!active || !capable) {
      return;
    }
    void refresh({ silent: hasEntriesRef.current });
  }, [active, capable, refresh]);

  const columns = useMemo<DbTablesPanelGridColumn<RedisSlowLogEntry>[]>(
    () => [
      {
        id: "id",
        header: t("database.redisQuery.slowLogColId"),
        nameCell: true,
        defaultWidth: 72,
        render: (entry) => String(entry.id),
        getTitle: (entry) => String(entry.id),
        getCopyValue: (entry) => String(entry.id),
      },
      {
        id: "timestamp",
        header: t("database.redisQuery.slowLogColTime"),
        defaultWidth: 168,
        render: (entry) => formatTime(entry.timestamp),
        getTitle: (entry) => formatTime(entry.timestamp),
        getCopyValue: (entry) => formatTime(entry.timestamp),
      },
      {
        id: "duration",
        header: t("database.redisQuery.slowLogColDuration"),
        defaultWidth: 96,
        render: (entry) => (
          <span className="db-cell-num">{formatDurationUs(entry.durationUs)}</span>
        ),
        getTitle: (entry) => formatDurationUs(entry.durationUs),
        getCopyValue: (entry) => formatDurationUs(entry.durationUs),
      },
      {
        id: "command",
        header: t("database.redisQuery.slowLogColCommand"),
        defaultWidth: 320,
        minWidth: 160,
        render: (entry) => entry.command,
        getTitle: (entry) => entry.command,
        getCopyValue: (entry) => entry.command,
      },
      {
        id: "client",
        header: t("database.redisQuery.slowLogColClient"),
        defaultWidth: 180,
        render: (entry) => formatClient(entry),
        getTitle: (entry) => formatClient(entry),
        getCopyValue: (entry) => formatClient(entry),
      },
    ],
    [t],
  );

  if (!capable) {
    return (
      <div className="db-table-designer-state">
        {t("database.redisQuery.unsupportedEngine", { engine: connection.db_type })}
      </div>
    );
  }

  return (
    <div className="redis-slowlog-panel">
      <div className="redis-slowlog-panel__toolbar">
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
          {t("common.refresh")}
        </Button>
        {error ? <span className="redis-slowlog-panel__error">{error}</span> : null}
        <span className="redis-slowlog-panel__count">
          {t("database.redisQuery.slowLogCount", { count: entries.length })}
        </span>
      </div>

      {loading && entries.length === 0 ? (
        <div className="db-table-designer-state">{t("common.loading")}</div>
      ) : error && entries.length === 0 ? (
        <div className="db-table-designer-state db-table-designer-state--error">{error}</div>
      ) : entries.length === 0 ? (
        <div className="db-table-designer-state">{t("database.redisQuery.slowLogEmpty")}</div>
      ) : (
        <div className="redis-slowlog-panel__grid db-tables-panel-grid-wrap">
          <DbTablesPanelGrid
            variant="processlist"
            columns={columns}
            rows={entries}
            rowKey={(entry) => entry.id}
            columnResizeStorageKey="redis-slowlog-columns"
          />
        </div>
      )}
    </div>
  );
}
