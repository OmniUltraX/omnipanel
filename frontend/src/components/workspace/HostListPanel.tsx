import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { parseResourceTag } from "../../lib/resourceTags";
import { type WorkspaceResource } from "../../lib/resourceRegistry";
import { Button } from "../ui/Button";
import {
  collectSshGroupSuggestions,
  normalizeSshGroup,
  sanitizeSshGroupInput,
  sortSshGroups,
  sshGroupLabel,
} from "../../lib/sshGroups";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import { ScopedSearch } from "../ui/ScopedSearch";
import { ResourceTags } from "../ui/ResourceTags";
import {
  syncFromOpenSshConfig,
  useConnectionStore,
} from "../../stores/connectionStore";
import { HostStatusIndicator } from "../../modules/server/ssh/components/HostStatusIndicator";
import { loadSshPoolStatuses } from "../../stores/sshConnectionStore";
import { useSshHostStore } from "../../stores/sshHostStore";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { WarnAlert } from "../ui/WarnAlert";
import { SshConnectionDialog } from "../../modules/server/ssh/components/SshConnectionDialog";
import {
  findPanelForSsh,
  getLinkedConnectionIds,
  parsePanelConfig,
} from "../../modules/server/panel/serverConnection";
import { SSH_PATH } from "../../modules/server/ssh/constants";
import type { Connection } from "../../ipc/bindings";

const HOST_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <circle cx="6" cy="6" r="1" fill="currentColor" />
  </svg>
);

interface HostListPanelProps {
  resources: WorkspaceResource[];
  onConnect?: (hostId: string) => void;
}

function HostPanelBadge({ sshId }: { sshId: string }) {
  const { t } = useI18n();
  const connections = useConnectionStore((s) => s.connections);
  const panel = findPanelForSsh(connections, sshId);
  if (!panel) return null;
  const serviceType = parsePanelConfig(panel).serviceType;
  const label =
    serviceType === "1panel"
      ? t("server.serviceType.1panel")
      : t("server.serviceType.bt");
  return (
    <span className="host-panel-badge" title={t("server.hostList.panelConfigured")}>
      {label}
    </span>
  );
}

function HostResourceTags({ resourceId }: { resourceId: string }) {
  const tags = useConnectionStore(
    (s) => s.connections.find((c) => c.id === resourceId)?.tags,
  );
  return <ResourceTags tags={tags} keys={["os"]} variant="compact" />;
}

function HostMonitoringBadge({ resourceId }: { resourceId: string }) {
  const { t } = useI18n();
  const enabled = useSshHostStore((s) => s.isMonitoring(resourceId));
  if (!enabled) return null;
  return (
    <span className="host-monitoring-badge" title={t("ssh.monitoring.active")}>
      <span className="host-monitoring-dot" aria-hidden />
    </span>
  );
}

type HostGroupSectionProps = {
  groupKey: string;
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  children: React.ReactNode;
};

function HostGroupSection({
  label,
  count,
  expanded,
  onToggle,
  onContextMenu,
  children,
}: HostGroupSectionProps) {
  return (
    <div className={`host-group${expanded ? " host-group--open" : ""}`}>
      <button
        type="button"
        className="host-group-header"
        onClick={onToggle}
        onContextMenu={onContextMenu}
        aria-expanded={expanded}
      >
        <span className={`host-group-chevron${expanded ? " host-group-chevron--open" : ""}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </span>
        <span className="host-group-title">{label}</span>
        <span className="badge badge-muted host-group-count">{count}</span>
      </button>
      {expanded && <div className="host-group-body">{children}</div>}
    </div>
  );
}

export function HostListPanel({ resources, onConnect }: HostListPanelProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const selectedResourceByPath = useWorkspaceStore((s) => s.selectedResourceByPath);
  const selectResource = useWorkspaceStore((s) => s.selectResource);
  const setActivePath = useWorkspaceStore((s) => s.setActivePath);
  const connections = useConnectionStore((s) => s.connections);
  const saveConn = useConnectionStore((s) => s.save);
  const moveSshConnectionsToGroup = useConnectionStore((s) => s.moveSshConnectionsToGroup);
  const removeConn = useConnectionStore((s) => s.remove);
  const activeHostId = selectedResourceByPath[SSH_PATH];

  useEffect(() => {
    void loadSshPoolStatuses();
  }, []);

  type HostListCtxMenu =
    | { kind: "host"; x: number; y: number; host: WorkspaceResource }
    | { kind: "group"; x: number; y: number; groupKey: string };

  const [listCtxMenu, setListCtxMenu] = useState<HostListCtxMenu | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [editConnection, setEditConnection] = useState<Connection | undefined>(undefined);
  const [deleting, setDeleting] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState(false);
  const [syncWarnOpen, setSyncWarnOpen] = useState(false);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = resources.filter((r) => {
      if (!q) return true;
      if (r.name.toLowerCase().includes(q)) return true;
      if (r.subtitle.toLowerCase().includes(q)) return true;
      if (normalizeSshGroup(r.group).toLowerCase().includes(q)) return true;
      return (r.tags ?? []).some((tag) => {
        const { key, value } = parseResourceTag(tag);
        return (
          tag.toLowerCase().includes(q) ||
          key.toLowerCase().includes(q) ||
          value.toLowerCase().includes(q)
        );
      });
    });
    const map = new Map<string, WorkspaceResource[]>();
    for (const host of filtered) {
      const key = normalizeSshGroup(host.group);
      const list = map.get(key) ?? [];
      list.push(host);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    }
    return sortSshGroups([...map.keys()]).map((groupKey) => ({
      groupKey,
      label: sshGroupLabel(groupKey, t),
      items: map.get(groupKey) ?? [],
    }));
  }, [resources, query, t]);

  useEffect(() => {
    if (!query.trim()) return;
    setExpandedGroups((prev) => {
      const next = { ...prev };
      for (const g of grouped) {
        next[g.groupKey] = true;
      }
      return next;
    });
  }, [query, grouped]);

  const isGroupExpanded = (groupKey: string) => expandedGroups[groupKey] !== false;

  const toggleGroup = (groupKey: string) => {
    setExpandedGroups((prev) => ({
      ...prev,
      [groupKey]: !isGroupExpanded(groupKey),
    }));
  };

  const selectHost = (resource: WorkspaceResource) => {
    selectResource(resource.id, SSH_PATH);
    setActivePath(SSH_PATH);
    navigate(SSH_PATH);
  };

  const handleContextMenu = (e: React.MouseEvent, host: WorkspaceResource) => {
    e.preventDefault();
    e.stopPropagation();
    setListCtxMenu({ kind: "host", x: e.clientX, y: e.clientY, host });
  };

  const handleGroupContextMenu = (e: React.MouseEvent, groupKey: string) => {
    e.preventDefault();
    e.stopPropagation();
    setListCtxMenu({ kind: "group", x: e.clientX, y: e.clientY, groupKey });
  };

  const sshConnectionsInGroup = (groupKey: string) =>
    connections.filter(
      (c) => c.kind === "ssh" && normalizeSshGroup(c.group) === groupKey,
    );

  const remapExpandedGroupKey = (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    setExpandedGroups((prev) => {
      if (!(fromKey in prev)) return prev;
      const next = { ...prev };
      next[toKey] = prev[fromKey];
      delete next[fromKey];
      return next;
    });
  };

  const performSyncConfig = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await syncFromOpenSshConfig();
    } finally {
      setSyncing(false);
    }
  };

  const handleDelete = async () => {
    if (listCtxMenu?.kind !== "host" || deleting) return;
    const host = listCtxMenu.host;
    setListCtxMenu(null);
    if (!(await appConfirm(t("ssh.dialog.confirmDelete", { name: host.name })))) return;
    setDeleting(true);
    try {
      const ids = getLinkedConnectionIds(connections, host.id);
      for (const id of ids) {
        await removeConn(id);
      }
    } catch { /* ignore */ }
    setDeleting(false);
  };

  const handleEdit = () => {
    if (listCtxMenu?.kind !== "host") return;
    const host = listCtxMenu.host;
    setListCtxMenu(null);
    const conn = connections.find((c) => c.id === host.id);
    if (conn) {
      setEditConnection(conn);
      setShowDialog(true);
    }
  };

  const handleAdd = () => {
    setEditConnection(undefined);
    setShowDialog(true);
  };

  const handleMoveToGroup = async (targetGroup: string) => {
    if (listCtxMenu?.kind !== "host") return;
    const host = listCtxMenu.host;
    const conn = connections.find((c) => c.id === host.id);
    if (!conn) return;
    const group = sanitizeSshGroupInput(targetGroup);
    if (normalizeSshGroup(conn.group) === group) {
      setListCtxMenu(null);
      return;
    }
    setListCtxMenu(null);
    await saveConn({ ...conn, group });
  };

  const handleRenameGroup = () => {
    if (listCtxMenu?.kind !== "group") return;
    const { groupKey } = listCtxMenu;
    setListCtxMenu(null);
    const input = window.prompt(
      t("ssh.context.renameGroupPrompt", { name: sshGroupLabel(groupKey, t) }),
      groupKey,
    );
    if (input == null) return;
    if (!input.trim()) {
      window.alert(t("ssh.context.renameGroupEmpty"));
      return;
    }
    const newKey = sanitizeSshGroupInput(input);
    if (newKey === groupKey) return;
    void (async () => {
      const conns = sshConnectionsInGroup(groupKey);
      for (const conn of conns) {
        await saveConn({ ...conn, group: newKey });
      }
      remapExpandedGroupKey(groupKey, newKey);
    })();
  };

  const handleMoveAllToGroup = async (targetGroup: string) => {
    if (listCtxMenu?.kind !== "group") return;
    const { groupKey } = listCtxMenu;
    const group = sanitizeSshGroupInput(targetGroup);
    if (group === groupKey) {
      setListCtxMenu(null);
      return;
    }
    setListCtxMenu(null);
    const ids = sshConnectionsInGroup(groupKey).map((c) => c.id);
    await moveSshConnectionsToGroup(ids, group);
    remapExpandedGroupKey(groupKey, group);
  };

  const buildMoveTargetChildren = (
    prefix: string,
    targetGroups: string[],
    onPick: (group: string) => void,
  ): ContextMenuItem[] =>
    targetGroups.map((g, index) => ({
      id: `${prefix}-target-${index}-${g}`,
      label: sshGroupLabel(g, t),
      onClick: () => void onPick(g),
    }));

  const buildGroupCtxItems = (groupKey: string): ContextMenuItem[] => {
    const targetGroups = collectSshGroupSuggestions(connections).filter((g) => g !== groupKey);
    const items: ContextMenuItem[] = [
      { id: "group-edit", label: t("ssh.context.editGroup"), onClick: handleRenameGroup },
    ];
    if (targetGroups.length > 0) {
      items.push({
        id: "group-move-all",
        label: t("ssh.context.moveAllTo"),
        children: buildMoveTargetChildren("group-move-all", targetGroups, handleMoveAllToGroup),
      });
    } else {
      items.push({
        id: "group-move-all",
        label: t("ssh.context.moveAllTo"),
        disabled: true,
      });
    }
    return items;
  };

  const buildHostCtxItems = (host: WorkspaceResource): ContextMenuItem[] => {
    const currentGroup = normalizeSshGroup(host.group);
    const targetGroups = collectSshGroupSuggestions(connections).filter((g) => g !== currentGroup);
    const items: ContextMenuItem[] = [
      { id: "host-edit", label: t("ssh.dialog.edit"), onClick: handleEdit },
    ];
    if (targetGroups.length > 0) {
      items.push({
        id: "host-move",
        label: t("ssh.context.moveTo"),
        children: buildMoveTargetChildren("host-move", targetGroups, handleMoveToGroup),
      });
    } else {
      items.push({
        id: "host-move",
        label: t("ssh.context.moveTo"),
        disabled: true,
      });
    }
    items.push({ id: "host-delete", label: t("ssh.dialog.delete"), onClick: handleDelete, danger: true });
    return items;
  };

  const buildListCtxItems = (): ContextMenuItem[] => {
    if (!listCtxMenu) return [];
    if (listCtxMenu.kind === "group") {
      return buildGroupCtxItems(listCtxMenu.groupKey);
    }
    return buildHostCtxItems(listCtxMenu.host);
  };

  return (
    <div className="host-list-panel">
      <div className="host-list-header">
        <h3>{t("ssh.sidebar.title")}</h3>
        <span className="badge badge-muted">{resources.length}</span>
        <div className="host-list-actions">
          <Button
            variant="icon"
            title={t("ssh.sidebar.syncConfig")}
            disabled={syncing}
            onClick={() => setSyncWarnOpen(true)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              width="14"
              height="14"
              className={syncing ? "icon-spin" : undefined}
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </Button>
          <Button variant="icon" title={t("ssh.dialog.addTitle")} onClick={handleAdd}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          </Button>
        </div>
      </div>
      <ScopedSearch value={query} onChange={setQuery} placeholder={t("ssh.sidebar.search")}>
        <div className="host-list">
          {grouped.length === 0 ? (
            <div className="empty-state compact">{t("common.noResources")}</div>
          ) : (
            grouped.map((group) => (
              <HostGroupSection
                key={group.groupKey}
                groupKey={group.groupKey}
                label={group.label}
                count={group.items.length}
                expanded={isGroupExpanded(group.groupKey)}
                onToggle={() => toggleGroup(group.groupKey)}
                onContextMenu={(e) => handleGroupContextMenu(e, group.groupKey)}
              >
                {group.items.map((host) => (
                  <div
                    key={`${group.groupKey}::${host.id}`}
                    className={`host-item-row${activeHostId === host.id ? " active" : ""}`}
                    onContextMenu={(e) => handleContextMenu(e, host)}
                  >
                    <button
                      type="button"
                      className="host-item"
                      onClick={() => selectHost(host)}
                      onDoubleClick={() => onConnect?.(host.id)}
                    >
                      <HostStatusIndicator resourceId={host.id} />
                      <div className="host-icon">{HOST_ICON}</div>
                      <div className="host-info">
                        <div className="host-row-1">
                          <span className="host-name">{host.name}</span>
                          <HostResourceTags resourceId={host.id} />
                          <HostMonitoringBadge resourceId={host.id} />
                        </div>
                        <div className="host-row-2">{host.subtitle}</div>
                      </div>
                    </button>
                    <HostPanelBadge sshId={host.id} />
                  </div>
                ))}
              </HostGroupSection>
            ))
          )}
        </div>
      </ScopedSearch>

      {listCtxMenu && (
        <ContextMenu
          items={buildListCtxItems()}
          position={{ x: listCtxMenu.x, y: listCtxMenu.y }}
          onClose={() => setListCtxMenu(null)}
        />
      )}

      <WarnAlert
        open={syncWarnOpen}
        title={t("ssh.sidebar.syncConfigConfirmTitle")}
        message={t("ssh.sidebar.syncConfigConfirmMessage")}
        confirmLabel={t("common.continue")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => void performSyncConfig()}
        onClose={() => setSyncWarnOpen(false)}
      />

      <SshConnectionDialog
        open={showDialog}
        onClose={() => { setShowDialog(false); setEditConnection(undefined); }}
        onSaved={() => useConnectionStore.getState().refresh()}
        editConnection={editConnection}
      />
    </div>
  );
}
