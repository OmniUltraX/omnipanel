import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { Button } from "../../../components/ui/primitives/Button";
import {
  redisStreamClaim,
  redisStreamGroupDestroy,
  redisStreamMonitor,
  redisStreamPending,
  redisStreamTrim,
  type DbConnectionConfig,
  type RedisStreamConsumer,
  type RedisStreamGroup,
  type RedisStreamMonitorSnapshot,
  type RedisStreamPendingEntry,
} from "../api";
import { DbTablesPanelGrid, type DbTablesPanelGridColumn } from "../workspace/DbTablesPanelGrid";
import { RedisOpsDangerDialog } from "./RedisOpsDangerDialog";

interface RedisStreamOpsPanelProps {
  connection: DbConnectionConfig;
  streamKey: string;
  active?: boolean;
}

interface RateSample {
  at: number;
  lag: number;
  entriesRead: number;
}

function streamIdTs(id: string | null | undefined): Date | null {
  if (!id) {
    return null;
  }
  const ms = Number.parseInt(id.split("-")[0] ?? "", 10);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms);
}

export function RedisStreamOpsPanel({
  connection,
  streamKey,
  active = true,
}: RedisStreamOpsPanelProps) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<RedisStreamMonitorSnapshot | null>(null);
  const [pending, setPending] = useState<RedisStreamPendingEntry[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [destroyOpen, setDestroyOpen] = useState(false);
  const [trimOpen, setTrimOpen] = useState(false);
  const samplesRef = useRef<RateSample[]>([]);

  const refresh = useCallback(async () => {
    if (!streamKey) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await redisStreamMonitor(connection, streamKey, selectedGroup ?? undefined);
      setSnapshot(data);
      const group = selectedGroup ?? data.groups[0]?.name;
      if (group) {
        setSelectedGroup(group);
        const pendingRows = await redisStreamPending(connection, streamKey, group);
        setPending(pendingRows);
      } else {
        setPending([]);
      }
      const primary = data.groups[0];
      if (primary?.lag != null && primary.entriesRead != null) {
        const now = Date.now();
        const samples = [...samplesRef.current, { at: now, lag: primary.lag, entriesRead: primary.entriesRead }];
        samplesRef.current = samples.slice(-12);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [connection, selectedGroup, streamKey]);

  useEffect(() => {
    if (!active || !streamKey) {
      return;
    }
    void refresh();
  }, [active, refresh, streamKey]);

  useEffect(() => {
    if (!active || !autoRefresh || !streamKey) {
      return;
    }
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [active, autoRefresh, refresh, streamKey]);

  const rateStats = useMemo(() => {
    const samples = samplesRef.current;
    if (samples.length < 2) {
      return null;
    }
    const prev = samples[samples.length - 2];
    const curr = samples[samples.length - 1];
    const dt = (curr.at - prev.at) / 1000;
    if (dt <= 0) {
      return null;
    }
    const lagDelta = prev.lag - curr.lag;
    const rate = (curr.entriesRead - prev.entriesRead) / dt;
    const activeConsumers = snapshot?.consumers.filter((c) => c.active).length ?? 0;
    const catchUpHours =
      lagDelta > 0 && curr.lag > 0 ? curr.lag / (lagDelta / dt) / 3600 : null;
    return { lagDelta, rate, activeConsumers, catchUpHours, lag: curr.lag };
  }, [snapshot]);

  const groupColumns = useMemo<DbTablesPanelGridColumn<RedisStreamGroup>[]>(
    () => [
      { id: "name", header: t("database.redisOps.colGroup"), render: (g) => g.name },
      {
        id: "lag",
        header: "Lag",
        render: (g) => (g.lag != null ? g.lag.toLocaleString() : "—"),
      },
      {
        id: "pending",
        header: "Pending",
        render: (g) => (g.pending != null ? g.pending.toLocaleString() : "—"),
      },
      {
        id: "entriesRead",
        header: t("database.redisOps.colEntriesRead"),
        render: (g) => (g.entriesRead != null ? g.entriesRead.toLocaleString() : "—"),
      },
      {
        id: "lastDelivered",
        header: t("database.redisOps.colLastDelivered"),
        render: (g) => g.lastDeliveredId ?? "—",
      },
      {
        id: "behind",
        header: t("database.redisOps.colBehind"),
        render: (g) =>
          g.behindSeconds != null ? `${g.behindSeconds}s` : "—",
      },
    ],
    [t],
  );

  const consumerColumns = useMemo<DbTablesPanelGridColumn<RedisStreamConsumer>[]>(
    () => [
      {
        id: "name",
        header: t("database.redisOps.colConsumer"),
        render: (c) => (c.active ? `● ${c.name}` : c.name),
      },
      {
        id: "idle",
        header: "Idle (ms)",
        render: (c) => (c.idleMs != null ? c.idleMs.toLocaleString() : "—"),
      },
      {
        id: "pending",
        header: "Pending",
        render: (c) => (c.pending != null ? c.pending.toLocaleString() : "—"),
      },
    ],
    [t],
  );

  const pendingColumns = useMemo<DbTablesPanelGridColumn<RedisStreamPendingEntry>[]>(
    () => [
      { id: "id", header: "ID", render: (p) => p.id },
      { id: "consumer", header: t("database.redisOps.colConsumer"), render: (p) => p.consumer },
      { id: "idle", header: "Idle (ms)", render: (p) => p.idleMs.toLocaleString() },
      {
        id: "delivery",
        header: t("database.redisOps.colDeliveryCount"),
        render: (p) => p.deliveryCount.toLocaleString(),
      },
    ],
    [t],
  );

  const newestTs = streamIdTs(snapshot?.newestId);
  const ldTs = streamIdTs(snapshot?.groups[0]?.lastDeliveredId);

  const handleClaim = async () => {
    if (!selectedGroup || pending.length === 0) {
      return;
    }
    const consumer = snapshot?.consumers.find((c) => c.active)?.name ?? snapshot?.consumers[0]?.name;
    if (!consumer) {
      return;
    }
    await redisStreamClaim(
      connection,
      streamKey,
      selectedGroup,
      consumer,
      60_000,
      pending[0]?.id ?? "0-0",
      10,
    );
    await refresh();
  };

  const handleDestroy = async () => {
    if (!selectedGroup) {
      return;
    }
    await redisStreamGroupDestroy(connection, streamKey, selectedGroup);
    setDestroyOpen(false);
    await refresh();
  };

  const handleTrim = async () => {
    await redisStreamTrim(connection, streamKey, 10_000, true);
    setTrimOpen(false);
    await refresh();
  };

  return (
    <div className="redis-stream-ops">
      <div className="redis-stream-ops__toolbar">
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
          {t("common.refresh")}
        </Button>
        <label className="redis-stream-ops__auto">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          {t("database.redisOps.autoRefresh")}
        </label>
        <Button variant="ghost" size="sm" onClick={() => void handleClaim()} disabled={!selectedGroup}>
          {t("database.redisOps.claim")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDestroyOpen(true)} disabled={!selectedGroup}>
          {t("database.redisOps.destroyGroup")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setTrimOpen(true)}>
          {t("database.redisOps.trim")}
        </Button>
      </div>

      {error ? <div className="redis-stream-ops__error">{error}</div> : null}

      <div className="redis-stream-ops__metrics">
        <div className="redis-stream-ops__metric">
          <span className="label">Lag</span>
          <span className="value">{snapshot?.groups[0]?.lag?.toLocaleString() ?? "—"}</span>
        </div>
        <div className="redis-stream-ops__metric">
          <span className="label">Pending</span>
          <span className="value">{snapshot?.groups[0]?.pending?.toLocaleString() ?? "—"}</span>
        </div>
        <div className="redis-stream-ops__metric">
          <span className="label">{t("database.redisOps.colBehind")}</span>
          <span className="value">
            {snapshot?.groups[0]?.behindSeconds != null
              ? `${snapshot.groups[0].behindSeconds}s`
              : "—"}
          </span>
        </div>
        <div className="redis-stream-ops__metric">
          <span className="label">LD</span>
          <span className="value">{ldTs?.toLocaleString() ?? "—"}</span>
        </div>
        <div className="redis-stream-ops__metric">
          <span className="label">{t("database.redisOps.newest")}</span>
          <span className="value">{newestTs?.toLocaleString() ?? "—"}</span>
        </div>
        <div className="redis-stream-ops__metric">
          <span className="label">{t("database.redisOps.activeConsumers")}</span>
          <span className="value">
            {rateStats
              ? `${rateStats.activeConsumers}/${snapshot?.consumers.length ?? 0}`
              : `${snapshot?.consumers.filter((c) => c.active).length ?? 0}/${snapshot?.consumers.length ?? 0}`}
          </span>
        </div>
        {rateStats ? (
          <>
            <div className="redis-stream-ops__metric">
              <span className="label">Δ Lag (10s)</span>
              <span className="value">{rateStats.lagDelta}</span>
            </div>
            <div className="redis-stream-ops__metric">
              <span className="label">Rate/s</span>
              <span className="value">{rateStats.rate.toFixed(1)}</span>
            </div>
            <div className="redis-stream-ops__metric">
              <span className="label">{t("database.redisOps.catchUpHours")}</span>
              <span className="value">
                {rateStats.catchUpHours != null ? rateStats.catchUpHours.toFixed(1) : "—"}
              </span>
            </div>
          </>
        ) : null}
      </div>

      <div className="redis-stream-ops__section">
        <div className="redis-stream-ops__section-title">{t("database.redisOps.groups")}</div>
        <DbTablesPanelGrid
          variant="processlist"
          className="db-tables-panel-grid--fit"
          columns={groupColumns}
          rows={snapshot?.groups ?? []}
          rowKey={(g) => g.name}
          selectedRowKey={selectedGroup}
          onRowClick={(g) => setSelectedGroup(g.name)}
        />
      </div>

      <div className="redis-stream-ops__section">
        <div className="redis-stream-ops__section-title">{t("database.redisOps.consumers")}</div>
        <DbTablesPanelGrid
          variant="processlist"
          className="db-tables-panel-grid--fit"
          columns={consumerColumns}
          rows={snapshot?.consumers ?? []}
          rowKey={(c) => c.name}
        />
      </div>

      <div className="redis-stream-ops__section">
        <div className="redis-stream-ops__section-title">Pending</div>
        <DbTablesPanelGrid
          variant="processlist"
          className="db-tables-panel-grid--fit"
          columns={pendingColumns}
          rows={pending}
          rowKey={(p) => p.id}
        />
      </div>

      <RedisOpsDangerDialog
        open={destroyOpen}
        title={t("database.redisOps.destroyGroup")}
        description={t("database.redisOps.destroyGroupDesc")}
        command={`XGROUP DESTROY ${streamKey} ${selectedGroup ?? ""}`}
        confirmPhrase={selectedGroup ?? "DESTROY"}
        onCancel={() => setDestroyOpen(false)}
        onConfirm={() => void handleDestroy()}
      />
      <RedisOpsDangerDialog
        open={trimOpen}
        title={t("database.redisOps.trim")}
        description={t("database.redisOps.trimDesc")}
        command={`XTRIM ${streamKey} MAXLEN ~ 10000`}
        confirmPhrase="XTRIM"
        onCancel={() => setTrimOpen(false)}
        onConfirm={() => void handleTrim()}
      />
    </div>
  );
}
