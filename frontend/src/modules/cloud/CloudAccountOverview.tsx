import { useEffect, useMemo, useState } from "react";
import { useI18n, getEnvLabel } from "../../i18n";
import { Button } from "../../components/ui/primitives/Button";
import { commands } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { useConnectionStore } from "../../stores/connectionStore";
import { usePluginRuntimeStore } from "../../stores/pluginRuntimeStore";
import { ServerTreeIcon } from "../server/panel/serverTreeIcons";
import {
  capabilityI18nKey,
  cloudRegionLabel,
  maskCloudAccessKey,
  type CloudAccount,
} from "./cloudForm";
import { cloudCapabilitiesForPlugin, isGlobalCloudCapability } from "./cloudCapabilities";
import { listLinkedCloudFiles, listLinkedCloudSsh } from "./cloudResourceLinks";
import { cloudListSlotKey } from "./cloudInventory";
import { cloudAccountRefreshKey, cloudListRefreshKey, useCloudInventoryStore } from "../../stores/cloudInventoryStore";
import type { CloudDockOpenMode } from "./cloudWorkspaceTabs";

function envLabel(tag: string): string {
  const key = tag.trim().toLowerCase();
  if (key === "prod" || key === "staging" || key === "dev" || key === "local" || key === "unknown") {
    return getEnvLabel(key);
  }
  return tag.trim() || getEnvLabel("unknown");
}

export function CloudAccountOverview({
  account,
  selectedRegions,
  onOpenCapability,
}: {
  account: CloudAccount;
  selectedRegions: string[];
  onOpenCapability: (capability: string, mode?: CloudDockOpenMode) => void;
}) {
  const { t } = useI18n();
  const connections = useConnectionStore((s) => s.connections);
  usePluginRuntimeStore((s) => s.items);
  usePluginRuntimeStore((s) => s.hydrated);
  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState<"idle" | "ok" | "err">("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const capabilities = cloudCapabilitiesForPlugin(account.pluginId);
  const inventory = useCloudInventoryStore((s) => s.byAccount[account.id]);
  const refreshingKeys = useCloudInventoryStore((s) => s.refreshingKeys);
  const snapshotEntry = inventory?.snapshot;
  const snapshot = snapshotEntry?.snapshot ?? null;
  const snapshotError = snapshotEntry?.error && !snapshot?.callerId ? snapshotEntry.error : null;
  const accountRefreshing = Boolean(refreshingKeys[cloudAccountRefreshKey(account.id)]);
  const cloudConn = connections.find((c) => c.id === account.id);
  const linkedSsh = useMemo(
    () => listLinkedCloudSsh(connections, account.id),
    [account.id, connections],
  );
  const linkedFiles = useMemo(
    () => listLinkedCloudFiles(connections, account.id),
    [account.id, connections],
  );

  useEffect(() => {
    const caps = cloudCapabilitiesForPlugin(account.pluginId);
    if (caps.length === 0) return;
    for (const cap of caps) {
      void useCloudInventoryStore.getState().ensureList(
        account.id,
        cap.id,
        isGlobalCloudCapability(cap) ? [] : selectedRegions,
        { quiet: true },
      );
    }
  }, [account.id, account.pluginId, selectedRegions]);

  useEffect(() => {
    void useCloudInventoryStore
      .getState()
      .ensureAccount(account.id, { quiet: true })
      .catch(() => undefined);
  }, [account.id]);

  const counts = useMemo(() => {
    const next: Record<string, number | null> = {};
    for (const cap of capabilities) {
      const slot = cloudListSlotKey(cap.id, isGlobalCloudCapability(cap) ? [] : selectedRegions);
      const entry = inventory?.lists[slot];
      next[cap.id] = entry ? entry.rows.length : null;
    }
    return next;
  }, [capabilities, inventory, selectedRegions]);

  const countsLoading = capabilities.some((cap) => {
    const regions = isGlobalCloudCapability(cap) ? [] : selectedRegions;
    const slot = cloudListSlotKey(cap.id, regions);
    const hasCache = Boolean(inventory?.lists[slot]);
    const key = cloudListRefreshKey(account.id, cap.id, regions);
    return !hasCache && Boolean(refreshingKeys[key]);
  });

  const handleTest = async () => {
    if (!cloudConn) return;
    setTesting(true);
    try {
      const message = await unwrapCommand(commands.cloudTest(cloudConn, null));
      setTestState("ok");
      setTestMessage(t("server.cloud.create.testSuccess", { detail: message }));
    } catch (err) {
      setTestState("err");
      setTestMessage(t("server.cloud.create.testFailed", { error: formatIpcError(err) }));
    } finally {
      setTesting(false);
    }
  };

  const regionText =
    account.regions.length === 0
      ? t("cloud.filter.allRegions")
      : account.regions.map((id) => cloudRegionLabel(id)).join("、");

  return (
    <div className="cloud-overview">
      <header className="db-tables-panel-header db-connection-info-header">
        <span className="cloud-overview__brand" aria-hidden>
          <ServerTreeIcon kind="aliyun" />
        </span>
        <span className="db-tables-panel-header-label">{account.name}</span>
        <div className="db-tables-panel-header-tags">
          <span className="db-tables-panel-header-tag">{t("plugins.names.aliyun")}</span>
          <span className="db-tables-panel-header-tag">{envLabel(account.envTag)}</span>
          <span className="db-tables-panel-header-tag" title={account.accessKeyId}>
            {maskCloudAccessKey(account.accessKeyId)}
          </span>
          <span className="db-tables-panel-header-tag" title={regionText}>
            {regionText}
          </span>
        </div>
        <div className="db-tables-panel-header-actions">
          <Button type="button" size="sm" variant="outline" disabled={testing || !cloudConn} onClick={() => void handleTest()}>
            {testing ? t("server.cloud.create.testing") : t("server.cloud.create.test")}
          </Button>
        </div>
      </header>
      {testMessage ? (
        <p className={`cloud-overview__test cloud-overview__test--${testState}`}>{testMessage}</p>
      ) : null}

      <section className="cloud-overview__section">
        <h3 className="cloud-overview__title">
          {t("cloud.account.title")}
          {accountRefreshing && snapshot ? (
            <span className="cloud-overview__card-hint"> · {t("cloud.list.syncing")}</span>
          ) : null}
        </h3>
        {snapshotError ? (
          <p className="form-hint">{snapshotError}</p>
        ) : (
          <div className="cloud-overview__grid">
            <div className="cloud-overview__card cloud-overview__card--static">
              <span className="cloud-overview__card-label">{t("cloud.account.callerId")}</span>
              <strong className="cloud-overview__card-value cloud-overview__card-value--sm">
                {snapshot?.callerId || "…"}
              </strong>
              {snapshot?.arn ? (
                <span className="cloud-overview__card-hint" title={snapshot.arn}>
                  {snapshot.arn}
                </span>
              ) : null}
            </div>
            <div className="cloud-overview__card cloud-overview__card--static">
              <span className="cloud-overview__card-label">{t("cloud.account.available")}</span>
              <strong className="cloud-overview__card-value">
                {snapshot?.balanceError
                  ? "—"
                  : snapshot
                    ? `${snapshot.availableAmount || "—"} ${snapshot.currency ?? ""}`.trim()
                    : "…"}
              </strong>
              {snapshot?.balanceError ? (
                <span className="cloud-overview__card-hint" title={snapshot.balanceError}>
                  {t("cloud.account.noBalance")}
                </span>
              ) : (
                <span className="cloud-overview__card-hint">
                  {t("cloud.account.cash")} {snapshot?.cashAmount || "—"}
                  {snapshot?.creditAmount ? ` · ${t("cloud.account.credit")} ${snapshot.creditAmount}` : ""}
                </span>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="cloud-overview__section">
        <h3 className="cloud-overview__title">{t("cloud.overview.capabilities")}</h3>
        {capabilities.length === 0 ? (
          <p className="form-hint">{t("cloud.overview.noCapabilities")}</p>
        ) : (
          <div className="cloud-overview__grid">
            {capabilities.map((cap) => {
              const count = counts[cap.id];
              const value = countsLoading && count == null ? "…" : count == null ? "—" : String(count);
              return (
                <button
                  key={cap.id}
                  type="button"
                  className="cloud-overview__card"
                  onClick={() => onOpenCapability(cap.id, "permanent")}
                >
                  <span className="cloud-overview__card-label">{t(capabilityI18nKey(cap.id))}</span>
                  <strong className="cloud-overview__card-value">{value}</strong>
                  <span className="cloud-overview__card-hint">{t("cloud.overview.openList")}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <div className="cloud-overview__links">
        <section className="cloud-overview__link-block">
          <h3 className="cloud-overview__title">{t("cloud.overview.linkedSsh")}</h3>
          {linkedSsh.length === 0 ? (
            <p className="form-hint">{t("cloud.overview.none")}</p>
          ) : (
            <ul className="cloud-overview__link-list">
              {linkedSsh.map((conn) => (
                <li key={conn.id}>{conn.name}</li>
              ))}
            </ul>
          )}
        </section>
        <section className="cloud-overview__link-block">
          <h3 className="cloud-overview__title">{t("cloud.overview.linkedFiles")}</h3>
          {linkedFiles.length === 0 ? (
            <p className="form-hint">{t("cloud.overview.none")}</p>
          ) : (
            <ul className="cloud-overview__link-list">
              {linkedFiles.map((conn) => (
                <li key={conn.id}>{conn.name}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
