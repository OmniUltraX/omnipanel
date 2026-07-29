import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import {
  fetchDeviceIdentity,
  fetchDevices,
  isAuthSessionError,
  type AuthDevice,
} from "../../lib/auth/loginApi";
import { useAuthStore } from "../../stores/authStore";
import { showToast } from "../../stores/toastStore";
import { Button } from "../ui/Button";
import { IconMonitor } from "../ui/icons/Icons";
import {
  emptyImportSelection,
  importFromDevice,
  peekDeviceSync,
  selectionCount,
  type ClientSyncImportSelection,
  type ClientSyncPeekResult,
} from "../../modules/clientSync/importFromDevice";
import type { ClientSyncPeekItem } from "../../ipc/bindings";

type SyncTab =
  | "connections"
  | "databases"
  | "knowledge"
  | "http"
  | "conversations"
  | "workspaces";

function normalizeRole(role: string | undefined): "client" | "assistant" {
  return role?.trim().toLowerCase() === "assistant" ? "assistant" : "client";
}

function formatOsLabel(osType: string, t: (key: string) => string): string {
  const normalized = osType.trim().toLowerCase();
  if (normalized === "windows" || normalized.includes("win")) {
    return t("userCenter.devices.os.windows");
  }
  if (normalized === "macos" || normalized === "darwin" || normalized.includes("mac")) {
    return t("userCenter.devices.os.macos");
  }
  if (normalized === "linux") {
    return t("userCenter.devices.os.linux");
  }
  return osType.trim() || t("userCenter.devices.os.unknown");
}

function toggleId(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

function PeekChecklist({
  items,
  selected,
  onToggle,
  onSelectAll,
  emptyText,
}: {
  items: ClientSyncPeekItem[];
  selected: string[];
  onToggle: (id: string) => void;
  onSelectAll: (ids: string[]) => void;
  emptyText: string;
}) {
  const { t } = useI18n();
  const allIds = items.map((i) => i.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.includes(id));

  if (items.length === 0) {
    return <p className="data-sync-empty">{emptyText}</p>;
  }

  return (
    <div className="data-sync-checklist">
      <div className="data-sync-checklist__toolbar">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onSelectAll(allSelected ? [] : allIds)}
        >
          {allSelected ? t("dataSync.deselectAll") : t("dataSync.selectAll")}
        </Button>
        <span className="data-sync-checklist__count">
          {t("dataSync.selectedCount", { n: selected.length, total: items.length })}
        </span>
      </div>
      <ul className="data-sync-checklist__list">
        {items.map((item) => {
          const checked = selected.includes(item.id);
          return (
            <li key={item.id}>
              <label className={`data-sync-check-item${checked ? " is-checked" : ""}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(item.id)}
                />
                <span className="data-sync-check-item__body">
                  <span className="data-sync-check-item__label">{item.label}</span>
                  {item.detail ? (
                    <span className="data-sync-check-item__detail">{item.detail}</span>
                  ) : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function DataSyncPanel() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);

  const [loadingDevices, setLoadingDevices] = useState(true);
  const [devices, setDevices] = useState<AuthDevice[]>([]);
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  const [peekLoading, setPeekLoading] = useState(false);
  const [peekError, setPeekError] = useState<string | null>(null);
  const [peek, setPeek] = useState<ClientSyncPeekResult | null>(null);
  const [selection, setSelection] = useState<ClientSyncImportSelection>(emptyImportSelection);
  const [tab, setTab] = useState<SyncTab>("connections");
  const [importing, setImporting] = useState(false);

  const remoteClients = useMemo(
    () =>
      devices.filter(
        (d) =>
          normalizeRole(d.role) === "client" &&
          d.deviceId &&
          d.deviceId !== localDeviceId,
      ),
    [devices, localDeviceId],
  );

  const loadDevices = useCallback(async () => {
    if (!token) {
      setLoadingDevices(false);
      setDeviceError(t("dataSync.needLogin"));
      return;
    }
    setLoadingDevices(true);
    setDeviceError(null);
    try {
      const [identity, list] = await Promise.all([
        fetchDeviceIdentity(),
        fetchDevices(token, { quiet: true }),
      ]);
      setLocalDeviceId(identity.deviceId);
      setDevices(list);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDevices([]);
      setDeviceError(message);
      if (isAuthSessionError(error)) {
        showToast(t("userCenter.devices.sessionExpired"));
      }
    } finally {
      setLoadingDevices(false);
    }
  }, [t, token]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  useEffect(() => {
    if (!selectedDeviceId || !token) {
      setPeek(null);
      setPeekError(null);
      setSelection(emptyImportSelection());
      return;
    }
    const abort = new AbortController();
    setPeekLoading(true);
    setPeekError(null);
    setPeek(null);
    setSelection(emptyImportSelection());
    void (async () => {
      try {
        const result = await peekDeviceSync(selectedDeviceId);
        if (abort.signal.aborted) return;
        setPeek(result);
      } catch (error) {
        if (abort.signal.aborted) return;
        setPeekError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!abort.signal.aborted) setPeekLoading(false);
      }
    })();
    return () => abort.abort();
  }, [selectedDeviceId, token]);

  const tabs: { id: SyncTab; label: string; count: number }[] = [
    {
      id: "connections",
      label: t("dataSync.tabs.connections"),
      count: peek?.connections.length ?? 0,
    },
    {
      id: "databases",
      label: t("dataSync.tabs.databases"),
      count: peek?.databases.length ?? 0,
    },
    {
      id: "knowledge",
      label: t("dataSync.tabs.knowledge"),
      count: peek?.knowledge.length ?? 0,
    },
    {
      id: "http",
      label: t("dataSync.tabs.http"),
      count: (peek?.httpRequests.length ?? 0) + (peek?.httpCollections.length ?? 0),
    },
    {
      id: "conversations",
      label: t("dataSync.tabs.conversations"),
      count: peek?.conversations.length ?? 0,
    },
    {
      id: "workspaces",
      label: t("dataSync.tabs.workspaces"),
      count: peek?.workspaces.length ?? 0,
    },
  ];

  const handleImport = async () => {
    if (!selectedDeviceId || selectionCount(selection) === 0 || importing) return;
    setImporting(true);
    try {
      const result = await importFromDevice(selectedDeviceId, selection);
      let conversationN = 0;
      if (result.conversationsJson?.trim()) {
        try {
          const arr = JSON.parse(result.conversationsJson) as unknown[];
          conversationN = Array.isArray(arr) ? arr.length : 0;
        } catch {
          conversationN = 0;
        }
      }
      const total =
        result.appliedConnections +
        result.appliedDatabases +
        result.appliedKnowledge +
        result.appliedHttpRequests +
        result.appliedWorkspaces +
        conversationN;
      showToast(t("dataSync.importSuccess", { n: Math.round(total) }));
      setSelection(emptyImportSelection());
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("dataSync.importFailed"));
    } finally {
      setImporting(false);
    }
  };

  const selectedCount = selectionCount(selection);

  return (
    <div className="data-sync-panel">
      <aside className="data-sync-sidebar">
        <div className="data-sync-sidebar__header">
          <h3 className="data-sync-sidebar__title">{t("dataSync.devicesTitle")}</h3>
          <Button type="button" variant="ghost" size="sm" onClick={() => void loadDevices()}>
            {t("dataSync.refresh")}
          </Button>
        </div>
        <p className="data-sync-sidebar__desc">{t("dataSync.devicesDesc")}</p>

        {loadingDevices ? (
          <p className="data-sync-empty">{t("dataSync.loadingDevices")}</p>
        ) : deviceError ? (
          <p className="data-sync-error">{deviceError}</p>
        ) : remoteClients.length === 0 ? (
          <p className="data-sync-empty">{t("dataSync.noDevices")}</p>
        ) : (
          <ul className="data-sync-device-list">
            {remoteClients.map((device) => {
              const active = device.deviceId === selectedDeviceId;
              const name =
                device.deviceName.trim() || device.deviceId || t("userCenter.devices.unnamed");
              return (
                <li key={device.deviceId}>
                  <button
                    type="button"
                    className={`data-sync-device-item${active ? " is-active" : ""}`}
                    onClick={() => setSelectedDeviceId(device.deviceId)}
                  >
                    <span className="data-sync-device-item__icon" aria-hidden>
                      <IconMonitor size={16} />
                    </span>
                    <span className="data-sync-device-item__body">
                      <span className="data-sync-device-item__name">{name}</span>
                      <span className="data-sync-device-item__meta">
                        {formatOsLabel(device.osType, t)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <section className="data-sync-main">
        {!selectedDeviceId ? (
          <div className="data-sync-main__placeholder">
            <p>{t("dataSync.selectDeviceHint")}</p>
          </div>
        ) : peekLoading ? (
          <div className="data-sync-main__placeholder">
            <p>{t("dataSync.loadingPeek")}</p>
          </div>
        ) : peekError ? (
          <div className="data-sync-main__placeholder">
            <p className="data-sync-error">{peekError}</p>
          </div>
        ) : !peek || (!peek.modulesFound && !peek.conversationsFound) ? (
          <div className="data-sync-main__placeholder">
            <p>{t("dataSync.noSnapshot")}</p>
          </div>
        ) : (
          <>
            <div className="data-sync-tabs" role="tablist">
              {tabs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  className={`data-sync-tab${tab === item.id ? " is-active" : ""}`}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                  <span className="data-sync-tab__count">{item.count}</span>
                </button>
              ))}
            </div>

            <div className="data-sync-tab-panel" role="tabpanel">
              {tab === "connections" ? (
                <PeekChecklist
                  items={peek.connections}
                  selected={selection.connectionIds}
                  onToggle={(id) =>
                    setSelection((s) => ({
                      ...s,
                      connectionIds: toggleId(s.connectionIds, id),
                    }))
                  }
                  onSelectAll={(ids) => setSelection((s) => ({ ...s, connectionIds: ids }))}
                  emptyText={t("dataSync.empty.connections")}
                />
              ) : null}
              {tab === "databases" ? (
                <PeekChecklist
                  items={peek.databases}
                  selected={selection.databaseIds}
                  onToggle={(id) =>
                    setSelection((s) => ({
                      ...s,
                      databaseIds: toggleId(s.databaseIds, id),
                    }))
                  }
                  onSelectAll={(ids) => setSelection((s) => ({ ...s, databaseIds: ids }))}
                  emptyText={t("dataSync.empty.databases")}
                />
              ) : null}
              {tab === "knowledge" ? (
                <PeekChecklist
                  items={peek.knowledge}
                  selected={selection.knowledgeIds}
                  onToggle={(id) =>
                    setSelection((s) => ({
                      ...s,
                      knowledgeIds: toggleId(s.knowledgeIds, id),
                    }))
                  }
                  onSelectAll={(ids) => setSelection((s) => ({ ...s, knowledgeIds: ids }))}
                  emptyText={t("dataSync.empty.knowledge")}
                />
              ) : null}
              {tab === "http" ? (
                <div className="data-sync-http-groups">
                  <h4 className="data-sync-group-title">{t("dataSync.httpCollections")}</h4>
                  <PeekChecklist
                    items={peek.httpCollections}
                    selected={selection.httpCollectionIds}
                    onToggle={(id) =>
                      setSelection((s) => ({
                        ...s,
                        httpCollectionIds: toggleId(s.httpCollectionIds, id),
                      }))
                    }
                    onSelectAll={(ids) =>
                      setSelection((s) => ({ ...s, httpCollectionIds: ids }))
                    }
                    emptyText={t("dataSync.empty.httpCollections")}
                  />
                  <h4 className="data-sync-group-title">{t("dataSync.httpRequests")}</h4>
                  <PeekChecklist
                    items={peek.httpRequests}
                    selected={selection.httpRequestIds}
                    onToggle={(id) =>
                      setSelection((s) => ({
                        ...s,
                        httpRequestIds: toggleId(s.httpRequestIds, id),
                      }))
                    }
                    onSelectAll={(ids) => setSelection((s) => ({ ...s, httpRequestIds: ids }))}
                    emptyText={t("dataSync.empty.httpRequests")}
                  />
                </div>
              ) : null}
              {tab === "conversations" ? (
                <PeekChecklist
                  items={peek.conversations}
                  selected={selection.conversationIds}
                  onToggle={(id) =>
                    setSelection((s) => ({
                      ...s,
                      conversationIds: toggleId(s.conversationIds, id),
                    }))
                  }
                  onSelectAll={(ids) => setSelection((s) => ({ ...s, conversationIds: ids }))}
                  emptyText={t("dataSync.empty.conversations")}
                />
              ) : null}
              {tab === "workspaces" ? (
                <PeekChecklist
                  items={peek.workspaces}
                  selected={selection.workspaceIds}
                  onToggle={(id) =>
                    setSelection((s) => ({
                      ...s,
                      workspaceIds: toggleId(s.workspaceIds, id),
                    }))
                  }
                  onSelectAll={(ids) => setSelection((s) => ({ ...s, workspaceIds: ids }))}
                  emptyText={t("dataSync.empty.workspaces")}
                />
              ) : null}
            </div>

            <div className="data-sync-footer">
              <span className="data-sync-footer__hint">
                {t("dataSync.footerHint", { n: selectedCount })}
              </span>
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={selectedCount === 0 || importing}
                onClick={() => void handleImport()}
              >
                {importing ? t("dataSync.importing") : t("dataSync.import")}
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
