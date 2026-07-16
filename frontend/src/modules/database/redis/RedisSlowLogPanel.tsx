import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import {
  isRedisConnection,
  redisSlowlog,
  type DbConnectionConfig,
  type RedisSlowLogEntry,
} from "../api";
import { connectionWithDatabase } from "../toolbox/types";
import { TableDataGrid } from "../grid/TableDataGrid";

interface RedisSlowLogPanelProps {
  connection: DbConnectionConfig;
  dbName: string;
  active?: boolean;
}

const COLUMNS = ["id", "timestamp", "durationUs", "command", "clientAddr"] as const;

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
  const enteredRef = useRef(false);

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
      enteredRef.current = false;
      return;
    }
    if (enteredRef.current) {
      return;
    }
    enteredRef.current = true;
    if (entries.length === 0) {
      void refresh();
    } else {
      void refresh({ silent: true });
    }
  }, [active, capable, entries.length, refresh]);

  if (!capable) {
    return <div className="db-table-designer-state">{t("database.redisQuery.unsupportedEngine", { engine: connection.db_type })}</div>;
  }

  if (loading && entries.length === 0) {
    return <div className="db-table-designer-state">{t("common.loading")}</div>;
  }

  if (error && entries.length === 0) {
    return <div className="db-table-designer-state db-table-designer-state--error">{error}</div>;
  }

  if (entries.length === 0) {
    return <div className="db-table-designer-state">{t("database.redisQuery.slowLogEmpty")}</div>;
  }

  const rows = entries.map((entry) => ({
    id: entry.id,
    timestamp: formatTime(entry.timestamp),
    durationUs: entry.durationUs,
    command: entry.command,
    clientAddr: entry.clientAddr ?? "—",
  }));

  return (
    <div className="redis-slowlog-panel">
      <TableDataGrid
        columns={[...COLUMNS]}
        rows={rows}
        totalRows={rows.length}
        page={0}
        pageSize={Math.max(rows.length, 1)}
        loading={loading}
        onPageChange={() => {}}
      />
    </div>
  );
}
