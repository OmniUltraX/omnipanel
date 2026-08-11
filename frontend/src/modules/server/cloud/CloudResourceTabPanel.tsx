import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { useI18n } from "../../../i18n";
import { Button } from "../../../components/ui/primitives/Button";
import { IconFolder, IconRefresh, IconTerminal } from "../../../components/ui/Icons";
import {
  DbTablesPanelGrid,
  type DbTablesPanelGridColumn,
} from "../../database/workspace/DbTablesPanelGrid";
import { commands } from "../../../ipc/bindings";
import { unwrapCommand, formatIpcError } from "../../../ipc/result";
import { useConnectionStore } from "../../../stores/connectionStore";
import { showToast } from "../../../stores/toastStore";
import type { CloudAccount } from "./cloudForm";
import type { CloudResourceTab } from "./cloudSidebarNav";
import {
  addCloudInstanceToSsh,
  addCloudOssToFile,
  findLinkedOssFileConnection,
  findLinkedSshConnection,
  pickInstanceHost,
} from "./cloudResourceLinks";

type Row = Record<string, string>;

async function loadRows(
  tab: CloudResourceTab,
  connectionId: string,
  region: string,
): Promise<Row[]> {
  const regionArg = region.trim() || null;
  switch (tab) {
    case "oss": {
      const raw = await unwrapCommand(commands.cloudListOss(connectionId, regionArg));
      const list = Array.isArray(raw) ? raw : [];
      return list.map((item) => ({
        id: item.name,
        name: item.name,
        region: item.region || item.location,
        storageClass: item.storageClass,
        creationDate: item.creationDate,
        endpoint: item.extranetEndpoint,
      }));
    }
    case "swas": {
      const raw = await unwrapCommand(commands.cloudListSwas(connectionId, regionArg));
      const list = Array.isArray(raw) ? raw : [];
      return list.map((item) => ({
        id: item.instanceId,
        name: item.instanceName || item.instanceId,
        status: item.status,
        region: item.regionId,
        publicIp: item.publicIpAddress,
        privateIp: item.privateIpAddress,
        plan: item.instancePlan,
        creationTime: item.creationTime,
      }));
    }
    case "domains": {
      const raw = await unwrapCommand(commands.cloudListDomains(connectionId));
      const list = Array.isArray(raw) ? raw : [];
      return list.map((item) => ({
        id: item.domainName || item.instanceId,
        domain: item.domainName,
        status: item.domainStatus,
        type: item.domainType,
        registrationDate: item.registrationDate,
        expirationDate: item.expirationDate,
      }));
    }
    case "ecs": {
      const raw = await unwrapCommand(commands.cloudListEcs(connectionId, regionArg));
      const list = Array.isArray(raw) ? raw : [];
      return list.map((item) => ({
        id: item.instanceId,
        name: item.instanceName || item.instanceId,
        status: item.status,
        region: item.regionId,
        zone: item.zoneId,
        type: item.instanceType,
        publicIp: item.publicIpAddress,
        privateIp: item.privateIpAddress,
        os: item.osName,
        creationTime: item.creationTime,
      }));
    }
    case "certs": {
      const raw = await unwrapCommand(commands.cloudListCerts(connectionId));
      const list = Array.isArray(raw) ? raw : [];
      return list.map((item) => ({
        id: item.orderId || item.domain,
        name: item.name,
        domain: item.domain,
        status: item.status,
        product: item.productName,
        certType: item.certType,
        buyDate: item.buyDate,
        endDate: item.endDate,
      }));
    }
  }
}

function LinkedNameCell({
  label,
  linkedName,
}: {
  label: string;
  linkedName: string | null;
}) {
  return (
    <span className="cloud-resource-name-cell">
      <span className="cloud-resource-name-cell__text">{label || "—"}</span>
      {linkedName ? (
        <span className="badge badge-muted cloud-resource-linked-tag" title={linkedName}>
          {linkedName}
        </span>
      ) : null}
    </span>
  );
}

interface CloudResourceTabPanelProps {
  account: CloudAccount;
  region: string;
  tab: CloudResourceTab;
  active: boolean;
}

export function CloudResourceTabPanel({ account, region, tab, active }: CloudResourceTabPanelProps) {
  const { t } = useI18n();
  const connections = useConnectionStore((s) => s.connections);
  const saveConn = useConnectionStore((s) => s.save);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadRows(tab, account.id, region);
      setRows(next);
    } catch (err) {
      setRows([]);
      setError(formatIpcError(err));
    } finally {
      setLoading(false);
    }
  }, [account.id, region, tab]);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  const cloudConnection = useMemo(
    () => connections.find((c) => c.id === account.id) ?? null,
    [account.id, connections],
  );

  const linkedByRowId = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    if (tab === "ecs" || tab === "swas") {
      for (const row of rows) {
        const linked = findLinkedSshConnection(
          connections,
          account.id,
          tab,
          row.id,
          row.publicIp,
          row.privateIp,
        );
        if (linked) map.set(row.id, { id: linked.id, name: linked.name });
      }
    } else if (tab === "oss") {
      for (const row of rows) {
        const linked = findLinkedOssFileConnection(connections, account.id, row.name || row.id);
        if (linked) map.set(row.id, { id: linked.id, name: linked.name });
      }
    }
    return map;
  }, [account.id, connections, rows, tab]);

  const handleAddSsh = useCallback(
    async (row: Row, kind: "ecs" | "swas") => {
      if (linkedByRowId.has(row.id)) return;
      if (!pickInstanceHost(row.publicIp, row.privateIp)) {
        showToast(t("server.cloud.actions.noHost"));
        return;
      }
      setBusyId(row.id);
      try {
        const saved = await addCloudInstanceToSsh(
          account,
          kind,
          {
            id: row.id,
            name: row.name || row.id,
            publicIp: row.publicIp,
            privateIp: row.privateIp,
          },
          saveConn,
        );
        showToast(t("server.cloud.actions.addedSsh", { name: saved.name }));
      } catch (err) {
        const msg = String(err);
        if (msg.includes("NO_HOST")) {
          showToast(t("server.cloud.actions.noHost"));
        } else {
          showToast(formatIpcError(err));
        }
      } finally {
        setBusyId(null);
      }
    },
    [account, linkedByRowId, saveConn, t],
  );

  const handleAddOss = useCallback(
    async (row: Row) => {
      if (linkedByRowId.has(row.id)) return;
      if (!cloudConnection) {
        showToast(t("server.cloud.actions.noCloudAccount"));
        return;
      }
      setBusyId(row.id);
      try {
        const saved = await addCloudOssToFile(account, cloudConnection, {
          id: row.id,
          name: row.name || row.id,
          region: row.region,
          endpoint: row.endpoint,
        });
        // 刷新 connection store，使侧栏/匹配立刻可见
        useConnectionStore.setState((s) => {
          const idx = s.connections.findIndex((c) => c.id === saved.id);
          const next =
            idx >= 0
              ? s.connections.map((c) => (c.id === saved.id ? saved : c))
              : [saved, ...s.connections];
          return { connections: next, loaded: true };
        });
        showToast(t("server.cloud.actions.addedOss", { name: saved.name }));
      } catch (err) {
        const msg = String(err);
        if (msg.includes("NO_AK")) {
          showToast(t("server.cloud.actions.noAccessKey"));
        } else if (msg.includes("NO_BUCKET")) {
          showToast(t("server.cloud.actions.noBucket"));
        } else {
          showToast(formatIpcError(err));
        }
      } finally {
        setBusyId(null);
      }
    },
    [account, cloudConnection, linkedByRowId, t],
  );

  const columns = useMemo((): DbTablesPanelGridColumn<Row>[] => {
    const col = (key: string, field: keyof Row, width = 140): DbTablesPanelGridColumn<Row> => ({
      id: key,
      header: t(`server.cloud.columns.${tab}.${key}`),
      defaultWidth: width,
      minWidth: 80,
      render: (row) => row[field] || "—",
    });

    const nameWithLink = (
      key: string,
      field: keyof Row,
      width = 180,
    ): DbTablesPanelGridColumn<Row> => ({
      id: key,
      header: t(`server.cloud.columns.${tab}.${key}`),
      nameCell: true,
      defaultWidth: width,
      minWidth: 120,
      render: (row) => (
        <LinkedNameCell
          label={row[field] || ""}
          linkedName={linkedByRowId.get(row.id)?.name ?? null}
        />
      ),
      getTitle: (row) => {
        const linked = linkedByRowId.get(row.id)?.name;
        const base = row[field] || "";
        return linked ? `${base} · ${linked}` : base || undefined;
      },
      getCopyValue: (row) => row[field] || undefined,
    });

    const stop = (event: MouseEvent) => {
      event.stopPropagation();
    };

    const sshActions = (kind: "ecs" | "swas"): DbTablesPanelGridColumn<Row> => ({
      id: "actions",
      header: t("server.cloud.columns.actions"),
      variant: "actionsSticky",
      copyable: false,
      resizable: false,
      defaultWidth: 44,
      minWidth: 44,
      render: (row) => {
        const linked = linkedByRowId.has(row.id);
        const busy = busyId === row.id;
        return (
          <div className="cloud-resource-actions" onClick={stop}>
            <Button
              type="button"
              variant="icon"
              size="icon-xs"
              title={
                linked
                  ? t("server.cloud.actions.alreadySsh")
                  : t("server.cloud.actions.addSsh")
              }
              aria-label={t("server.cloud.actions.addSsh")}
              disabled={linked || busy}
              onClick={(event) => {
                event.stopPropagation();
                void handleAddSsh(row, kind);
              }}
            >
              <IconTerminal size={13} />
            </Button>
          </div>
        );
      },
    });

    const ossActions = (): DbTablesPanelGridColumn<Row> => ({
      id: "actions",
      header: t("server.cloud.columns.actions"),
      variant: "actionsSticky",
      copyable: false,
      resizable: false,
      defaultWidth: 44,
      minWidth: 44,
      render: (row) => {
        const linked = linkedByRowId.has(row.id);
        const busy = busyId === row.id;
        return (
          <div className="cloud-resource-actions" onClick={stop}>
            <Button
              type="button"
              variant="icon"
              size="icon-xs"
              title={
                linked
                  ? t("server.cloud.actions.alreadyOss")
                  : t("server.cloud.actions.addOss")
              }
              aria-label={t("server.cloud.actions.addOss")}
              disabled={linked || busy}
              onClick={(event) => {
                event.stopPropagation();
                void handleAddOss(row);
              }}
            >
              <IconFolder size={13} />
            </Button>
          </div>
        );
      },
    });

    switch (tab) {
      case "oss":
        return [
          nameWithLink("name", "name", 200),
          col("region", "region", 120),
          col("storageClass", "storageClass", 110),
          col("creationDate", "creationDate", 180),
          col("endpoint", "endpoint", 220),
          ossActions(),
        ];
      case "swas":
        return [
          nameWithLink("name", "name", 180),
          col("status", "status", 100),
          col("region", "region", 120),
          col("publicIp", "publicIp", 130),
          col("privateIp", "privateIp", 130),
          col("plan", "plan", 120),
          sshActions("swas"),
        ];
      case "domains":
        return [
          col("domain", "domain", 200),
          col("status", "status", 100),
          col("type", "type", 100),
          col("registrationDate", "registrationDate", 160),
          col("expirationDate", "expirationDate", 160),
        ];
      case "ecs":
        return [
          nameWithLink("name", "name", 180),
          col("status", "status", 100),
          col("type", "type", 120),
          col("zone", "zone", 120),
          col("publicIp", "publicIp", 130),
          col("privateIp", "privateIp", 130),
          col("os", "os", 160),
          sshActions("ecs"),
        ];
      case "certs":
        return [
          col("name", "name", 140),
          col("domain", "domain", 180),
          col("status", "status", 100),
          col("product", "product", 140),
          col("certType", "certType", 100),
          col("endDate", "endDate", 140),
        ];
    }
  }, [busyId, handleAddOss, handleAddSsh, linkedByRowId, t, tab]);

  return (
    <div className="server-content cloud-resource-panel">
      <div className="panel-toolbar" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="text-muted" style={{ fontSize: 12 }}>
          {t("server.cloud.readonlyHint")} · {region}
        </span>
        <div style={{ flex: 1 }} />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <IconRefresh size={14} />
          {loading ? t("server.refreshing") : t("server.refresh")}
        </Button>
      </div>
      {error ? <div className="form-status form-status--error">{error}</div> : null}
      {!error && rows.length === 0 && !loading ? (
        <div className="empty-state compact">{t(`server.cloud.empty.${tab}`)}</div>
      ) : (
        <DbTablesPanelGrid
          variant="processlist"
          className="server-websites-grid"
          rows={rows}
          columns={columns}
          rowKey={(row) => row.id}
          columnResizeStorageKey={`omnipanel.server.cloud.${tab}.column-widths.v2`}
        />
      )}
      {loading && rows.length === 0 ? (
        <div className="empty-state compact">{t("common.loading")}</div>
      ) : null}
    </div>
  );
}
