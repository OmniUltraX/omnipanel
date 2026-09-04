import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { useI18n } from "../../i18n";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { TextInput } from "../../components/ui/form/TextInput";
import {
  DbTablesPanelGrid,
  type DbTablesPanelGridColumn,
} from "../database/workspace/DbTablesPanelGrid";
import { commands, type CloudResourceRow } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { useConnectionStore } from "../../stores/connectionStore";
import { showToast } from "../../stores/toastStore";
import { cloudCapabilityLabel, cloudRegionLabel, formatCloudFieldValue, type CloudAccount } from "./cloudForm";
import { cloudCapabilityById, isGlobalCloudCapability } from "./cloudCapabilities";
import { capabilityHasDeclaredAction } from "./cloudWorkspaceTabs";
import {
  addCloudInstanceToSsh,
  addCloudOssToFile,
  addCloudRdsToDatabase,
  findLinkedOssFileConnection,
  findLinkedSshConnection,
} from "./cloudResourceLinks";
import { cloudRowField, matchesCloudListQuery } from "./cloudResourceApi";
import { cloudListSlotKey } from "./cloudInventory";
import {
  cloudListRefreshKey,
  useCloudInventoryStore,
} from "../../stores/cloudInventoryStore";
import { cloudStatusTone } from "./cloudDetailUi";
import { CloudPager } from "./CloudListPager";
import { useCloudPaging } from "./cloudPaging";

function rowField(row: CloudResourceRow, key: string, t: (key: string) => string): string {
  if (key === "name") return row.name;
  if (key === "status") return formatCloudFieldValue(t, "status", row.status ?? "");
  if (key === "region") return row.regionId ? cloudRegionLabel(row.regionId) : "";
  if (key === "id") return row.id;
  return formatCloudFieldValue(t, key, cloudRowField(row.fields, key));
}

export function CloudResourceListPanel({
  account,
  capability,
  selectedRegions,
  selectedRowId,
  onSelectRow,
  onOpenRow,
}: {
  account: CloudAccount;
  capability: string;
  selectedRegions: string[];
  selectedRowId: string | null;
  onSelectRow: (row: CloudResourceRow) => void;
  onOpenRow: (row: CloudResourceRow) => void;
}) {
  const { t } = useI18n();
  const connections = useConnectionStore((s) => s.connections);
  const saveConn = useConnectionStore((s) => s.save);
  const cloudConnection = connections.find((c) => c.id === account.id);
  const cap = cloudCapabilityById(account.pluginId, capability);
  const global = isGlobalCloudCapability(cap);
  const queryRegions = global ? [] : selectedRegions;
  const listSlot = cloudListSlotKey(capability, queryRegions);
  const listRefreshKey = cloudListRefreshKey(account.id, capability, queryRegions);
  const listEntry = useCloudInventoryStore((s) => s.byAccount[account.id]?.lists[listSlot]);
  const refreshing = useCloudInventoryStore((s) => Boolean(s.refreshingKeys[listRefreshKey]));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const rows = listEntry?.rows ?? [];
  const visibleRows = useMemo(
    () => rows.filter((row) => matchesCloudListQuery(row, query)),
    [query, rows],
  );
  const paging = useCloudPaging(visibleRows, `${account.id}:${capability}:${query}`);
  const loading = refreshing && !listEntry;

  const reload = useCallback(
    async (force = false) => {
      const cached = Boolean(
        useCloudInventoryStore.getState().byAccount[account.id]?.lists[listSlot],
      );
      try {
        await useCloudInventoryStore.getState().ensureList(account.id, capability, queryRegions, {
          force,
          quiet: !force && cached,
        });
      } catch (err) {
        if (force || !cached) showToast(formatIpcError(err));
      }
    },
    [account.id, capability, listSlot, queryRegions],
  );

  useEffect(() => {
    void reload(false);
  }, [reload]);

  useEffect(() => {
    setQuery("");
  }, [account.id, capability]);

  const invokePluginAction = useCallback(
    async (row: CloudResourceRow, action: string) => {
      const { ACTION_CLOUD_LIFECYCLE, pipeTarget } = await import("../../lib/presenceTargets");
      const { requireStepUp } = await import("../../lib/stepUp");
      const token = await requireStepUp({
        action: ACTION_CLOUD_LIFECYCLE,
        target: pipeTarget(account.id, row.id, action),
        title: t(`cloud.actions.${action}`),
        message: t("cloud.actions.confirmProd", { action: t(`cloud.actions.${action}`) }),
        reason: action,
      });
      if (!token) return;
      setBusyId(row.id);
      try {
        await unwrapCommand(
          commands.cloudInvokeAction(account.id, {
            name: action,
            resourceId: row.id,
            capability,
            regionId: row.regionId,
            presenceToken: token,
          }),
        );
        showToast(t("cloud.actions.submitted", { action: t(`cloud.actions.${action}`) }));
        await reload(true);
      } catch (err) {
        showToast(formatIpcError(err));
      } finally {
        setBusyId(null);
      }
    },
    [account.envTag, account.id, capability, reload, t],
  );

  const columns = useMemo((): DbTablesPanelGridColumn<CloudResourceRow>[] => {
    const declared = cap?.columns?.length ? cap.columns : [{ key: "name" }, { key: "status" }, { key: "region" }];
    const cols: DbTablesPanelGridColumn<CloudResourceRow>[] = declared.map((col) => ({
      id: col.key,
      header: t(`cloud.columns.${col.key}`),
      nameCell: col.key === "name",
      defaultWidth: col.key === "name" ? 200 : col.key === "region" ? 180 : 140,
      minWidth: 80,
      render: (row) => {
        if (col.key === "status") {
          const raw = row.status ?? "";
          const label = rowField(row, "status", t);
          if (!label) return "—";
          return <span className={`cloud-pill cloud-pill--${cloudStatusTone(raw)}`}>{label}</span>;
        }
        return rowField(row, col.key, t) || "—";
      },
      getTitle: (row) => rowField(row, col.key, t) || undefined,
    }));
    cols.push({
      id: "actions",
      header: t("server.cloud.columns.actions"),
      variant: "actionsSticky",
      defaultWidth: 220,
      minWidth: 160,
      resizable: false,
      copyable: false,
      render: (row) => {
        const sshLinked = findLinkedSshConnection(
          connections,
          account.id,
          capability,
          row.id,
          cloudRowField(row.fields, "publicIp"),
          cloudRowField(row.fields, "privateIp"),
        );
        const ossLinked = findLinkedOssFileConnection(connections, account.id, row.id);
        return (
          <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
            {capabilityHasDeclaredAction(cap?.actions, "start") ? (
              <WorkbenchActionButton disabled={busyId === row.id} onClick={(e) => { e.stopPropagation(); void invokePluginAction(row, "start"); }}>
                {t("cloud.actions.start")}
              </WorkbenchActionButton>
            ) : null}
            {capabilityHasDeclaredAction(cap?.actions, "stop") ? (
              <WorkbenchActionButton disabled={busyId === row.id} onClick={(e) => { e.stopPropagation(); void invokePluginAction(row, "stop"); }}>
                {t("cloud.actions.stop")}
              </WorkbenchActionButton>
            ) : null}
            {capabilityHasDeclaredAction(cap?.actions, "reboot") ? (
              <WorkbenchActionButton disabled={busyId === row.id} onClick={(e) => { e.stopPropagation(); void invokePluginAction(row, "reboot"); }}>
                {t("cloud.actions.reboot")}
              </WorkbenchActionButton>
            ) : null}
            {capabilityHasDeclaredAction(cap?.actions, "addSsh") ? (
              <WorkbenchActionButton
                disabled={Boolean(sshLinked) || busyId === row.id}
                onClick={(e) => {
                  e.stopPropagation();
                  void (async () => {
                    try {
                      await addCloudInstanceToSsh(
                        account,
                        capability,
                        {
                          id: row.id,
                          name: row.name,
                          publicIp: cloudRowField(row.fields, "publicIp"),
                          privateIp: cloudRowField(row.fields, "privateIp"),
                        },
                        saveConn,
                      );
                      showToast(t("server.cloud.actions.addedSsh", { name: row.name || row.id }));
                    } catch (err) {
                      if (String(err).includes("NO_HOST")) showToast(t("server.cloud.actions.noHost"));
                      else showToast(formatIpcError(err));
                    }
                  })();
                }}
              >
                {sshLinked ? t("server.cloud.actions.alreadySsh") : t("server.cloud.actions.addSsh")}
              </WorkbenchActionButton>
            ) : null}
            {capabilityHasDeclaredAction(cap?.actions, "addToFiles") && cloudConnection ? (
              <WorkbenchActionButton
                disabled={Boolean(ossLinked) || busyId === row.id}
                onClick={(e) => {
                  e.stopPropagation();
                  void (async () => {
                    try {
                      await addCloudOssToFile(account, cloudConnection, {
                        id: row.id,
                        name: row.name,
                        region: row.regionId,
                        endpoint: cloudRowField(row.fields, "endpoint"),
                      });
                      showToast(t("server.cloud.actions.addedOss", { name: row.name || row.id }));
                    } catch (err) {
                      showToast(formatIpcError(err));
                    }
                  })();
                }}
              >
                {ossLinked ? t("server.cloud.actions.alreadyOss") : t("server.cloud.actions.addOss")}
              </WorkbenchActionButton>
            ) : null}
            {capabilityHasDeclaredAction(cap?.actions, "addToDatabase") ? (
              <WorkbenchActionButton
                disabled={busyId === row.id}
                onClick={(e) => {
                  e.stopPropagation();
                  void (async () => {
                    try {
                      await addCloudRdsToDatabase(account, {
                        id: row.id,
                        name: row.name,
                        engine: cloudRowField(row.fields, "engine"),
                        host: cloudRowField(row.fields, "connectionString"),
                        port: cloudRowField(row.fields, "port"),
                      });
                      showToast(t("cloud.actions.addedDb", { name: row.name || row.id }));
                    } catch (err) {
                      if (String(err).includes("NO_HOST")) showToast(t("server.cloud.actions.noHost"));
                      else showToast(formatIpcError(err));
                    }
                  })();
                }}
              >
                {t("cloud.actions.addToDatabase")}
              </WorkbenchActionButton>
            ) : null}
          </span>
        );
      },
    });
    return cols;
  }, [account, busyId, cap, capability, cloudConnection, connections, invokePluginAction, saveConn, t]);

  return (
    <div className="cloud-resource-list">
      <header className="db-tables-panel-header db-connection-info-header">
        <span className="db-tables-panel-header-label">{cloudCapabilityLabel(t, capability, account.pluginId)}</span>
        <div className="db-tables-panel-header-tags">
          <span className="db-tables-panel-header-tag">{account.name}</span>
          <span className="db-tables-panel-header-tag">
            {loading
              ? "…"
              : query.trim()
                ? t("cloud.list.filtered", { shown: String(visibleRows.length), total: String(rows.length) })
                : t("cloud.list.count", { count: String(rows.length) })}
          </span>
          {refreshing && listEntry ? (
            <span className="db-tables-panel-header-tag">{t("cloud.list.syncing")}</span>
          ) : null}
        </div>
        <div className="db-tables-panel-header-actions">
          <TextInput
            className="cloud-resource-list__search"
            value={query}
            onChange={setQuery}
            placeholder={t("cloud.list.search")}
            clearable
            copyable={false}
            size="sm"
          />
          <WorkbenchActionButton disabled={refreshing} onClick={() => void reload(true)}>
            {refreshing ? t("server.refreshing") : t("server.refresh")}
          </WorkbenchActionButton>
        </div>
      </header>
      {listEntry?.error ? (
        <p className="form-hint cloud-resource-list__error">{t("cloud.list.failed", { error: listEntry.error })}</p>
      ) : null}
      {visibleRows.length === 0 && !loading ? (
        <div className="cloud-resource-list__empty">
          <p>{t("cloud.list.empty")}</p>
          <p className="form-hint">{t("cloud.list.emptyHint")}</p>
        </div>
      ) : (
        <div className="cloud-resource-list__body">
          <DbTablesPanelGrid
            columns={columns}
            rows={paging.slice}
            rowKey={(row) => row.id}
            selectedRowKey={selectedRowId}
            onRowClick={(row: CloudResourceRow, _event: MouseEvent) => onSelectRow(row)}
            onRowDoubleClick={(row: CloudResourceRow) => onOpenRow(row)}
            virtualizeRows
          />
          <CloudPager
            page={paging.page}
            pageSize={paging.pageSize}
            total={paging.total}
            totalPages={paging.totalPages}
            from={paging.from}
            to={paging.to}
            disabled={refreshing}
            onPageChange={paging.setPage}
            onPageSizeChange={paging.setPageSize}
          />
        </div>
      )}
    </div>
  );
}
