import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/primitives/Button";
import { commands } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { appConfirm } from "../../lib/appConfirm";
import { showToast } from "../../stores/toastStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import type { CloudAccount } from "./cloudForm";
import { formatCloudFieldValue } from "./cloudForm";
import { cloudCapabilityById } from "./cloudCapabilities";
import { capabilityHasDeclaredAction } from "./cloudWorkspaceTabs";
import {
  addCloudInstanceToSsh,
  addCloudOssToFile,
  findLinkedOssFileConnection,
  findLinkedSshConnection,
} from "./cloudResourceLinks";
import { cloudRowField } from "./cloudResourceApi";
import { cloudDetailSlotKey, findCachedCloudRow, rowToCloudDetailStub } from "./cloudInventory";
import { cloudDetailRefreshKey, useCloudInventoryStore } from "../../stores/cloudInventoryStore";

const FIELD_ORDER = [
  "instanceType",
  "plan",
  "chargeType",
  "expiredTime",
  "autoReleaseTime",
  "zone",
  "publicIp",
  "privateIp",
  "os",
  "hostname",
  "cpu",
  "memory",
  "bandwidth",
  "securityGroups",
  "vpcId",
  "keyPair",
  "imageId",
  "diskSize",
  "storageClass",
  "endpoint",
  "domain",
  "type",
  "product",
  "certType",
  "creationTime",
  "creationDate",
  "registrationDate",
  "expirationDate",
  "endDate",
];

export function CloudResourceDetailPanel({
  account,
  capability,
  resourceId,
  regionId,
}: {
  account: CloudAccount;
  capability: string;
  resourceId: string;
  regionId: string;
}) {
  const { t } = useI18n();
  const connections = useConnectionStore((s) => s.connections);
  const saveConn = useConnectionStore((s) => s.save);
  const cloudConnection = connections.find((c) => c.id === account.id);
  const cap = cloudCapabilityById(account.pluginId, capability);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const detailSlot = cloudDetailSlotKey(capability, resourceId, regionId);
  const detailRefreshKey = cloudDetailRefreshKey(account.id, capability, resourceId, regionId);
  const inventory = useCloudInventoryStore((s) => s.byAccount[account.id]);
  const detailEntry = inventory?.details[detailSlot];
  const refreshing = useCloudInventoryStore((s) => Boolean(s.refreshingKeys[detailRefreshKey]));
  const stubRow = findCachedCloudRow(inventory, capability, resourceId);
  const detail = detailEntry?.detail ?? (stubRow ? rowToCloudDetailStub(stubRow) : null);
  const error = detail ? null : loadError ?? detailEntry?.error ?? null;

  const reload = useCallback(
    async (force = false) => {
      try {
        await useCloudInventoryStore.getState().ensureDetail(
          account.id,
          capability,
          resourceId,
          regionId,
          { force, quiet: true },
        );
        setLoadError(null);
      } catch (err) {
        const message = formatIpcError(err);
        setLoadError(message);
        if (force) showToast(message);
      }
    },
    [account.id, capability, regionId, resourceId],
  );

  useEffect(() => {
    void reload(false);
  }, [reload]);

  const invoke = async (action: string) => {
    const isProd = account.envTag.trim().toLowerCase() === "prod";
    if (isProd) {
      const ok = await appConfirm(t("cloud.actions.confirmProd", { action: t(`cloud.actions.${action}`) }));
      if (!ok) return;
    }
    setBusy(true);
    try {
      await unwrapCommand(
        commands.cloudInvokeAction(account.id, {
          name: action,
          resourceId,
          capability,
          regionId,
          confirmed: isProd,
        }),
      );
      showToast(t("cloud.actions.submitted", { action: t(`cloud.actions.${action}`) }));
      await reload(true);
    } catch (err) {
      showToast(formatIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return <div className="server-main" style={{ padding: 16 }}>{error}</div>;
  }
  if (!detail) {
    return <div className="server-main" style={{ padding: 16 }}>{t("cloud.tree.loading")}</div>;
  }

  const sshLinked = findLinkedSshConnection(
    connections,
    account.id,
    capability,
    detail.id,
    cloudRowField(detail.fields, "publicIp"),
    cloudRowField(detail.fields, "privateIp"),
  );
  const ossLinked = findLinkedOssFileConnection(connections, account.id, detail.id);

  return (
    <div className="server-main" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <h2 style={{ margin: 0 }}>{detail.name || detail.id}</h2>
        <p className="form-hint">
          {detail.status || "—"}
          {detail.regionId ? ` · ${detail.regionId}` : ""}
          {refreshing ? ` · ${t("cloud.list.syncing")}` : ""}
        </p>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {capabilityHasDeclaredAction(cap?.actions, "start") ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void invoke("start")}>
            {t("cloud.actions.start")}
          </Button>
        ) : null}
        {capabilityHasDeclaredAction(cap?.actions, "stop") ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void invoke("stop")}>
            {t("cloud.actions.stop")}
          </Button>
        ) : null}
        {capabilityHasDeclaredAction(cap?.actions, "reboot") ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void invoke("reboot")}>
            {t("cloud.actions.reboot")}
          </Button>
        ) : null}
        {capabilityHasDeclaredAction(cap?.actions, "addSsh") ? (
          <Button
            type="button"
            variant="outline"
            disabled={Boolean(sshLinked) || busy}
            onClick={() => {
              void (async () => {
                try {
                  await addCloudInstanceToSsh(
                    account,
                    capability,
                    {
                      id: detail.id,
                      name: detail.name,
                      publicIp: cloudRowField(detail.fields, "publicIp"),
                      privateIp: cloudRowField(detail.fields, "privateIp"),
                    },
                    saveConn,
                  );
                  showToast(t("server.cloud.actions.addedSsh", { name: detail.name || detail.id }));
                } catch (err) {
                  if (String(err).includes("NO_HOST")) showToast(t("server.cloud.actions.noHost"));
                  else showToast(formatIpcError(err));
                }
              })();
            }}
          >
            {sshLinked ? t("server.cloud.actions.alreadySsh") : t("server.cloud.actions.addSsh")}
          </Button>
        ) : null}
        {capabilityHasDeclaredAction(cap?.actions, "addToFiles") && cloudConnection ? (
          <Button
            type="button"
            variant="outline"
            disabled={Boolean(ossLinked) || busy}
            onClick={() => {
              void (async () => {
                try {
                  await addCloudOssToFile(account, cloudConnection, {
                    id: detail.id,
                    name: detail.name,
                    region: detail.regionId,
                    endpoint: cloudRowField(detail.fields, "endpoint"),
                  });
                  showToast(t("server.cloud.actions.addedOss", { name: detail.name || detail.id }));
                } catch (err) {
                  showToast(formatIpcError(err));
                }
              })();
            }}
          >
            {ossLinked ? t("server.cloud.actions.alreadyOss") : t("server.cloud.actions.addOss")}
          </Button>
        ) : null}
        {capabilityHasDeclaredAction(cap?.actions, "openConsole") && detail.consoleUrl ? (
          <Button type="button" variant="outline" onClick={() => void openExternal(detail.consoleUrl!)}>
            {t("cloud.actions.openConsole")}
          </Button>
        ) : null}
      </div>
      <dl style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: "8px 16px", margin: 0 }}>
        {FIELD_ORDER.filter((key) => cloudRowField(detail.fields, key)).map((key) => (
          <div key={key} style={{ display: "contents" }}>
            <dt className="form-hint">{t(`cloud.columns.${key}`)}</dt>
            <dd style={{ margin: 0 }}>{formatCloudFieldValue(t, key, cloudRowField(detail.fields, key))}</dd>
          </div>
        ))}
        {Object.keys(detail.fields ?? {})
          .filter((key) => !FIELD_ORDER.includes(key) && cloudRowField(detail.fields, key))
          .map((key) => (
            <div key={key} style={{ display: "contents" }}>
              <dt className="form-hint">{t(`cloud.columns.${key}`)}</dt>
              <dd style={{ margin: 0 }}>{formatCloudFieldValue(t, key, cloudRowField(detail.fields, key))}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
}
