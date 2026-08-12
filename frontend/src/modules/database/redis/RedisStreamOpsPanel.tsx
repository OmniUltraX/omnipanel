import { useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../../../i18n";
import { Button } from "../../../components/ui/primitives/Button";
import {
  redisStreamClaim,
  redisStreamCleanupInactiveConsumers,
  redisStreamGroupDestroy,
  redisStreamTrim,
  type DbConnectionConfig,
} from "../api";
import { DbTablesPanelGrid, type DbTablesPanelGridColumn } from "../workspace/DbTablesPanelGrid";
import { showToast } from "../../../stores/toastStore";
import { RedisOpsDangerDialog } from "./RedisOpsDangerDialog";
import {
  type RedisStreamConsumer,
  type RedisStreamGroup,
  type RedisStreamMonitorState,
  type RedisStreamPendingEntry,
} from "./useRedisStreamMonitor";

interface RedisStreamOpsPanelProps {
  connection: DbConnectionConfig;
  streamKey: string;
  monitor: RedisStreamMonitorState;
  renderChrome?: (toolbar: ReactNode) => ReactNode;
}

export function RedisStreamOpsPanel({
  connection,
  streamKey,
  monitor,
  renderChrome,
}: RedisStreamOpsPanelProps) {
  const { t } = useI18n();
  const [destroyOpen, setDestroyOpen] = useState(false);
  const [trimOpen, setTrimOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);

  const {
    snapshot,
    selectedGroup,
    setSelectedGroup,
    selectedConsumer,
    setSelectedConsumer,
    filteredPending,
    error,
    refresh,
  } = monitor;

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
        header: "P",
        render: (g) => (g.pending != null ? g.pending.toLocaleString() : "—"),
      },
    ],
    [t],
  );

  const consumerColumns = useMemo<DbTablesPanelGridColumn<RedisStreamConsumer>[]>(
    () => [
      {
        id: "name",
        header: t("database.redisOps.colConsumer"),
        nameCell: true,
        defaultWidth: 220,
        getTitle: (c) => c.name,
        getCopyValue: (c) => c.name,
        render: (c) => (c.active ? `● ${c.name}` : c.name),
      },
      {
        id: "idle",
        header: "Idle",
        render: (c) => (c.idleMs != null ? c.idleMs.toLocaleString() : "—"),
      },
      {
        id: "pending",
        header: "P",
        render: (c) => (c.pending != null ? c.pending.toLocaleString() : "—"),
      },
    ],
    [t],
  );

  const pendingColumns = useMemo<DbTablesPanelGridColumn<RedisStreamPendingEntry>[]>(
    () => [
      { id: "id", header: "ID", render: (p) => p.id },
      { id: "consumer", header: t("database.redisOps.colConsumer"), render: (p) => p.consumer },
      { id: "idle", header: "Idle", render: (p) => p.idleMs.toLocaleString() },
      {
        id: "delivery",
        header: t("database.redisOps.colDeliveryCount"),
        render: (p) => p.deliveryCount.toLocaleString(),
      },
    ],
    [t],
  );

  const handleClaim = async () => {
    if (!selectedGroup || filteredPending.length === 0) {
      return;
    }
    const consumer =
      selectedConsumer ??
      snapshot?.consumers.find((c) => c.active)?.name ??
      snapshot?.consumers[0]?.name;
    if (!consumer) {
      return;
    }
    await redisStreamClaim(
      connection,
      streamKey,
      selectedGroup,
      consumer,
      60_000,
      filteredPending[0]?.id ?? "0-0",
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

  const handleCleanup = async () => {
    if (!selectedGroup) {
      return;
    }
    const target =
      selectedConsumer && snapshot?.consumers.find((c) => c.name === selectedConsumer)?.active
        ? selectedConsumer
        : snapshot?.consumers.find((c) => c.active)?.name ?? null;
    const result = await redisStreamCleanupInactiveConsumers(
      connection,
      streamKey,
      selectedGroup,
      300_000,
      target,
    );
    setCleanupOpen(false);
    await refresh();
    if (result.removedConsumers.length > 0) {
      showToast(
        t("database.redisOps.cleanupDone", {
          count: result.removedConsumers.length,
          claimed: result.claimedPending,
        }),
      );
    } else if (result.failed.length > 0) {
      showToast(result.failed[0] ?? t("database.redisOps.cleanupFailed"));
    } else {
      showToast(t("database.redisOps.cleanupNone"));
    }
  };

  const hasGroups = (snapshot?.groups.length ?? 0) > 0;

  const toolbar = (
    <div className="redis-stream-ops__toolbar">
      <Button variant="ghost" size="sm" onClick={() => void handleClaim()} disabled={!selectedGroup}>
        {t("database.redisOps.claim")}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setDestroyOpen(true)} disabled={!selectedGroup}>
        {t("database.redisOps.destroyGroup")}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setTrimOpen(true)}>
        {t("database.redisOps.trim")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setCleanupOpen(true)}
        disabled={!selectedGroup}
      >
        {t("database.redisOps.cleanupInactive")}
      </Button>
    </div>
  );

  return (
    <>
      {renderChrome ? renderChrome(toolbar) : null}
      <div className="redis-stream-ops">
        {!renderChrome ? toolbar : null}

      {error ? <div className="redis-stream-ops__error">{error}</div> : null}

      {!hasGroups ? (
        <div className="redis-stream-ops__empty empty-state compact">
          {t("database.redisOps.noGroups")}
        </div>
      ) : (
        <div className="redis-stream-ops__workspace">
          <aside className="redis-stream-ops__groups-pane">
            <div className="redis-stream-ops__pane-head">
              <span className="redis-stream-ops__pane-title" title={selectedGroup ?? undefined}>
                {selectedGroup ?? t("database.redisOps.groups")}
              </span>
              <span className="redis-stream-ops__pane-count">{snapshot?.groups.length ?? 0}</span>
            </div>
            <DbTablesPanelGrid
              variant="processlist"
              className="db-tables-panel-grid--fit redis-stream-ops__groups-grid"
              columns={groupColumns}
              rows={snapshot?.groups ?? []}
              rowKey={(g) => g.name}
              selectedRowKey={selectedGroup}
              onRowClick={(g) => setSelectedGroup(g.name)}
            />
          </aside>

          <div className="redis-stream-ops__detail-pane">
            <div className="redis-stream-ops__detail-split">
              <section className="redis-stream-ops__sub-pane">
                <div className="redis-stream-ops__pane-head">
                  <span className="redis-stream-ops__pane-title">{t("database.redisOps.consumers")}</span>
                  {selectedConsumer ? (
                    <>
                      <span className="redis-stream-ops__pane-count" title={selectedConsumer}>
                        {selectedConsumer}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="redis-stream-ops__context-clear"
                        onClick={() => setSelectedConsumer(null)}
                      >
                        {t("database.redisOps.clearConsumerFilter")}
                      </Button>
                    </>
                  ) : (
                    <span className="redis-stream-ops__pane-hint">
                      {t("database.redisOps.consumersHint")}
                    </span>
                  )}
                </div>
                <DbTablesPanelGrid
                  variant="processlist"
                  className="db-tables-panel-grid--fit"
                  columns={consumerColumns}
                  rows={snapshot?.consumers ?? []}
                  rowKey={(c) => c.name}
                  selectedRowKey={selectedConsumer}
                  onRowClick={(c) =>
                    setSelectedConsumer(selectedConsumer === c.name ? null : c.name)
                  }
                />
              </section>

              <section className="redis-stream-ops__sub-pane">
                <div className="redis-stream-ops__pane-head">
                  <span className="redis-stream-ops__pane-title">Pending</span>
                  <span className="redis-stream-ops__pane-count">{filteredPending.length}</span>
                  {selectedConsumer ? (
                    <span className="redis-stream-ops__pane-hint">
                      {t("database.redisOps.pendingFiltered")}
                    </span>
                  ) : null}
                </div>
                <DbTablesPanelGrid
                  variant="processlist"
                  className="db-tables-panel-grid--fit"
                  columns={pendingColumns}
                  rows={filteredPending}
                  rowKey={(p) => p.id}
                  onRowClick={(p) => setSelectedConsumer(p.consumer)}
                />
              </section>
            </div>
          </div>
        </div>
      )}

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
      <RedisOpsDangerDialog
        open={cleanupOpen}
        title={t("database.redisOps.cleanupInactive")}
        description={t("database.redisOps.cleanupInactiveDesc")}
        command={`XGROUP DELCONSUMER ${streamKey} ${selectedGroup ?? ""} <inactive>`}
        confirmPhrase={selectedGroup ?? "CLEANUP"}
        onCancel={() => setCleanupOpen(false)}
        onConfirm={() => void handleCleanup()}
      />
      </div>
    </>
  );
}
