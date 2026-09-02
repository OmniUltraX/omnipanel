import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { parseResourceTag } from "../../lib/resourceTags";
import { type WorkspaceResource } from "../../lib/resourceRegistry";
import { CONNECTION_TAG_KINDS } from "../../modules/tags/tagKinds";
import { passTagFilter, useModuleTagFilter } from "../../modules/tags/useModuleTagFilter";
import { Button } from "../ui/Button";
import { IconDownload } from "../ui/icons/Icons";
import type { HostDockOpenMode } from "../../modules/server/ssh/workspaceTabs";
import { OPENSSH_CONFIG_GROUP, sshGroupLabel } from "../../lib/sshGroups";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import { quickInput } from "../../lib/quickInput";
import { ScopedSearch } from "../ui/ScopedSearch";
import {
  syncFromOpenSshConfig,
  useConnectionStore,
} from "../../stores/connectionStore";
import { HostStatusIndicator } from "../../modules/server/ssh/components/HostStatusIndicator";
import { loadSshPoolStatuses } from "../../stores/sshConnectionStore";
import { useSshHostStore } from "../../stores/sshHostStore";
import { usePanelProbeStore } from "../../modules/server/ssh/stores/panelProbeStore";
import { useResourceProfileNavStore } from "../../lib/resource/resourceProfileNavStore";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { GLOBAL_SHARE_MENU_ID } from "../ui/menu/withGlobalShareMenuItem";
import { useShareUiStore } from "../../stores/shareUiStore";
import { buildSshConnectionSharePayload } from "../../modules/share/resourceShare";
import hostIcon from "../../assets/icons/host.svg";
import { SshConnectionDialog } from "../../modules/server/ssh/components/SshConnectionDialog";
import { SshConfigImportDialog } from "../../modules/server/ssh/components/SshConfigImportDialog";
import {
  findPanelsForSsh,
  getLinkedConnectionIds,
  parsePanelConfig,
} from "../../modules/server/panel/serverConnection";
import { BrandIconImg, resolvePanelBrandIcon, type PanelBrandIconKind } from "../../modules/server/brandIcons";
import {
  jumpSshDocker,
  jumpSshPanel,
  jumpSshSftp,
  jumpSshTerminal,
  sshHasPanel,
} from "../../modules/server/ssh/sshHostQuickJumps";
import { SSH_PATH } from "../../modules/server/ssh/constants";
import type { Connection } from "../../ipc/bindings";
import {
  SidebarTreeEmpty,
  SidebarTreeNode,
  SidebarTreeRoot,
  SidebarTreeSelectionProvider,
  useSidebarTreeSelection,
  type TreeRowMouseEvent,
} from "../ui/sidebar-tree";
import { usePersistedSshTreeExpanded } from "../../modules/server/ssh/usePersistedSshTreeExpanded";
import {
  collectAllSshSidebarTreeKeys,
  getSshHostFolderLabel,
  listSshSidebarChildren,
  makeSshHostTreeKey,
  parseSshSidebarFolderTreeKey,
  sshSidebarConnectionNodeKey,
  sshSidebarFolderNodeKey,
  useSshSidebarTreeStore,
  type SshSidebarFolder,
} from "../../stores/sshSidebarTreeStore";
import { showToast } from "../../stores/toastStore";
interface HostListPanelProps {
  resources: WorkspaceResource[];
  /** 当前高亮主机（Dock 活跃 Tab 对应的主机） */
  activeHostId?: string | null;
  /** 单击 preview / 双击 permanent 打开 Dock Tab */
  onSelectHost?: (hostId: string, mode?: HostDockOpenMode) => void;
  /** 嵌入 VerticalSplitSidebarSection 时使用，隐藏旧版顶栏 */
  embedded?: boolean;
  /** embedded 模式下向外同步工具栏与计数 */
  onHeaderMetaChange?: (meta: { count: number; actions: ReactNode }) => void;
  /** 多选模式（批量命令） */
  selectionMode?: boolean;
  selectedIds?: string[];
  onToggleSelect?: (hostId: string) => void;
  /** 标签筛选 moduleKey，默认 ssh */
  tagModuleKey?: string;
}

const DND_MIME = "text/omnipanel-ssh-sidebar";

function parseSshHostTreeKey(key: string): string | null {
  return key.startsWith("ssh:") ? key.slice("ssh:".length) : null;
}

function nodeKeyToTreeKey(nodeKey: string): string | null {
  if (nodeKey.startsWith("c:")) return makeSshHostTreeKey(nodeKey.slice(2));
  if (nodeKey.startsWith("f:")) return `ssh-folder:${nodeKey.slice(2)}`;
  return null;
}

function parseDragNodeKeys(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((k) => typeof k === "string")) {
      return parsed as string[];
    }
  } catch {
    /* 单节点旧格式 */
  }
  return [raw];
}

/**
 * 多选拖拽：拖的是已选集合中的一项时，移动整组；
 * 已选文件夹的子孙（子文件夹 / 其下主机）不再单独移动。
 */
function resolveMultiMoveNodeKeys(
  draggedNodeKey: string,
  selectedTreeKeys: ReadonlySet<string>,
  folders: SshSidebarFolder[],
  connectionFolderId: Record<string, string>,
  orderedTreeKeys?: readonly string[],
): string[] {
  const draggedTreeKey = nodeKeyToTreeKey(draggedNodeKey);
  if (
    !draggedTreeKey ||
    selectedTreeKeys.size <= 1 ||
    !selectedTreeKeys.has(draggedTreeKey)
  ) {
    return [draggedNodeKey];
  }

  const folderById = new Map(folders.map((f) => [f.id, f]));
  const selectedFolderIds = new Set(
    [...selectedTreeKeys]
      .map(parseSshSidebarFolderTreeKey)
      .filter((id): id is string => Boolean(id)),
  );

  const hasSelectedAncestorFolder = (folderId: string | null): boolean => {
    let cur = folderId;
    while (cur) {
      if (selectedFolderIds.has(cur)) return true;
      cur = folderById.get(cur)?.parentId ?? null;
    }
    return false;
  };

  const iteration =
    orderedTreeKeys && orderedTreeKeys.length > 0
      ? orderedTreeKeys.filter((k) => selectedTreeKeys.has(k))
      : [...selectedTreeKeys];

  const nodeKeys: string[] = [];
  for (const treeKey of iteration) {
    const folderId = parseSshSidebarFolderTreeKey(treeKey);
    if (folderId) {
      const parentId = folderById.get(folderId)?.parentId ?? null;
      if (hasSelectedAncestorFolder(parentId)) continue;
      nodeKeys.push(sshSidebarFolderNodeKey(folderId));
      continue;
    }
    const hostId = parseSshHostTreeKey(treeKey);
    if (!hostId) continue;
    const parentId = connectionFolderId[hostId] ?? null;
    if (hasSelectedAncestorFolder(parentId)) continue;
    nodeKeys.push(sshSidebarConnectionNodeKey(hostId));
  }

  return nodeKeys.length > 0 ? nodeKeys : [draggedNodeKey];
}

function isDropTargetBlockedByMovingFolders(
  targetParentId: string | null,
  movingNodeKeys: string[],
  folders: SshSidebarFolder[],
): boolean {
  if (!targetParentId) return false;
  const movingFolderIds = new Set(
    movingNodeKeys
      .filter((k) => k.startsWith("f:"))
      .map((k) => k.slice(2)),
  );
  if (movingFolderIds.has(targetParentId)) return true;
  const folderById = new Map(folders.map((f) => [f.id, f]));
  let cur: string | null = targetParentId;
  while (cur) {
    if (movingFolderIds.has(cur)) return true;
    cur = folderById.get(cur)?.parentId ?? null;
  }
  return false;
}

/** Ctrl+A 全选 / Delete 删除（仅侧栏指针激活时响应）。 */
function SshTreeHotkeys({
  allKeys,
  armedRef,
  onDeleteSelected,
}: {
  allKeys: readonly string[];
  armedRef: MutableRefObject<boolean>;
  onDeleteSelected: (selected: ReadonlySet<string>) => boolean | Promise<boolean>;
}) {
  const selection = useSidebarTreeSelection();
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!armedRef.current) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable=''], [contenteditable='true']",
        )
      ) {
        return;
      }

      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "a") {
        if (allKeys.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        selectionRef.current?.setSelectedIds(allKeys);
        return;
      }

      if (event.key === "Delete") {
        const selected = selectionRef.current?.selectedIds;
        if (!selected || selected.size === 0) return;
        event.preventDefault();
        event.stopPropagation();
        void Promise.resolve(onDeleteSelected(selected)).then((deleted) => {
          if (deleted) selectionRef.current?.clearSelection();
        });
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [allKeys, armedRef, onDeleteSelected]);

  return null;
}

/** 在 Provider 内捕获多选 API，供主机行 onSelect 调用。 */
function SshSelectionApiCapture({
  apiRef,
}: {
  apiRef: MutableRefObject<ReturnType<typeof useSidebarTreeSelection>>;
}) {
  apiRef.current = useSidebarTreeSelection();
  return null;
}

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/** SSH 主机条目图标（assets/icons/host.svg） */
function HostTreeIcon() {
  return (
    <img
      src={hostIcon}
      alt=""
      width={14}
      height={14}
      className="ssh-tree-host-icon"
      aria-hidden
      draggable={false}
    />
  );
}

const PANEL_ICON_ORDER: PanelBrandIconKind[] = ["bt", "1panel"];

function HostPanelIcons({ sshId }: { sshId: string }) {
  const { t } = useI18n();
  const connections = useConnectionStore((s) => s.connections);
  const probed = usePanelProbeStore((s) => s.results[sshId]);
  const kinds = new Set<PanelBrandIconKind>();
  if (probed) {
    for (const panel of probed.panels) {
      if (!panel.installed) continue;
      const brand = resolvePanelBrandIcon(panel.kind);
      if (brand) kinds.add(brand);
    }
  }
  for (const panel of findPanelsForSsh(connections, sshId)) {
    const brand = resolvePanelBrandIcon(parsePanelConfig(panel).serviceType);
    if (brand) kinds.add(brand);
  }
  if (kinds.size === 0) return null;
  return (
    <span className="host-panel-icons">
      {PANEL_ICON_ORDER.filter((kind) => kinds.has(kind)).map((kind) => (
        <BrandIconImg
          key={kind}
          kind={kind}
          size={14}
          className="host-panel-icon"
          title={
            kind === "1panel"
              ? t("server.serviceType.1panel")
              : t("server.serviceType.bt")
          }
        />
      ))}
    </span>
  );
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

function folderDisplayName(name: string, t: (key: string) => string): string {
  if (name === OPENSSH_CONFIG_GROUP) return sshGroupLabel(name, t);
  return name;
}

type CtxTarget =
  | { kind: "blank" }
  | { kind: "folder"; folder: SshSidebarFolder }
  | { kind: "host"; host: WorkspaceResource };

export function HostListPanel({
  resources,
  activeHostId: activeHostIdProp,
  onSelectHost,
  embedded = false,
  onHeaderMetaChange,
  selectionMode = false,
  selectedIds = [],
  onToggleSelect,
  tagModuleKey = "terminal",
}: HostListPanelProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const selectedResourceByPath = useWorkspaceStore((s) => s.selectedResourceByPath);
  const selectResource = useWorkspaceStore((s) => s.selectResource);
  const setActivePath = useWorkspaceStore((s) => s.setActivePath);
  const connections = useConnectionStore((s) => s.connections);
  const removeConn = useConnectionStore((s) => s.remove);
  const openShareDialog = useShareUiStore((s) => s.openShareDialog);
  const activeHostId = activeHostIdProp ?? selectedResourceByPath[SSH_PATH];
  const { isExpanded, toggle, ensureExpanded } = usePersistedSshTreeExpanded();

  const folders = useSshSidebarTreeStore((s) => s.folders);
  const connectionFolderId = useSshSidebarTreeStore((s) => s.connectionFolderId);
  const orderByParent = useSshSidebarTreeStore((s) => s.orderByParent);
  const createFolder = useSshSidebarTreeStore((s) => s.createFolder);
  const renameFolder = useSshSidebarTreeStore((s) => s.renameFolder);
  const deleteFolder = useSshSidebarTreeStore((s) => s.deleteFolder);
  const moveNode = useSshSidebarTreeStore((s) => s.moveNode);
  const pruneMissingConnections = useSshSidebarTreeStore((s) => s.pruneMissingConnections);
  const migrateFromConnectionGroups = useSshSidebarTreeStore((s) => s.migrateFromConnectionGroups);
  const adoptOpenSshSyncedHosts = useSshSidebarTreeStore((s) => s.adoptOpenSshSyncedHosts);

  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxTarget, setCtxTarget] = useState<CtxTarget | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importTargetFolderId, setImportTargetFolderId] = useState<string | null>(null);
  const [editConnection, setEditConnection] = useState<Connection | undefined>(undefined);
  const [presetFolderId, setPresetFolderId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const tagAllowedIds = useModuleTagFilter(tagModuleKey, CONNECTION_TAG_KINDS);
  const rootRef = useRef<HTMLDivElement>(null);
  const presetFolderIdRef = useRef<string | null>(null);
  presetFolderIdRef.current = presetFolderId;
  const importTargetFolderIdRef = useRef<string | null>(null);
  importTargetFolderIdRef.current = importTargetFolderId;
  const treeSelectedIdsRef = useRef<ReadonlySet<string>>(new Set());
  const sidebarHotkeysArmedRef = useRef(false);
  const selectionApiRef = useRef<ReturnType<typeof useSidebarTreeSelection>>(null);
  const handleTreeSelectedIdsChange = useCallback((ids: ReadonlySet<string>) => {
    treeSelectedIdsRef.current = ids;
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      sidebarHotkeysArmedRef.current = Boolean(rootRef.current?.contains(event.target as Node));
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  useEffect(() => {
    void loadSshPoolStatuses();
  }, []);

  useEffect(() => {
    const run = () => {
      const hosts = resources.map((r) => ({ id: r.id, group: r.group }));
      migrateFromConnectionGroups(hosts);
      pruneMissingConnections(resources.map((r) => r.id));
      adoptOpenSshSyncedHosts(hosts);
    };
    if (useSshSidebarTreeStore.persist.hasHydrated()) {
      run();
      return;
    }
    return useSshSidebarTreeStore.persist.onFinishHydration(run);
  }, [resources, migrateFromConnectionGroups, pruneMissingConnections, adoptOpenSshSyncedHosts]);

  useEffect(() => {
    if (!activeHostId) return;
    ensureExpanded(makeSshHostTreeKey(activeHostId));
    const folderId = connectionFolderId[activeHostId];
    if (folderId) ensureExpanded(`ssh-folder:${folderId}`);
  }, [activeHostId, connectionFolderId, ensureExpanded]);

  const hostById = useMemo(() => {
    const map = new Map<string, WorkspaceResource>();
    for (const r of resources) map.set(r.id, r);
    return map;
  }, [resources]);

  const filteredHosts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return resources.filter((r) => {
      if (!passTagFilter(tagAllowedIds, r.id)) return false;
      if (!q) return true;
      if (r.name.toLowerCase().includes(q)) return true;
      if (r.subtitle.toLowerCase().includes(q)) return true;
      const folderName = getSshHostFolderLabel(r.id);
      if (folderName?.toLowerCase().includes(q)) return true;
      return (r.tags ?? []).some((tag) => {
        const { key, value } = parseResourceTag(tag);
        return (
          tag.toLowerCase().includes(q) ||
          key.toLowerCase().includes(q) ||
          value.toLowerCase().includes(q)
        );
      });
    });
  }, [resources, query, tagAllowedIds]);

  const searching = query.trim().length > 0;
  const hostIds = useMemo(() => resources.map((r) => r.id), [resources]);
  const filteredHostIds = useMemo(() => filteredHosts.map((r) => r.id), [filteredHosts]);

  const allTreeKeys = useMemo(() => {
    if (searching) {
      return filteredHosts.map((h) => makeSshHostTreeKey(h.id));
    }
    return collectAllSshSidebarTreeKeys(
      { folders, orderByParent, connectionFolderId },
      hostIds,
      makeSshHostTreeKey,
    );
  }, [connectionFolderId, filteredHosts, folders, hostIds, orderByParent, searching]);

  useEffect(() => {
    if (!searching) return;
    for (const host of filteredHosts) {
      ensureExpanded(makeSshHostTreeKey(host.id));
    }
  }, [ensureExpanded, filteredHosts, searching]);

  const openCtx = (event: React.MouseEvent, target: CtxTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setCtxPos({ x: event.clientX, y: event.clientY });
    setCtxTarget(target);
  };

  const selectHost = (resource: WorkspaceResource) => {
    selectResource(resource.id, SSH_PATH);
    setActivePath(SSH_PATH);
    navigate(SSH_PATH);
  };

  const handleHostClick = (host: WorkspaceResource) => {
    if (selectionMode && onToggleSelect) {
      onToggleSelect(host.id);
      return;
    }
    if (onSelectHost) {
      onSelectHost(host.id, "preview");
      return;
    }
    selectHost(host);
  };

  const handleHostDoubleClick = (host: WorkspaceResource) => {
    if (onSelectHost) {
      onSelectHost(host.id, "permanent");
      return;
    }
    selectHost(host);
  };

  const performSyncConfig = useCallback(
    async (aliases: string[]) => {
      if (syncing || aliases.length === 0) return;
      setSyncing(true);
      try {
        const aliasSet = new Set(aliases);
        const beforeIds = new Set(
          useConnectionStore
            .getState()
            .connections.filter((c) => c.kind === "ssh")
            .map((c) => c.id),
        );
        const result = await syncFromOpenSshConfig(aliases);
        if (!result) {
          const msg = t("ssh.sidebar.importConfigFailed");
          showToast(msg);
          throw new Error(msg);
        }
        const hosts = useConnectionStore
          .getState()
          .connections.filter((c) => c.kind === "ssh")
          .map((c) => ({ id: c.id, group: c.group, name: c.name }));
        const targetFolderId = importTargetFolderIdRef.current;
        if (targetFolderId) {
          const folderIds = useSshSidebarTreeStore.getState().connectionFolderId;
          for (const host of hosts) {
            if (!aliasSet.has(host.name)) continue;
            const isNew = !beforeIds.has(host.id);
            const unassigned = !folderIds[host.id];
            if (!isNew && !unassigned) continue;
            moveNode({
              nodeKey: sshSidebarConnectionNodeKey(host.id),
              targetParentId: targetFolderId,
            });
          }
          ensureExpanded(`ssh-folder:${targetFolderId}`);
        } else {
          adoptOpenSshSyncedHosts(hosts);
        }
        pruneMissingConnections(hosts.map((h) => h.id));
        showToast(
          t("ssh.sidebar.syncResult", {
            added: String(result.added),
            updated: String(result.updated),
            skipped: String(result.skipped),
          }),
        );
        if (result.failures.length > 0) {
          showToast(
            t("ssh.sidebar.syncFailures", { count: String(result.failures.length) }),
          );
        }
      } finally {
        setSyncing(false);
      }
    },
    [adoptOpenSshSyncedHosts, ensureExpanded, moveNode, pruneMissingConnections, syncing, t],
  );

  const openImportDialog = useCallback((folderId: string | null = null) => {
    setImportTargetFolderId(folderId);
    setShowImportDialog(true);
  }, []);

  const handleCreateFolder = useCallback(
    (parentId: string | null) => {
      void (async () => {
        const name = await quickInput({
          title: t("ssh.sidebar.newFolder"),
          subtitle: t("ssh.sidebar.newFolderPrompt"),
          placeholder: t("ssh.sidebar.newFolderDefault"),
          defaultValue: t("ssh.sidebar.newFolderDefault"),
          validate: (value) => (value.trim() ? null : t("quickInput.required")),
        });
        if (name == null) return;
        const id = createFolder(name, parentId);
        ensureExpanded(`ssh-folder:${id}`);
      })();
    },
    [createFolder, ensureExpanded, t],
  );

  const handleRenameFolder = (folder: SshSidebarFolder) => {
    void (async () => {
      const name = await quickInput({
        title: t("ssh.sidebar.renameFolder"),
        subtitle: t("ssh.sidebar.renameFolderPrompt"),
        placeholder: folder.name,
        defaultValue: folder.name,
        validate: (value) => (value.trim() ? null : t("quickInput.required")),
      });
      if (name == null) return;
      renameFolder(folder.id, name);
    })();
  };

  const handleDeleteFolder = async (folder: SshSidebarFolder) => {
    const confirmed = await appConfirm(
      t("ssh.sidebar.deleteFolderConfirm", { name: folderDisplayName(folder.name, t) }),
      t("ssh.sidebar.deleteFolder"),
      { confirmLabel: t("common.continue"), cancelLabel: t("common.cancel") },
    );
    if (!confirmed) return;
    deleteFolder(folder.id);
  };

  const handleAdd = () => {
    setEditConnection(undefined);
    setPresetFolderId(null);
    setShowDialog(true);
  };

  const handleNewHostInFolder = (folderId: string) => {
    setEditConnection(undefined);
    setPresetFolderId(folderId);
    setShowDialog(true);
  };

  const handleDeleteHost = async (host: WorkspaceResource) => {
    if (deleting) return;
    const treeSelected = treeSelectedIdsRef.current;
    const hostIdsFromTree = [...treeSelected]
      .map(parseSshHostTreeKey)
      .filter((id): id is string => Boolean(id));
    const selectedSet = new Set(selectedIds);
    let hostIdsToDelete: string[];
    if (hostIdsFromTree.length > 1 && hostIdsFromTree.includes(host.id)) {
      hostIdsToDelete = hostIdsFromTree;
    } else if (selectedSet.size > 1 && selectedSet.has(host.id)) {
      hostIdsToDelete = Array.from(selectedSet);
    } else {
      hostIdsToDelete = [host.id];
    }
    const confirmed = await appConfirm(
      hostIdsToDelete.length === 1
        ? t("ssh.dialog.confirmDelete", { name: host.name })
        : t("sidebarTree.confirmDeleteSelected", { count: String(hostIdsToDelete.length) }),
    );
    if (!confirmed) return;
    setDeleting(true);
    try {
      for (const hostId of hostIdsToDelete) {
        const ids = getLinkedConnectionIds(connections, hostId);
        for (const id of ids) {
          await removeConn(id);
        }
      }
    } catch {
      /* ignore */
    }
    setDeleting(false);
  };

  const handleHotkeyDelete = useCallback(
    async (selected: ReadonlySet<string>) => {
      const keys = Array.from(selected);
      if (keys.length === 0) return false;

      const folderIds = keys
        .map((key) => parseSshSidebarFolderTreeKey(key))
        .filter((id): id is string => Boolean(id));
      const hostIdsToDelete = keys
        .map(parseSshHostTreeKey)
        .filter((id): id is string => Boolean(id));

      if (hostIdsToDelete.length > 0) {
        const confirmed = await appConfirm(
          hostIdsToDelete.length === 1
            ? t("ssh.dialog.confirmDelete", {
                name: hostById.get(hostIdsToDelete[0]!)?.name ?? hostIdsToDelete[0]!,
              })
            : t("sidebarTree.confirmDeleteSelected", {
                count: String(hostIdsToDelete.length),
              }),
        );
        if (!confirmed) return false;
        for (const hostId of hostIdsToDelete) {
          const ids = getLinkedConnectionIds(
            useConnectionStore.getState().connections,
            hostId,
          );
          for (const id of ids) {
            await useConnectionStore.getState().remove(id);
          }
        }
      }
      for (const folderId of folderIds) {
        deleteFolder(folderId);
      }
      return hostIdsToDelete.length > 0 || folderIds.length > 0;
    },
    [deleteFolder, hostById, t],
  );

  const openProfile = useResourceProfileNavStore((s) => s.openProfile);

  const handleConnect = (host: WorkspaceResource, mode: HostDockOpenMode) => {
    if (onSelectHost) {
      onSelectHost(host.id, mode);
      return;
    }
    selectHost(host);
  };

  const handleDuplicateHost = (host: WorkspaceResource) => {
    const conn = connections.find((c) => c.id === host.id);
    if (!conn) return;
    const dup: Connection = {
      ...conn,
      id: "",
      name: `${conn.name} ${t("ssh.context.duplicateSuffix")}`,
    };
    setEditConnection(dup);
    setPresetFolderId(connectionFolderId[host.id] ?? null);
    setShowDialog(true);
  };

  const handleCopySshCommand = async (host: WorkspaceResource) => {
    const conn = connections.find((c) => c.id === host.id);
    if (!conn || conn.kind !== "ssh") return;
    let user = "root";
    let port = 22;
    let sshHost = "";
    try {
      const cfg = conn.config ? (JSON.parse(conn.config) as Record<string, unknown>) : {};
      if (typeof cfg.user === "string" && cfg.user.trim()) user = cfg.user.trim();
      if (typeof cfg.port === "number" && Number.isFinite(cfg.port)) port = cfg.port;
      if (typeof cfg.host === "string") sshHost = cfg.host;
    } catch {
      /* ignore */
    }
    if (!sshHost) return;
    const cmd = port === 22 ? `ssh ${user}@${sshHost}` : `ssh ${user}@${sshHost} -p ${port}`;
    try {
      await navigator.clipboard.writeText(cmd);
    } catch {
      /* ignore */
    }
  };

  const buildMoveFolderChildren = (host: WorkspaceResource): ContextMenuItem[] => {
    const current = connectionFolderId[host.id] ?? null;
    const items: ContextMenuItem[] = [
      {
        id: "move-root",
        label: t("ssh.sidebar.moveToRoot"),
        disabled: current == null,
        onClick: () => {
          moveNode({
            nodeKey: sshSidebarConnectionNodeKey(host.id),
            targetParentId: null,
          });
        },
      },
    ];
    for (const folder of folders) {
      items.push({
        id: `move-${folder.id}`,
        label: folderDisplayName(folder.name, t),
        disabled: current === folder.id,
        onClick: () => {
          moveNode({
            nodeKey: sshSidebarConnectionNodeKey(host.id),
            targetParentId: folder.id,
          });
          ensureExpanded(`ssh-folder:${folder.id}`);
        },
      });
    }
    return items;
  };

  const buildHostCtxItems = (host: WorkspaceResource): ContextMenuItem[] => {
    const hasPanel = sshHasPanel(host.id);
    return [
      {
        id: "host-connect",
        label: t("ssh.context.connect"),
        onClick: () => handleConnect(host, "preview"),
      },
      {
        id: "host-open-workspace",
        label: t("ssh.context.openInWorkspace"),
        onClick: () => handleConnect(host, "permanent"),
      },
      { id: "host-sep-jump", separator: true, label: "" },
      {
        id: "host-open-terminal",
        label: t("ssh.actions.openTerminal"),
        onClick: () => jumpSshTerminal(host.id, host.name),
      },
      {
        id: "host-open-sftp",
        label: t("ssh.actions.openSftp"),
        onClick: () => jumpSshSftp(host.id, { hostName: host.name, navigate }),
      },
      {
        id: "host-open-docker",
        label: t("ssh.quickActions.docker"),
        onClick: () => void jumpSshDocker(host.id, t("ssh.quickActions.dockerMissing")),
      },
      {
        id: "host-open-panel",
        label: t("ssh.quickActions.panel"),
        disabled: !hasPanel,
        disabledReason: hasPanel ? undefined : t("ssh.quickActions.panelMissing"),
        onClick: () => jumpSshPanel(host.id, t("ssh.quickActions.panelMissing")),
      },
      { id: "host-sep-1", separator: true, label: "" },
      {
        id: "host-edit",
        label: t("ssh.dialog.edit"),
        onClick: () => {
          const conn = connections.find((c) => c.id === host.id);
          if (conn) {
            setEditConnection(conn);
            setPresetFolderId(null);
            setShowDialog(true);
          }
        },
      },
      {
        id: "host-duplicate",
        label: t("ssh.context.duplicate"),
        onClick: () => handleDuplicateHost(host),
      },
      {
        id: GLOBAL_SHARE_MENU_ID,
        label: t("share.menu"),
        onClick: () => {
          const conn = connections.find((c) => c.id === host.id);
          if (conn) {
            openShareDialog(buildSshConnectionSharePayload(conn));
          }
        },
      },
      {
        id: "host-copy-cmd",
        label: t("ssh.context.copySshCommand"),
        onClick: () => void handleCopySshCommand(host),
      },
      {
        id: "host-view-profile",
        label: t("resource.profile.viewProfile"),
        onClick: () =>
          openProfile({ resourceType: "ssh", resourceId: host.id, displayName: host.name }),
      },
      { id: "host-sep-2", separator: true, label: "" },
      {
        id: "host-move",
        label: t("ssh.context.moveTo"),
        children: buildMoveFolderChildren(host),
      },
      { id: "host-sep-3", separator: true, label: "" },
      {
        id: "host-delete",
        label: t("ssh.dialog.delete"),
        onClick: () => void handleDeleteHost(host),
        danger: true,
      },
    ];
  };

  const ctxItems: ContextMenuItem[] = (() => {
    if (!ctxTarget) return [];
    if (ctxTarget.kind === "blank") {
      return [
        {
          id: "new-folder",
          label: t("ssh.sidebar.newFolder"),
          onClick: () => handleCreateFolder(null),
        },
        {
          id: "new-host",
          label: t("ssh.dialog.addTitle"),
          onClick: handleAdd,
        },
      ];
    }
    if (ctxTarget.kind === "folder") {
      return [
        {
          id: "new-host-here",
          label: t("ssh.context.newHostHere"),
          onClick: () => handleNewHostInFolder(ctxTarget.folder.id),
        },
        {
          id: "import-config-here",
          label: t("ssh.context.importConfigHere"),
          onClick: () => openImportDialog(ctxTarget.folder.id),
        },
        {
          id: "new-folder",
          label: t("ssh.sidebar.newFolder"),
          onClick: () => handleCreateFolder(ctxTarget.folder.id),
        },
        {
          id: "rename-folder",
          label: t("ssh.sidebar.renameFolder"),
          onClick: () => handleRenameFolder(ctxTarget.folder),
        },
        {
          id: "delete-folder",
          label: t("ssh.sidebar.deleteFolder"),
          danger: true,
          onClick: () => void handleDeleteFolder(ctxTarget.folder),
        },
      ];
    }
    return buildHostCtxItems(ctxTarget.host);
  })();

  const onDragStartNode = (event: DragEvent, nodeKey: string) => {
    const keys = resolveMultiMoveNodeKeys(
      nodeKey,
      treeSelectedIdsRef.current,
      folders,
      connectionFolderId,
      allTreeKeys,
    );
    event.dataTransfer.setData(DND_MIME, JSON.stringify(keys));
    event.dataTransfer.effectAllowed = "move";
  };

  const onDragOverNode = (event: DragEvent, dropKey: string) => {
    if (![...event.dataTransfer.types].includes(DND_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverKey(dropKey);
  };

  const onDropOnFolder = (event: DragEvent, folderId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOverKey(null);
    const keys = parseDragNodeKeys(event.dataTransfer.getData(DND_MIME)).filter(
      (k) => k !== sshSidebarFolderNodeKey(folderId),
    );
    if (keys.length === 0) return;
    if (isDropTargetBlockedByMovingFolders(folderId, keys, folders)) return;
    for (const nodeKey of keys) {
      moveNode({ nodeKey, targetParentId: folderId });
    }
    ensureExpanded(`ssh-folder:${folderId}`);
  };

  const onDropBefore = (event: DragEvent, parentId: string | null, beforeKey: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOverKey(null);
    const keys = parseDragNodeKeys(event.dataTransfer.getData(DND_MIME)).filter(
      (k) => k && k !== beforeKey,
    );
    if (keys.length === 0) return;
    if (isDropTargetBlockedByMovingFolders(parentId, keys, folders)) return;
    // 连续 insert before 同一锚点会倒序，故反向写入以保持选中顺序
    for (const nodeKey of [...keys].reverse()) {
      moveNode({ nodeKey, targetParentId: parentId, beforeKey });
    }
  };

  const renderHost = (host: WorkspaceResource, depth: number) => {
    const treeKey = makeSshHostTreeKey(host.id);
    const dragKey = sshSidebarConnectionNodeKey(host.id);
    const selected = selectedIds.includes(host.id);
    return (
      <div key={host.id} className="ssh-tree-host">
        <SidebarTreeNode
          depth={depth}
          module="ssh"
          nodeType="host"
          treeKey={treeKey}
          icon={<HostTreeIcon />}
          className={`${dragOverKey === dragKey ? "ssh-tree-drop-target" : ""}${selected ? " selected" : ""}`}
          prefix={
            selectionMode ? (
              <input
                type="checkbox"
                className="host-item-select"
                checked={selected}
                onChange={() => onToggleSelect?.(host.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={host.name}
              />
            ) : (
              <HostStatusIndicator resourceId={host.id} />
            )
          }
          label={
            <span className="host-info ssh-tree-host-label">
              <span className="host-row-1">
                <span className="host-name">{host.name}</span>
                <span className="host-row-2">{host.subtitle}</span>
                <span className="host-row-1-meta">
                  <HostMonitoringBadge resourceId={host.id} />
                </span>
              </span>
            </span>
          }
          trailing={<HostPanelIcons sshId={host.id} />}
          hasChildren={false}
          expanded={false}
          active={activeHostId === host.id}
          onToggle={() => undefined}
          draggable={!selectionMode}
          onDragStart={(e) => onDragStartNode(e, dragKey)}
          onDragOver={(e) => onDragOverNode(e, dragKey)}
          onDragLeave={() => setDragOverKey((k) => (k === dragKey ? null : k))}
          onDrop={(e) => {
            const parentId = connectionFolderId[host.id] ?? null;
            onDropBefore(e, parentId, dragKey);
          }}
          onDragEnd={() => setDragOverKey(null)}
          onSelect={(event: TreeRowMouseEvent) => {
            selectionApiRef.current?.handleSelect(treeKey, event);
            if (event.ctrlKey || event.metaKey || event.shiftKey) return;
            handleHostClick(host);
          }}
          onActivate={() => handleHostDoubleClick(host)}
          onContextMenu={(event) => openCtx(event, { kind: "host", host })}
        />
      </div>
    );
  };

  const renderFolderTree = (parentId: string | null, depth: number): ReactNode => {
    const items = listSshSidebarChildren(
      { folders, orderByParent, connectionFolderId },
      parentId,
      searching ? filteredHostIds : hostIds,
    );
    return items.map((item) => {
      if (item.kind === "connection") {
        const host = hostById.get(item.connectionId);
        if (!host) return null;
        if (searching && !filteredHostIds.includes(host.id)) return null;
        return renderHost(host, depth);
      }
      const folder = item.folder;
      if (searching) {
        const childKeys = collectAllSshSidebarTreeKeys(
          { folders, orderByParent, connectionFolderId },
          filteredHostIds,
          makeSshHostTreeKey,
          folder.id,
        );
        if (childKeys.length === 0) return null;
      }
      const folderTreeKey = `ssh-folder:${folder.id}`;
      const folderExpanded = searching || isExpanded(folderTreeKey);
      const dropKey = sshSidebarFolderNodeKey(folder.id);
      return (
        <div key={folder.id} className="ssh-tree-folder">
          <SidebarTreeNode
            depth={depth}
            module="ssh"
            nodeType="folder"
            treeKey={folderTreeKey}
            icon={<FolderIcon />}
            className={dragOverKey === dropKey ? "ssh-tree-drop-target" : ""}
            label={folderDisplayName(folder.name, t)}
            hasChildren
            expanded={folderExpanded}
            draggable
            onDragStart={(e) => onDragStartNode(e, dropKey)}
            onDragOver={(e) => onDragOverNode(e, dropKey)}
            onDragLeave={() => setDragOverKey((k) => (k === dropKey ? null : k))}
            onDrop={(e) => onDropOnFolder(e, folder.id)}
            onDragEnd={() => setDragOverKey(null)}
            onToggle={() => toggle(folderTreeKey)}
            onContextMenu={(event) => openCtx(event, { kind: "folder", folder })}
            onRename={() => handleRenameFolder(folder)}
            onDelete={() => void handleDeleteFolder(folder)}
            renameLabel={t("ssh.sidebar.renameFolder")}
            deleteLabel={t("ssh.sidebar.deleteFolder")}
          />
          {folderExpanded ? renderFolderTree(folder.id, depth + 1) : null}
        </div>
      );
    });
  };

  const toolbar = useMemo(
    () => (
      <div className="schema-toolbar schema-toolbar--inline host-list-actions">
        <Button
          variant="icon"
          title={t("ssh.sidebar.syncConfig")}
          disabled={syncing}
          onClick={() => openImportDialog(null)}
        >
          <IconDownload size={14} className={syncing ? "icon-spin" : undefined} />
        </Button>
        <Button
          variant="icon"
          title={t("ssh.sidebar.newFolder")}
          onClick={() => handleCreateFolder(null)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            <line x1="12" y1="11" x2="12" y2="17" />
            <line x1="9" y1="14" x2="15" y2="14" />
          </svg>
        </Button>
        <Button variant="icon" title={t("ssh.dialog.addTitle")} onClick={handleAdd}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </Button>
      </div>
    ),
    [handleCreateFolder, openImportDialog, syncing, t],
  );

  useLayoutEffect(() => {
    if (!embedded || !onHeaderMetaChange) {
      return;
    }
    onHeaderMetaChange({ count: resources.length, actions: toolbar });
  }, [embedded, onHeaderMetaChange, resources.length, toolbar]);

  const empty = filteredHosts.length === 0 && (searching || folders.length === 0);

  return (
    <div className="host-list-panel" ref={rootRef}>
      {!embedded ? (
        <div className="host-list-header window-drag-surface" data-tauri-drag-region>
          <h3>{t("ssh.sidebar.title")}</h3>
          <span className="badge badge-muted">{resources.length}</span>
          {toolbar}
        </div>
      ) : null}
      <ScopedSearch value={query} onChange={setQuery} placeholder={t("ssh.sidebar.search")}>
        <SidebarTreeSelectionProvider
          orderedKeys={allTreeKeys}
          onSelectedIdsChange={handleTreeSelectedIdsChange}
        >
          <SshSelectionApiCapture apiRef={selectionApiRef} />
          <SshTreeHotkeys
            allKeys={allTreeKeys}
            armedRef={sidebarHotkeysArmedRef}
            onDeleteSelected={handleHotkeyDelete}
          />
          <div
            className="host-list ssh-sidebar-tree-wrap"
            onContextMenu={(event) => {
              if ((event.target as HTMLElement).closest(".sidebar-tree-node, .tree-node")) return;
              openCtx(event, { kind: "blank" });
            }}
          >
            <SidebarTreeRoot className="ssh-sidebar-tree">
              {empty ? (
                <SidebarTreeEmpty>
                  {searching ? t("ssh.sidebar.searchNoResults") : t("common.noResources")}
                </SidebarTreeEmpty>
              ) : searching ? (
                filteredHosts.map((host) => renderHost(host, 0))
              ) : (
                renderFolderTree(null, 0)
              )}
            </SidebarTreeRoot>
          </div>
        </SidebarTreeSelectionProvider>
      </ScopedSearch>

      {ctxPos ? (
        <ContextMenu
          items={ctxItems}
          position={ctxPos}
          onClose={() => {
            setCtxPos(null);
            setCtxTarget(null);
          }}
        />
      ) : null}

      <SshConnectionDialog
        open={showDialog}
        onClose={() => {
          setShowDialog(false);
          setEditConnection(undefined);
          setPresetFolderId(null);
        }}
        onSaved={(savedId) => {
          void useConnectionStore.getState().refresh();
          const folderId = presetFolderIdRef.current;
          if (savedId && folderId) {
            moveNode({
              nodeKey: sshSidebarConnectionNodeKey(savedId),
              targetParentId: folderId,
            });
            ensureExpanded(`ssh-folder:${folderId}`);
          } else if (savedId) {
            useSshSidebarTreeStore.getState().ensureConnectionListed(savedId);
          }
        }}
        editConnection={editConnection}
      />

      <SshConfigImportDialog
        open={showImportDialog}
        onClose={() => {
          setShowImportDialog(false);
          setImportTargetFolderId(null);
        }}
        onConfirm={performSyncConfig}
      />
    </div>
  );
}
