import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/primitives/Button";
import { commands, type CloudChildRow, type CloudLogPage, type CloudMetricSeries, type CloudNetworkRule, type CloudRelatedRef } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { showToast } from "../../stores/toastStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { cloudBrandKind, cloudCapabilityLabel, cloudRegionLabel, formatCloudFieldValue, type CloudAccount } from "./cloudForm";
import { cloudCapabilityById } from "./cloudCapabilities";
import { capabilityHasDeclaredAction } from "./cloudWorkspaceTabs";
import {
  addCloudInstanceToSsh,
  addCloudOssToFile,
  addCloudRdsToDatabase,
  findLinkedOssFileConnection,
  findLinkedSshConnection,
} from "./cloudResourceLinks";
import { cloudRowField, loadCloudLogs, loadCloudMetrics } from "./cloudResourceApi";
import { cloudDetailSlotKey, findCachedCloudRow, rowToCloudDetailStub } from "./cloudInventory";
import { cloudDetailRefreshKey, useCloudInventoryStore } from "../../stores/cloudInventoryStore";
import { useCloudDockStore } from "../../stores/cloudDockStore";
import { CloudMetricCharts, cloudMetricQueryForRange, type CloudMetricRangeId } from "./CloudMetricCharts";
import { CloudRuleEditor } from "./CloudRuleEditor";
import { CloudSlowLogPanel } from "./CloudSlowLogPanel";
import {
  cloudLogWindow,
  collectCloudLogDbNames,
  msToDatetimeLocal,
  type CloudLogRangeId,
  type CloudLogSortDir,
  type CloudLogSortKey,
} from "./cloudLogQuery";
import { CloudChildTable } from "./CloudChildTable";
import { TextInput } from "../../components/ui/form/TextInput";
import { Select } from "../../components/ui/form/Select";
import { FormDialog, FormField } from "../../components/ui/form/FormDialog";
import { CLOUD_HIGHLIGHT_KEYS, cloudStatusTone, copyCloudText } from "./cloudDetailUi";
import { CloudPager } from "./CloudListPager";
import { CLOUD_LOG_DEFAULT_PAGE_SIZE, useCloudPaging } from "./cloudPaging";
import { ServerTreeIcon } from "../server/panel/serverTreeIcons";

const FIELD_ORDER = [
  "instanceType",
  "instanceClass",
  "engine",
  "engineVersion",
  "plan",
  "chargeType",
  "expiredTime",
  "autoReleaseTime",
  "zone",
  "publicIp",
  "privateIp",
  "connectionString",
  "port",
  "os",
  "hostname",
  "cpu",
  "memory",
  "bandwidth",
  "securityGroups",
  "vpcId",
  "instanceCount",
  "diskCount",
  "snapshotCount",
  "keyPair",
  "imageId",
  "diskSize",
  "storage",
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
  "description",
  "networkType",
  "recordCount",
  "dnsServers",
  "capacity",
  "instanceId",
  "addressType",
  "size",
  "category",
];

type DetailSlot = "overview" | "metrics" | "rules" | "logs" | "security" | "records" | "members" | "backups";

const LIST_DETAIL_SLOTS = new Set<DetailSlot>(["metrics", "rules", "logs", "records", "members", "backups"]);

function relatedRoleLabel(
  t: (key: string) => string,
  item: CloudRelatedRef,
  pluginId?: string,
): string {
  if (item.role === "disk") return t("cloud.detail.relatedRoles.disk");
  if (item.role === "securityGroup") return t("cloud.capability.networkSecurityGroup");
  if (item.role === "vpc") return t("cloud.columns.vpcId");
  if (item.role === "instance") {
    if (item.capability) return cloudCapabilityLabel(t, item.capability, pluginId);
    return t("cloud.detail.relatedRoles.instance");
  }
  if (item.capability) return cloudCapabilityLabel(t, item.capability, pluginId);
  return item.role || item.resourceId;
}

function RelatedResourceCards({
  items,
  accountId,
  pluginId,
  regionId,
  onSelect,
  t,
}: {
  items: CloudRelatedRef[];
  accountId: string;
  pluginId?: string;
  regionId: string;
  onSelect: (accountId: string, capability: string, resourceId: string, regionId: string, mode: "permanent") => void;
  t: (key: string) => string;
}) {
  const paging = useCloudPaging(items, items.map((item) => item.resourceId).join(","));
  if (items.length === 0) return null;
  return (
    <>
      {paging.slice.map((item) => {
        const clickable = Boolean(item.capability);
        const className = clickable ? "cloud-related__item" : "cloud-related__item is-static";
        const body = (
          <>
            <strong>{item.name || item.resourceId}</strong>
            <span>{relatedRoleLabel(t, item, pluginId)}</span>
          </>
        );
        return clickable ? (
          <button
            key={`${item.role}-${item.resourceId}`}
            type="button"
            className={className}
            onClick={() => onSelect(accountId, item.capability, item.resourceId, regionId, "permanent")}
          >
            {body}
          </button>
        ) : (
          <div key={`${item.role}-${item.resourceId}`} className={className}>
            {body}
          </div>
        );
      })}
      <CloudPager
        page={paging.page}
        pageSize={paging.pageSize}
        total={paging.total}
        totalPages={paging.totalPages}
        from={paging.from}
        to={paging.to}
        onPageChange={paging.setPage}
        onPageSizeChange={paging.setPageSize}
      />
    </>
  );
}

function resolveSlots(
  declared: string[] | undefined,
  detail: {
    metricIds?: string[];
    rules?: CloudNetworkRule[];
    related?: { role?: string }[];
    logKinds?: string[];
    children?: CloudChildRow[];
  } | null,
): DetailSlot[] {
  const slots = new Set<DetailSlot>(["overview"]);
  const declaredSlots: DetailSlot[] = [
    "overview",
    "metrics",
    "rules",
    "logs",
    "security",
    "records",
    "members",
    "backups",
  ];
  for (const item of declared ?? []) {
    if (declaredSlots.includes(item as DetailSlot)) slots.add(item as DetailSlot);
  }
  if ((detail?.metricIds?.length ?? 0) > 0) slots.add("metrics");
  if ((detail?.rules?.length ?? 0) > 0) slots.add("rules");
  if (detail?.related?.some((item) => item.role === "securityGroup")) slots.add("security");
  if (detail?.related?.some((item) => item.role === "instance")) slots.add("members");
  if ((detail?.logKinds?.length ?? 0) > 0) slots.add("logs");
  const kinds = new Set((detail?.children ?? []).map((row) => row.kind ?? ""));
  if (kinds.has("dnsRecord")) slots.add("records");
  if (
    kinds.has("listener") ||
    kinds.has("backend") ||
    kinds.has("account") ||
    kinds.has("parameter") ||
    kinds.has("database")
  ) {
    slots.add("members");
  }
  if (kinds.has("backup") || kinds.has("snapshot") || kinds.has("disk")) slots.add("backups");
  if (detail?.related?.some((item) => item.role === "disk")) slots.add("backups");
  return declaredSlots.filter((slot) => slots.has(slot));
}

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
  const selectResource = useCloudDockStore((s) => s.selectResource);
  const cloudConnection = connections.find((c) => c.id === account.id);
  const cap = cloudCapabilityById(account.pluginId, capability);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [slot, setSlot] = useState<DetailSlot>("overview");
  const [rangeId, setRangeId] = useState<CloudMetricRangeId>("1h");
  const [metrics, setMetrics] = useState<CloudMetricSeries[]>([]);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [logs, setLogs] = useState<CloudLogPage | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logPage, setLogPage] = useState(1);
  const [logPageSize, setLogPageSize] = useState(CLOUD_LOG_DEFAULT_PAGE_SIZE);
  const [logRangeId, setLogRangeId] = useState<CloudLogRangeId>("24h");
  const [logCustomStart, setLogCustomStart] = useState(() =>
    msToDatetimeLocal(Date.now() - 24 * 3600_000),
  );
  const [logCustomEnd, setLogCustomEnd] = useState(() => msToDatetimeLocal(Date.now()));
  const [logQueryStartMs, setLogQueryStartMs] = useState(() => Date.now() - 24 * 3600_000);
  const [logQueryEndMs, setLogQueryEndMs] = useState(() => Date.now());
  const [logDbName, setLogDbName] = useState("");
  const [logKeyword, setLogKeyword] = useState("");
  const [logSortKey, setLogSortKey] = useState<CloudLogSortKey>("time");
  const [logSortDir, setLogSortDir] = useState<CloudLogSortDir>("desc");
  const [securityGroupId, setSecurityGroupId] = useState("");
  const [bindInstanceId, setBindInstanceId] = useState("");
  const [bandwidth, setBandwidth] = useState("");
  const [snapshotName, setSnapshotName] = useState("");
  const [snapshotDiskId, setSnapshotDiskId] = useState("");
  const [actionDialog, setActionDialog] = useState<
    null | "attachInstance" | "modifyBandwidth" | "createSnapshot" | "bindSecurityGroup" | "createInstanceSnapshot"
  >(null);
  const detailSlot = cloudDetailSlotKey(capability, resourceId, regionId);
  const detailRefreshKey = cloudDetailRefreshKey(account.id, capability, resourceId, regionId);
  const inventory = useCloudInventoryStore((s) => s.byAccount[account.id]);
  const detailEntry = inventory?.details[detailSlot];
  const refreshing = useCloudInventoryStore((s) => Boolean(s.refreshingKeys[detailRefreshKey]));
  const stubRow = findCachedCloudRow(inventory, capability, resourceId);
  const detail = detailEntry?.detail ?? (stubRow ? rowToCloudDetailStub(stubRow) : null);
  const error = detail ? null : loadError ?? detailEntry?.error ?? null;
  const slots = useMemo(() => resolveSlots(cap?.detailSlots, detail), [cap?.detailSlots, detail]);
  const logDbNames = useMemo(
    () =>
      collectCloudLogDbNames(
        (detail?.children ?? [])
          .filter((row) => row.kind === "database")
          .map((row) => row.name || row.id || ""),
        logs?.entries ?? [],
      ),
    [detail?.children, logs?.entries],
  );

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

  useEffect(() => {
    if (!slots.includes(slot)) setSlot("overview");
  }, [slot, slots]);

  const relatedDisks = useMemo(
    () => (detail?.related ?? []).filter((item) => item.role === "disk"),
    [detail?.related],
  );
  const relatedSecurityGroups = useMemo(
    () => (detail?.related ?? []).filter((item) => item.role === "securityGroup"),
    [detail?.related],
  );
  const relatedOthers = useMemo(
    () =>
      (detail?.related ?? []).filter(
        (item) => item.role !== "disk" && item.role !== "securityGroup",
      ),
    [detail?.related],
  );

  useEffect(() => {
    if (relatedDisks.length === 0) {
      setSnapshotDiskId("");
      return;
    }
    if (!relatedDisks.some((item) => item.resourceId === snapshotDiskId)) {
      setSnapshotDiskId(relatedDisks[0]?.resourceId ?? "");
    }
  }, [relatedDisks, snapshotDiskId]);

  const invoke = async (action: string, params: Record<string, string> = {}) => {
    const { ACTION_CLOUD_LIFECYCLE, pipeTarget } = await import("../../lib/presenceTargets");
    const { requireStepUp } = await import("../../lib/stepUp");
    const token = await requireStepUp({
      action: ACTION_CLOUD_LIFECYCLE,
      target: pipeTarget(account.id, resourceId, action),
      title: t(`cloud.actions.${action}`),
      message: t("cloud.actions.confirmProd", { action: t(`cloud.actions.${action}`) }),
      reason: action,
    });
    if (!token) return false;
    setBusy(true);
    try {
      await unwrapCommand(
        commands.cloudInvokeAction(account.id, {
          name: action,
          resourceId,
          capability,
          regionId,
          presenceToken: token,
          params,
        }),
      );
      showToast(t("cloud.actions.submitted", { action: t(`cloud.actions.${action}`) }));
      await reload(true);
      setActionDialog(null);
      return true;
    } catch (err) {
      showToast(formatIpcError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const refreshMetrics = useCallback(async () => {
    setMetricsLoading(true);
    setMetricsError(null);
    try {
      const query = cloudMetricQueryForRange(rangeId);
      const rows = await loadCloudMetrics(account.id, capability, resourceId, regionId, {
        metricIds: detail?.metricIds ?? [],
        startMs: query.startMs,
        endMs: query.endMs,
        periodSec: query.periodSec,
      });
      setMetrics(rows);
    } catch (err) {
      setMetricsError(formatIpcError(err));
    } finally {
      setMetricsLoading(false);
    }
  }, [account.id, capability, detail?.metricIds, rangeId, regionId, resourceId]);

  const refreshLogs = useCallback(async () => {
    setLogsLoading(true);
    setLogsError(null);
    try {
      const page = await loadCloudLogs(account.id, capability, resourceId, regionId, {
        kind: "slow",
        startMs: logQueryStartMs,
        endMs: logQueryEndMs,
        page: logPage,
        pageSize: logPageSize,
        dbName: logDbName || undefined,
        sortKey: logSortKey,
        sortDir: logSortDir,
        keyword: logKeyword || undefined,
      });
      setLogs(page);
    } catch (err) {
      setLogsError(formatIpcError(err));
    } finally {
      setLogsLoading(false);
    }
  }, [
    account.id,
    capability,
    logDbName,
    logKeyword,
    logPage,
    logPageSize,
    logQueryEndMs,
    logQueryStartMs,
    logSortDir,
    logSortKey,
    regionId,
    resourceId,
  ]);

  useEffect(() => {
    if (slot === "metrics") void refreshMetrics();
  }, [refreshMetrics, slot]);

  useEffect(() => {
    setLogPage(1);
    setLogRangeId("24h");
    setLogDbName("");
    setLogKeyword("");
    setLogSortKey("time");
    setLogSortDir("desc");
    const win = cloudLogWindow("24h", "", "");
    setLogCustomStart(msToDatetimeLocal(win.startMs));
    setLogCustomEnd(msToDatetimeLocal(win.endMs));
    setLogQueryStartMs(win.startMs);
    setLogQueryEndMs(win.endMs);
  }, [account.id, capability, resourceId]);

  useEffect(() => {
    if (slot === "logs") void refreshLogs();
  }, [refreshLogs, slot]);

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
  const statusTone = cloudStatusTone(detail.status);
  const fieldEntries = [
    ...FIELD_ORDER.filter((key) => cloudRowField(detail.fields, key)),
    ...Object.keys(detail.fields ?? {}).filter(
      (key) => !FIELD_ORDER.includes(key) && cloudRowField(detail.fields, key),
    ),
  ];
  const highlightKeys = fieldEntries.filter((key) =>
    (CLOUD_HIGHLIGHT_KEYS as readonly string[]).includes(key),
  );
  const restKeys = fieldEntries.filter((key) => !highlightKeys.includes(key));
  const ingressCount = (detail.rules ?? []).filter((rule) => (rule.direction || "ingress") !== "egress").length;
  const egressCount = (detail.rules ?? []).filter((rule) => rule.direction === "egress").length;

  const copyValue = (value: string) => {
    void copyCloudText(value).then((ok) => {
      if (ok) showToast(t("common.copied"));
    });
  };

  return (
    <div className={`cloud-detail${LIST_DETAIL_SLOTS.has(slot) ? " cloud-detail--list" : ""}`}>
      <header className="cloud-detail__header">
        <div className="cloud-detail__identity">
          <span className="cloud-detail__brand" aria-hidden>
            <ServerTreeIcon kind={cloudBrandKind(account.pluginId)} />
          </span>
          <div className="cloud-detail__titles">
            <h2 className="cloud-detail__name">{detail.name || detail.id}</h2>
            <div className="cloud-detail__chips">
              <span className={`cloud-pill cloud-pill--${statusTone}`}>
                {formatCloudFieldValue(t, "status", detail.status || "") || "—"}
              </span>
              <span className="cloud-chip">{cloudCapabilityLabel(t, capability, account.pluginId)}</span>
              {detail.regionId ? (
                <span className="cloud-chip">{cloudRegionLabel(detail.regionId)}</span>
              ) : null}
              <button
                type="button"
                className="cloud-chip cloud-chip--copy"
                title={t("common.copy")}
                onClick={() => copyValue(detail.id)}
              >
                {detail.id}
              </button>
              {refreshing ? <span className="cloud-chip">{t("cloud.list.syncing")}</span> : null}
            </div>
          </div>
        </div>
      </header>
      {slots.length > 1 ? (
        <div className="cloud-detail__tabs" role="tablist">
          {slots.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={slot === item}
              className={`cloud-detail__tab${slot === item ? " is-active" : ""}`}
              onClick={() => setSlot(item)}
            >
              {t(`cloud.detail.slots.${item}`)}
              {item === "rules" && (detail.rules?.length ?? 0) > 0 ? (
                <span className="cloud-detail__tab-count">{detail.rules?.length}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="cloud-detail__body">
      {slot === "overview" ? (
        <>
          <div className="cloud-detail__toolbar">
            {capabilityHasDeclaredAction(cap?.actions, "start") ? (
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void invoke("start")}>
                {t("cloud.actions.start")}
              </Button>
            ) : null}
            {capabilityHasDeclaredAction(cap?.actions, "stop") ? (
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void invoke("stop")}>
                {t("cloud.actions.stop")}
              </Button>
            ) : null}
            {capabilityHasDeclaredAction(cap?.actions, "reboot") ? (
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void invoke("reboot")}>
                {t("cloud.actions.reboot")}
              </Button>
            ) : null}
            {capabilityHasDeclaredAction(cap?.actions, "attach") && capability !== "compute" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setActionDialog("attachInstance")}
              >
                {t("cloud.actions.attach")}
              </Button>
            ) : null}
            {capabilityHasDeclaredAction(cap?.actions, "detach") && capability !== "compute" ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void invoke("detach", bindInstanceId.trim() ? { instanceId: bindInstanceId.trim() } : {})}
              >
                {t("cloud.actions.detach")}
              </Button>
            ) : null}
            {capabilityHasDeclaredAction(cap?.actions, "modifyBandwidth") ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setActionDialog("modifyBandwidth")}
              >
                {t("cloud.actions.modifyBandwidth")}
              </Button>
            ) : null}
            {capabilityHasDeclaredAction(cap?.actions, "createSnapshot") && capability === "storage.disk" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setActionDialog("createSnapshot")}
              >
                {t("cloud.actions.createSnapshot")}
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
            {capabilityHasDeclaredAction(cap?.actions, "addToDatabase") ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void (async () => {
                    try {
                      await addCloudRdsToDatabase(account, {
                        id: detail.id,
                        name: detail.name,
                        engine: cloudRowField(detail.fields, "engine"),
                        host: cloudRowField(detail.fields, "connectionString"),
                        port: cloudRowField(detail.fields, "port"),
                      });
                      showToast(t("cloud.actions.addedDb", { name: detail.name || detail.id }));
                    } catch (err) {
                      if (String(err).includes("NO_HOST")) showToast(t("server.cloud.actions.noHost"));
                      else showToast(formatIpcError(err));
                    }
                  })();
                }}
              >
                {t("cloud.actions.addToDatabase")}
              </Button>
            ) : null}
          </div>
          {slots.includes("rules") ? (
            <div className="cloud-stat-grid">
              {capability === "database" || capability === "database.cache" ? (
                <button type="button" className="cloud-stat" onClick={() => setSlot("rules")}>
                  <span className="cloud-stat__label">{t("cloud.rules.whitelist")}</span>
                  <strong className="cloud-stat__value">{detail.rules?.length ?? 0}</strong>
                  <span className="cloud-stat__hint">{t("cloud.detail.openRules")}</span>
                </button>
              ) : (
                <>
                  <button type="button" className="cloud-stat" onClick={() => setSlot("rules")}>
                    <span className="cloud-stat__label">{t("cloud.rules.ingress")}</span>
                    <strong className="cloud-stat__value">{ingressCount}</strong>
                    <span className="cloud-stat__hint">{t("cloud.detail.openRules")}</span>
                  </button>
                  <button type="button" className="cloud-stat" onClick={() => setSlot("rules")}>
                    <span className="cloud-stat__label">{t("cloud.rules.egress")}</span>
                    <strong className="cloud-stat__value">{egressCount}</strong>
                    <span className="cloud-stat__hint">{t("cloud.detail.openRules")}</span>
                  </button>
                </>
              )}
            </div>
          ) : null}
          {highlightKeys.length > 0 ? (
            <div className="cloud-prop-grid">
              {highlightKeys.map((key) => {
                const value = formatCloudFieldValue(t, key, cloudRowField(detail.fields, key));
                return (
                  <button
                    key={key}
                    type="button"
                    className="cloud-prop"
                    onClick={() => copyValue(cloudRowField(detail.fields, key))}
                    title={t("common.copy")}
                  >
                    <span className="cloud-prop__label">{t(`cloud.columns.${key}`)}</span>
                    <strong className="cloud-prop__value">{value}</strong>
                  </button>
                );
              })}
            </div>
          ) : null}
          {restKeys.length > 0 ? (
            <section className="cloud-panel-card">
              <h3 className="cloud-panel-card__title">{t("cloud.detail.properties")}</h3>
              <dl className="cloud-detail__fields">
                {restKeys.map((key) => (
                  <div key={key} className="cloud-detail__field">
                    <dt>{t(`cloud.columns.${key}`)}</dt>
                    <dd>{formatCloudFieldValue(t, key, cloudRowField(detail.fields, key))}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          {relatedDisks.length > 0 ? (
            <div className="cloud-related cloud-panel-card">
              <h3 className="cloud-panel-card__title">{t("cloud.detail.disks")}</h3>
              <RelatedResourceCards
                items={relatedDisks}
                accountId={account.id}
                pluginId={account.pluginId}
                regionId={regionId}
                onSelect={selectResource}
                t={t}
              />
            </div>
          ) : null}
          {relatedSecurityGroups.length > 0 || relatedOthers.length > 0 ? (
            <div className="cloud-related cloud-panel-card">
              <h3 className="cloud-panel-card__title">{t("cloud.detail.related")}</h3>
              <RelatedResourceCards
                items={[...relatedSecurityGroups, ...relatedOthers]}
                accountId={account.id}
                pluginId={account.pluginId}
                regionId={regionId}
                onSelect={selectResource}
                t={t}
              />
            </div>
          ) : null}
        </>
      ) : null}

      {slot === "metrics" ? (
        <CloudMetricCharts
          series={metrics}
          rangeId={rangeId}
          loading={metricsLoading}
          error={metricsError}
          onRangeChange={setRangeId}
          onRefresh={() => void refreshMetrics()}
        />
      ) : null}

      {slot === "security" ? (
        <div className="cloud-related cloud-panel-card">
          <h3 className="cloud-panel-card__title">{t("cloud.detail.slots.security")}</h3>
          <RelatedResourceCards
            items={(detail.related ?? []).filter((item) => item.role === "securityGroup")}
            accountId={account.id}
            pluginId={account.pluginId}
            regionId={regionId}
            onSelect={selectResource}
            t={t}
          />
          {(detail.related ?? []).filter((item) => item.role === "securityGroup").length === 0 ? (
            <p className="form-hint">{t("cloud.detail.noSecurityGroups")}</p>
          ) : null}
          {capabilityHasDeclaredAction(cap?.actions, "attach") ? (
            <div className="cloud-subpanel__bar cloud-subpanel__bar--plain">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setActionDialog("bindSecurityGroup")}
              >
                {t("cloud.actions.attach")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {slot === "rules" ? (
        <CloudRuleEditor
          rules={detail.rules ?? []}
          busy={busy}
          cidrOnly={capability === "database" || capability === "database.cache"}
          onAuthorize={(params) => invoke("authorizeRule", params)}
          onRevoke={(rule) =>
            invoke("revokeRule", {
              ruleId: rule.id ?? "",
              direction: rule.direction ?? "ingress",
              protocol: rule.protocol ?? "",
              portRange: rule.portRange ?? "",
              cidr: rule.cidr ?? "",
              nicType: rule.nicType ?? "",
            })
          }
        />
      ) : null}

      {slot === "logs" ? (
        <CloudSlowLogPanel
          page={logs}
          pageSize={logPageSize}
          loading={logsLoading}
          error={logsError}
          rangeId={logRangeId}
          customStart={logCustomStart}
          customEnd={logCustomEnd}
          onRangeChange={(id) => {
            const win = cloudLogWindow(id, "", "");
            setLogRangeId(id);
            setLogPage(1);
            setLogCustomStart(msToDatetimeLocal(win.startMs));
            setLogCustomEnd(msToDatetimeLocal(win.endMs));
            setLogQueryStartMs(win.startMs);
            setLogQueryEndMs(win.endMs);
          }}
          dbName={logDbName}
          dbNames={logDbNames}
          sortKey={logSortKey}
          sortDir={logSortDir}
          onCustomChange={(start, end) => {
            setLogCustomStart(start);
            setLogCustomEnd(end);
          }}
          onSortChange={(key, dir) => {
            setLogSortKey(key);
            setLogSortDir(dir);
            setLogPage(1);
          }}
          onApplyQuery={({ dbName, keyword }) => {
            const win = cloudLogWindow("custom", logCustomStart, logCustomEnd);
            setLogRangeId("custom");
            setLogDbName(dbName.trim());
            setLogKeyword(keyword.trim());
            setLogPage(1);
            setLogQueryStartMs(win.startMs);
            setLogQueryEndMs(win.endMs);
          }}
          onRefresh={() => void refreshLogs()}
          onPageChange={setLogPage}
          onPageSizeChange={(size) => {
            setLogPage(1);
            setLogPageSize(size);
          }}
        />
      ) : null}

      {slot === "records" ? (
        <CloudChildTable
          rows={detail.children ?? []}
          kinds={["dnsRecord"]}
          busy={busy}
          onAdd={(params) => invoke("addRecord", params)}
          onUpdate={(_row, params) => invoke("updateRecord", params)}
          onDelete={(row) => invoke("deleteRecord", { recordId: row.id ?? "" })}
        />
      ) : null}

      {slot === "members" ? (
        <>
          {(detail.related ?? []).some((item) => item.role === "instance") ? (
            <div className="cloud-related cloud-panel-card">
              <h3 className="cloud-panel-card__title">{t("cloud.detail.relatedRoles.instance")}</h3>
              <RelatedResourceCards
                items={(detail.related ?? []).filter((item) => item.role === "instance")}
                accountId={account.id}
                pluginId={account.pluginId}
                regionId={regionId}
                onSelect={selectResource}
                t={t}
              />
            </div>
          ) : null}
          {(detail.children ?? []).some((row) =>
            ["listener", "backend", "account", "parameter", "database"].includes(row.kind ?? ""),
          ) ? (
            <CloudChildTable
              rows={detail.children ?? []}
              kinds={["listener", "backend", "account", "parameter", "database"]}
              busy={busy}
              onStart={(row) => invoke("start", { port: row.fields?.port ?? "" })}
              onStop={(row) => invoke("stop", { port: row.fields?.port ?? "" })}
            />
          ) : null}
          {!(detail.related ?? []).some((item) => item.role === "instance") &&
          !(detail.children ?? []).some((row) =>
            ["listener", "backend", "account", "parameter", "database"].includes(row.kind ?? ""),
          ) ? (
            <p className="form-hint">{t("cloud.children.empty")}</p>
          ) : null}
        </>
      ) : null}

      {slot === "backups" ? (
        <>
          {capability === "compute" || capability === "compute.lite" || relatedDisks.length > 0 ? (
            <div className="cloud-related cloud-panel-card">
              <h3 className="cloud-panel-card__title">{t("cloud.detail.disks")}</h3>
              <RelatedResourceCards
                items={relatedDisks}
                accountId={account.id}
                pluginId={account.pluginId}
                regionId={regionId}
                onSelect={selectResource}
                t={t}
              />
              {relatedDisks.length === 0 ? (
                <p className="form-hint">{t("cloud.detail.noDisks")}</p>
              ) : null}
              {capabilityHasDeclaredAction(cap?.actions, "createSnapshot") &&
              capability !== "storage.disk" &&
              relatedDisks.length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setActionDialog("createInstanceSnapshot")}
                >
                  {t("cloud.actions.createSnapshot")}
                </Button>
              ) : null}
            </div>
          ) : null}
          <CloudChildTable rows={detail.children ?? []} kinds={["backup", "snapshot"]} busy={busy} />
        </>
      ) : null}
      </div>

      <FormDialog
        open={actionDialog === "attachInstance"}
        onClose={() => setActionDialog(null)}
        title={t("cloud.actions.attach")}
        size="sm"
        cancelDisabled={busy}
        primaryAction={{
          label: t("cloud.actions.attach"),
          disabled: busy || !bindInstanceId.trim(),
          onClick: () => void invoke("attach", { instanceId: bindInstanceId.trim() }),
        }}
      >
        <FormField label={t("cloud.columns.instanceId")}>
          <TextInput value={bindInstanceId} onChange={setBindInstanceId} copyable={false} />
        </FormField>
      </FormDialog>

      <FormDialog
        open={actionDialog === "modifyBandwidth"}
        onClose={() => setActionDialog(null)}
        title={t("cloud.actions.modifyBandwidth")}
        size="sm"
        cancelDisabled={busy}
        primaryAction={{
          label: t("common.save"),
          disabled: busy || !bandwidth.trim(),
          onClick: () => void invoke("modifyBandwidth", { bandwidth: bandwidth.trim() }),
        }}
      >
        <FormField label={t("cloud.columns.bandwidth")}>
          <TextInput value={bandwidth} onChange={setBandwidth} copyable={false} />
        </FormField>
      </FormDialog>

      <FormDialog
        open={actionDialog === "createSnapshot"}
        onClose={() => setActionDialog(null)}
        title={t("cloud.actions.createSnapshot")}
        size="sm"
        cancelDisabled={busy}
        primaryAction={{
          label: t("cloud.actions.createSnapshot"),
          disabled: busy,
          onClick: () => void invoke("createSnapshot", snapshotName.trim() ? { name: snapshotName.trim() } : {}),
        }}
      >
        <FormField label={t("cloud.columns.name")}>
          <TextInput value={snapshotName} onChange={setSnapshotName} copyable={false} />
        </FormField>
      </FormDialog>

      <FormDialog
        open={actionDialog === "bindSecurityGroup"}
        onClose={() => setActionDialog(null)}
        title={t("cloud.capability.networkSecurityGroup")}
        size="sm"
        cancelDisabled={busy}
        actions={[
          {
            label: t("cloud.actions.detach"),
            variant: "secondary",
            disabled: busy || !securityGroupId.trim(),
            onClick: () => void invoke("detach", { securityGroupId: securityGroupId.trim() }),
          },
        ]}
        primaryAction={{
          label: t("cloud.actions.attach"),
          disabled: busy || !securityGroupId.trim(),
          onClick: () => void invoke("attach", { securityGroupId: securityGroupId.trim() }),
        }}
      >
        <FormField label={t("cloud.capability.networkSecurityGroup")}>
          <TextInput value={securityGroupId} onChange={setSecurityGroupId} copyable={false} />
        </FormField>
      </FormDialog>

      <FormDialog
        open={actionDialog === "createInstanceSnapshot"}
        onClose={() => setActionDialog(null)}
        title={t("cloud.actions.createSnapshot")}
        size="sm"
        cancelDisabled={busy}
        primaryAction={{
          label: t("cloud.actions.createSnapshot"),
          disabled: busy || !snapshotDiskId,
          onClick: () =>
            void invoke("createSnapshot", {
              diskId: snapshotDiskId,
              instanceId: detail.id,
              ...(snapshotName.trim() ? { name: snapshotName.trim() } : {}),
            }),
        }}
      >
        <FormField label={t("cloud.capability.storageDisk")}>
          <Select
            value={snapshotDiskId}
            onChange={setSnapshotDiskId}
            options={relatedDisks.map((item) => ({
              value: item.resourceId,
              label: item.name || item.resourceId,
            }))}
          />
        </FormField>
        <FormField label={t("cloud.columns.name")}>
          <TextInput value={snapshotName} onChange={setSnapshotName} copyable={false} />
        </FormField>
      </FormDialog>
    </div>
  );
}
