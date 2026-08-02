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
import { IconChevronDown, IconFolder, IconMonitor } from "../ui/icons/Icons";
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

type TreeNode = {
  item: ClientSyncPeekItem;
  children: TreeNode[];
};

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

function formatUpdatedAt(value: number, locale: string): string {
  if (!value || value <= 0) return "—";
  const ms = value < 1e12 ? value * 1000 : value;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(locale);
}

function isFolder(item: ClientSyncPeekItem): boolean {
  return item.kind === "folder";
}

/** 连接分组虚拟节点不可导入，仅用于折叠展示。 */
function isSelectableItem(item: ClientSyncPeekItem): boolean {
  return !item.id.startsWith("__group__:");
}

function normalizeParentId(parentId: string | null | undefined): string {
  return parentId?.trim() ?? "";
}

function buildTree(items: ClientSyncPeekItem[]): TreeNode[] {
  const byParent = new Map<string, ClientSyncPeekItem[]>();
  for (const item of items) {
    const parent = normalizeParentId(item.parentId);
    const list = byParent.get(parent) ?? [];
    list.push(item);
    byParent.set(parent, list);
  }

  const sortItems = (list: ClientSyncPeekItem[]) =>
    [...list].sort((a, b) => {
      const folderFirst = Number(isFolder(b)) - Number(isFolder(a));
      if (folderFirst !== 0) return folderFirst;
      return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    });

  const build = (parentId: string): TreeNode[] =>
    sortItems(byParent.get(parentId) ?? []).map((item) => ({
      item,
      children: isFolder(item) ? build(item.id) : [],
    }));

  // 父节点缺失时提升到根，避免孤儿不可见
  const ids = new Set(items.map((i) => i.id));
  const roots = build("");
  const orphanParents = [...byParent.keys()].filter((p) => p && !ids.has(p));
  for (const parent of orphanParents) {
    roots.push(...build(parent));
  }
  return roots;
}

function collectSubtreeIds(node: TreeNode): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    if (isSelectableItem(n.item)) out.push(n.item.id);
    for (const child of n.children) walk(child);
  };
  walk(node);
  return out;
}

function flattenVisible(
  nodes: TreeNode[],
  collapsed: Set<string>,
  depth = 0,
): Array<{ node: TreeNode; depth: number }> {
  const rows: Array<{ node: TreeNode; depth: number }> = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.children.length > 0 && !collapsed.has(node.item.id)) {
      rows.push(...flattenVisible(node.children, collapsed, depth + 1));
    }
  }
  return rows;
}

function PeekTreeTable({
  items,
  selected,
  onChangeSelected,
  emptyText,
  locale,
}: {
  items: ClientSyncPeekItem[];
  selected: string[];
  onChangeSelected: (ids: string[]) => void;
  emptyText: string;
  locale: string;
}) {
  const { t } = useI18n();
  const normalizedItems = useMemo(
    () =>
      items.map((item) => ({
        ...item,
        parentId: item.parentId ?? "",
        kind: item.kind || "item",
        detail: item.detail ?? "",
      })),
    [items],
  );
  const tree = useMemo(() => buildTree(normalizedItems), [normalizedItems]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // 切换设备/数据后：默认展开全部文件夹
  useEffect(() => {
    setCollapsed(new Set());
  }, [normalizedItems]);

  const selectableIds = useMemo(
    () => normalizedItems.filter(isSelectableItem).map((i) => i.id),
    [normalizedItems],
  );
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allSelected =
    selectableIds.length > 0 && selectableIds.every((id) => selectedSet.has(id));
  const someSelected = selectableIds.some((id) => selectedSet.has(id));
  const rows = useMemo(() => flattenVisible(tree, collapsed), [tree, collapsed]);

  const toggleCollapsed = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setIdsSelected = (ids: string[], checked: boolean) => {
    const next = new Set(selected);
    for (const id of ids) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    onChangeSelected([...next]);
  };

  const toggleNode = (node: TreeNode) => {
    const ids = collectSubtreeIds(node);
    if (ids.length === 0) return;
    const allOn = ids.every((id) => selectedSet.has(id));
    setIdsSelected(ids, !allOn);
  };

  if (normalizedItems.length === 0) {
    return <p className="data-sync-empty">{emptyText}</p>;
  }

  return (
    <div className="data-sync-table-wrap data-sync-table-wrap--tab">
      <table className="data-sync-table">
        <thead>
          <tr>
            <th className="data-sync-table__check">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected && !allSelected;
                }}
                onChange={() =>
                  onChangeSelected(allSelected ? [] : [...selectableIds])
                }
                aria-label={allSelected ? t("dataSync.deselectAll") : t("dataSync.selectAll")}
              />
            </th>
            <th>{t("dataSync.columns.name")}</th>
            <th>{t("dataSync.columns.detail")}</th>
            <th className="data-sync-table__time">{t("dataSync.columns.updatedAt")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ node, depth }) => {
            const { item, children } = node;
            const hasChildren = children.length > 0;
            const folder = isFolder(item);
            const subtreeIds = collectSubtreeIds(node);
            const checked =
              subtreeIds.length > 0 && subtreeIds.every((id) => selectedSet.has(id));
            const indeterminate =
              !checked && subtreeIds.some((id) => selectedSet.has(id));
            const isCollapsed = collapsed.has(item.id);

            return (
              <tr
                key={item.id}
                className={[
                  checked ? "is-checked" : "",
                  folder ? "is-folder" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <td className="data-sync-table__check">
                  <input
                    type="checkbox"
                    checked={checked}
                    ref={(el) => {
                      if (el) el.indeterminate = indeterminate;
                    }}
                    disabled={subtreeIds.length === 0}
                    onChange={() => toggleNode(node)}
                    aria-label={item.label}
                  />
                </td>
                <td className="data-sync-table__name">
                  <div
                    className="data-sync-tree-cell"
                    style={{ paddingLeft: depth * 16 }}
                  >
                    {hasChildren ? (
                      <button
                        type="button"
                        className={`data-sync-tree-toggle${isCollapsed ? "" : " is-open"}`}
                        aria-expanded={!isCollapsed}
                        onClick={() => toggleCollapsed(item.id)}
                      >
                        <IconChevronDown size={12} />
                      </button>
                    ) : (
                      <span className="data-sync-tree-toggle-spacer" />
                    )}
                    {folder ? (
                      <IconFolder size={13} className="data-sync-tree-folder-icon" />
                    ) : null}
                    <span title={item.label}>{item.label}</span>
                  </div>
                </td>
                <td className="data-sync-table__detail" title={item.detail || undefined}>
                  {item.detail || "—"}
                </td>
                <td className="data-sync-table__time">
                  {formatUpdatedAt(item.updatedAt ?? 0, locale)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DataSyncPanel() {
  const { t, locale } = useI18n();
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

  const tabs: { id: SyncTab; label: string; count: number }[] = useMemo(() => {
    if (!peek) {
      return [
        { id: "connections", label: t("dataSync.tabs.connections"), count: 0 },
        { id: "databases", label: t("dataSync.tabs.databases"), count: 0 },
        { id: "knowledge", label: t("dataSync.tabs.knowledge"), count: 0 },
        { id: "http", label: t("dataSync.tabs.http"), count: 0 },
        { id: "conversations", label: t("dataSync.tabs.conversations"), count: 0 },
        { id: "workspaces", label: t("dataSync.tabs.workspaces"), count: 0 },
      ];
    }
    return [
      {
        id: "connections",
        label: t("dataSync.tabs.connections"),
        count: peek.connections.filter(isSelectableItem).length,
      },
      {
        id: "databases",
        label: t("dataSync.tabs.databases"),
        count: peek.databases.length,
      },
      {
        id: "knowledge",
        label: t("dataSync.tabs.knowledge"),
        count: peek.knowledge.length,
      },
      {
        id: "http",
        label: t("dataSync.tabs.http"),
        count: peek.httpCollections.length + peek.httpRequests.length,
      },
      {
        id: "conversations",
        label: t("dataSync.tabs.conversations"),
        count: peek.conversations.length,
      },
      {
        id: "workspaces",
        label: t("dataSync.tabs.workspaces"),
        count: peek.workspaces.length,
      },
    ];
  }, [peek, t]);

  const httpItems = useMemo(() => {
    if (!peek) return [];
    return [...peek.httpCollections, ...peek.httpRequests];
  }, [peek]);

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
        (result.appliedConnections ?? 0) +
        (result.appliedDatabases ?? 0) +
        (result.appliedKnowledge ?? 0) +
        (result.appliedHttpRequests ?? 0) +
        (result.appliedWorkspaces ?? 0) +
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

  const setHttpSelection = (ids: string[]) => {
    if (!peek) return;
    const collectionIdSet = new Set(peek.httpCollections.map((c) => c.id));
    const requestIdSet = new Set(peek.httpRequests.map((r) => r.id));
    setSelection((s) => ({
      ...s,
      httpCollectionIds: ids.filter((id) => collectionIdSet.has(id)),
      httpRequestIds: ids.filter((id) => requestIdSet.has(id)),
    }));
  };

  const httpSelected = useMemo(
    () => [...(selection.httpCollectionIds ?? []), ...(selection.httpRequestIds ?? [])],
    [selection.httpCollectionIds, selection.httpRequestIds],
  );

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
                        {" · "}
                        {device.online
                          ? t("userCenter.devices.online")
                          : t("userCenter.devices.offline")}
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
                <PeekTreeTable
                  items={peek.connections}
                  selected={selection.connectionIds ?? []}
                  onChangeSelected={(ids) =>
                    setSelection((s) => ({ ...s, connectionIds: ids }))
                  }
                  emptyText={t("dataSync.empty.connections")}
                  locale={locale}
                />
              ) : null}
              {tab === "databases" ? (
                <PeekTreeTable
                  items={peek.databases}
                  selected={selection.databaseIds ?? []}
                  onChangeSelected={(ids) =>
                    setSelection((s) => ({ ...s, databaseIds: ids }))
                  }
                  emptyText={t("dataSync.empty.databases")}
                  locale={locale}
                />
              ) : null}
              {tab === "knowledge" ? (
                <PeekTreeTable
                  items={peek.knowledge}
                  selected={selection.knowledgeIds ?? []}
                  onChangeSelected={(ids) =>
                    setSelection((s) => ({ ...s, knowledgeIds: ids }))
                  }
                  emptyText={t("dataSync.empty.knowledge")}
                  locale={locale}
                />
              ) : null}
              {tab === "http" ? (
                <PeekTreeTable
                  items={httpItems}
                  selected={httpSelected}
                  onChangeSelected={setHttpSelection}
                  emptyText={t("dataSync.empty.httpRequests")}
                  locale={locale}
                />
              ) : null}
              {tab === "conversations" ? (
                <PeekTreeTable
                  items={peek.conversations}
                  selected={selection.conversationIds ?? []}
                  onChangeSelected={(ids) =>
                    setSelection((s) => ({ ...s, conversationIds: ids }))
                  }
                  emptyText={t("dataSync.empty.conversations")}
                  locale={locale}
                />
              ) : null}
              {tab === "workspaces" ? (
                <PeekTreeTable
                  items={peek.workspaces}
                  selected={selection.workspaceIds ?? []}
                  onChangeSelected={(ids) =>
                    setSelection((s) => ({ ...s, workspaceIds: ids }))
                  }
                  emptyText={t("dataSync.empty.workspaces")}
                  locale={locale}
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
