import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { Button } from "../../../components/ui/primitives/Button";
import {
  redisAclList,
  redisInfo,
  redisMemoryDoctor,
  redisMemoryPurge,
  redisMemoryStats,
  type DbConnectionConfig,
  type RedisAclUser,
  type RedisInfoResult,
  type RedisMemoryStats,
} from "../api";
import { DbTablesPanelGrid, type DbTablesPanelGridColumn } from "../workspace/DbTablesPanelGrid";
import { RedisSlowLogPanel } from "../redis/RedisSlowLogPanel";
import { formatBytesLabel, formatUptime, hitRate, infoSection, infoValue } from "../redis/redisInfoHelpers";
import { RedisOpsDangerDialog } from "../redis/RedisOpsDangerDialog";

interface PanelProps {
  connection: DbConnectionConfig;
  active?: boolean;
}

export function RedisOverviewPanel({ connection, active = true }: PanelProps) {
  const { t } = useI18n();
  const [info, setInfo] = useState<RedisInfoResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const historyRef = useRef<Array<{ at: number; memory: number; ops: number; clients: number }>>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await redisInfo(connection);
      setInfo(data);
      const mem = Number.parseInt(infoValue(data, "Memory", "used_memory") ?? "0", 10);
      const ops = Number.parseInt(infoValue(data, "Stats", "instantaneous_ops_per_sec") ?? "0", 10);
      const clients = Number.parseInt(infoValue(data, "Clients", "connected_clients") ?? "0", 10);
      historyRef.current = [...historyRef.current, { at: Date.now(), memory: mem, ops, clients }].slice(-20);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    if (!active) {
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const cards = useMemo(
    () => [
      {
        label: t("database.redisOps.version"),
        value: infoValue(info, "Server", "redis_version") ?? "—",
      },
      {
        label: t("database.redisOps.usedMemory"),
        value: formatBytesLabel(infoValue(info, "Memory", "used_memory")),
      },
      {
        label: t("database.redisOps.opsPerSec"),
        value: infoValue(info, "Stats", "instantaneous_ops_per_sec") ?? "—",
      },
      {
        label: t("database.redisOps.connectedClients"),
        value: infoValue(info, "Clients", "connected_clients") ?? "—",
      },
      {
        label: t("database.redisOps.hitRate"),
        value: hitRate(info),
      },
      {
        label: t("database.redisOps.uptime"),
        value: formatUptime(infoValue(info, "Server", "uptime_in_seconds")),
      },
    ],
    [info, t],
  );

  return (
    <div className="redis-ops-overview">
      <div className="redis-ops-overview__toolbar">
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
          {t("common.refresh")}
        </Button>
      </div>
      {error ? <div className="redis-ops-overview__error">{error}</div> : null}
      <div className="redis-ops-overview__cards">
        {cards.map((card) => (
          <div key={card.label} className="redis-ops-overview__card">
            <div className="redis-ops-overview__card-label">{card.label}</div>
            <div className="redis-ops-overview__card-value">{card.value}</div>
          </div>
        ))}
      </div>
      {historyRef.current.length > 1 ? (
        <div className="redis-ops-overview__sparkline-hint">
          {t("database.redisOps.sparklineHint")}
        </div>
      ) : null}
    </div>
  );
}

export function RedisMemoryPanel({ connection, active = true }: PanelProps) {
  const { t } = useI18n();
  const [stats, setStats] = useState<RedisMemoryStats | null>(null);
  const [doctor, setDoctor] = useState("");
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statsResult, doctorResult] = await Promise.all([
        redisMemoryStats(connection),
        redisMemoryDoctor(connection),
      ]);
      setStats(statsResult);
      setDoctor(doctorResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    if (!active) {
      return;
    }
    void refresh();
  }, [active, refresh]);

  const frag = Number.parseFloat(stats?.entries["fragmentation_ratio"] ?? "0");

  return (
    <div className="redis-ops-memory">
      <div className="redis-ops-memory__toolbar">
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
          {t("common.refresh")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setPurgeOpen(true)}>
          {t("database.redisOps.memoryPurge")}
        </Button>
      </div>
      {error ? <div className="redis-ops-memory__error">{error}</div> : null}
      <div className="redis-ops-memory__summary">
        <div>
          <span>{t("database.redisOps.usedMemory")}</span>
          <strong>{formatBytesLabel(stats?.entries["total.allocated"])}</strong>
        </div>
        <div>
          <span>{t("database.redisOps.peakMemory")}</span>
          <strong>{formatBytesLabel(stats?.entries["peak.allocated"])}</strong>
        </div>
        <div>
          <span>{t("database.redisOps.fragmentation")}</span>
          <strong className={frag > 1.5 ? "redis-ops-warn" : undefined}>{frag || "—"}</strong>
        </div>
      </div>
      <pre className="redis-ops-memory__doctor">{doctor || t("common.loading")}</pre>
      <RedisOpsDangerDialog
        open={purgeOpen}
        title={t("database.redisOps.memoryPurge")}
        description={t("database.redisOps.memoryPurgeDesc")}
        command="MEMORY PURGE"
        confirmPhrase="PURGE"
        onCancel={() => setPurgeOpen(false)}
        onConfirm={() => {
          setPurgeOpen(false);
          void redisMemoryPurge(connection).then(() => refresh());
        }}
      />
    </div>
  );
}

export function RedisReplicationPanel({ connection, active = true }: PanelProps) {
  const { t } = useI18n();
  const [info, setInfo] = useState<RedisInfoResult | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setInfo(await redisInfo(connection, "replication"));
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    if (!active) {
      return;
    }
    void refresh();
  }, [active, refresh]);

  const repl = infoSection(info, "Replication");
  const role = repl.role ?? "standalone";

  const rows = useMemo(
    () =>
      Object.entries(repl).map(([key, value]) => ({
        key,
        value,
      })),
    [repl],
  );

  const columns = useMemo<DbTablesPanelGridColumn<{ key: string; value: string }>[]>(
    () => [
      { id: "key", header: "Key", render: (r) => r.key },
      { id: "value", header: "Value", render: (r) => r.value },
    ],
    [],
  );

  return (
    <div className="redis-ops-repl">
      <div className="redis-ops-repl__toolbar">
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
          {t("common.refresh")}
        </Button>
        <span className="redis-ops-repl__role">
          {role === "master" || role === "slave" || role === "replica"
            ? role
            : t("database.redisOps.standalone")}
        </span>
      </div>
      <DbTablesPanelGrid
        variant="variables"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
      />
    </div>
  );
}

export function RedisAclPanel({ connection, active = true }: PanelProps) {
  const { t } = useI18n();
  const [users, setUsers] = useState<RedisAclUser[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await redisAclList(connection));
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    if (!active) {
      return;
    }
    void refresh();
  }, [active, refresh]);

  const columns = useMemo<DbTablesPanelGridColumn<RedisAclUser>[]>(
    () => [
      { id: "username", header: t("database.redisOps.colUser"), render: (u) => u.username },
      { id: "flags", header: "Flags", render: (u) => u.flags },
      { id: "commands", header: "Commands", render: (u) => u.commands },
      { id: "keys", header: "Keys", render: (u) => u.keys },
    ],
    [t],
  );

  return (
    <div className="redis-ops-acl">
      <div className="redis-ops-acl__toolbar">
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
          {t("common.refresh")}
        </Button>
      </div>
      <DbTablesPanelGrid
        variant="variables"
        columns={columns}
        rows={users}
        rowKey={(u) => u.username}
      />
    </div>
  );
}

export function RedisConnectionSlowlogPanel({ connection, active = true }: PanelProps) {
  if (!active) {
    return null;
  }
  const dbName = connection.database?.trim() || "0";
  return <RedisSlowLogPanel connection={connection} dbName={dbName} active={active} />;
}
