import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useLocation } from "react-router-dom";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/menu/ContextMenu";
import { buildTabCloseMenuItems, type TabContextMenuAction } from "../../components/ui/menu";
import {
  ModuleSegmentDock,
  openDockTabNow,
  closeDockTabNow,
  type DockableTab,
} from "../../components/dock";
import { patchDockTabPreviewMeta } from "../../components/dock/dockTabLiveMeta";
import {
  ModuleModeIconRail,
  ModuleWorkspaceLayout,
} from "../../components/workspace";
import { useModuleRouteActive } from "../../lib/useModuleRouteActive";
import { ModuleLeftHeaderActions } from "../../components/ai/ModuleLeftHeaderActions";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { useI18n } from "../../i18n";
import { migrateLayoutStorage } from "../../lib/layoutMigration";
import { appConfirm } from "../../lib/appConfirm";
import { subscribeDockviewTransfer, relayoutDockviewInstances, getDockviewInstanceByScope } from "../../lib/dockviewRegistry";
import { deliverMirroredTabToWorkspace } from "../../lib/workspaceSnapshotDelivery";
import { removeFileTabFromLayout } from "../../stores/filesWorkspaceSessionStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { Connection, FileIndexStatus, FileLocalSystemInfo, FileManagerConnectionInfo } from "../../ipc/bindings";
import type { FileIndexProgress } from "./fileApi";
import { useConnectionStore } from "../../stores/connectionStore";
import { useFileManagerStore } from "../../stores/fileManagerStore";
import { CLIENT_SYNC_MODULES_APPLIED_EVENT } from "../clientSync/moduleSync";
import {
  useFilesFavoritesStore,
  type FileFavorite,
} from "../../stores/filesFavoritesStore";
import { useFilesWorkspaceSessionStore } from "../../stores/filesWorkspaceSessionStore";
import { showToast } from "../../stores/toastStore";
import { quickInput } from "../../stores/quickInputStore";
import { FileConnectionDialog, type FileProtocol } from "./FileConnectionDialog";
import { FileConnectionPanel, buildS3BindKey } from "./FileConnectionPanel";
import { readStoredFilesDetailVisible } from "./filesDetailSidebarPersist";
import { FilesSidebar } from "./FilesSidebar";
import {
  clearFilesDrag,
  hasFilesDrag,
  parseFilesDrag,
  queuePendingFilesTabDrop,
} from "./filesDragTransfer";
import { CONNECTION_TAG_KINDS } from "../tags/tagKinds";
import { passTagFilter, useModuleTagFilter } from "../tags/useModuleTagFilter";
import {
  fileConnPanelId,
  fileProtocolDockIcon,
  parseFileConnPanelId,
} from "./filesWorkspacePanels";
import type { FileDockOpenMode } from "./filesWorkspaceSession";
import {
  buildFileIndex,
  clearFileIndex,
  fmtError,
  getFileIndexStatus,
  listFileConnections,
  loadLocalSystemInfo,
  loadQuickPaths,
  testFileConnection,
} from "./fileApi";
import { ensureSftpForSsh, syncSshSftpConnections } from "./syncSshSftp";
import { LOCAL_CONNECTION_ID } from "./utils";
import { FilesModuleContextBridge } from "./ai/FilesModuleContextBridge";
import {
  clearSftpDeepLink,
  OPEN_SFTP_FOR_SSH_EVENT,
  takeSftpDeepLink,
  type SshSftpDeepLink,
} from "../server/ssh/sshHostQuickJumps";

type ConnCtxState = { x: number; y: number; conn: FileManagerConnectionInfo } | null;
type FavCtxState = { x: number; y: number; favorite: FileFavorite } | null;

function FilesBrowserView() {
  const { t } = useI18n();
  const location = useLocation();
  const { isActiveRoute } = useModuleRouteActive("files");
  const refreshConnections = useConnectionStore((s) => s.refresh);
  const removeConnection = useConnectionStore((s) => s.remove);
  const storedConnections = useConnectionStore((s) => s.connections);
  const transfers = useFileManagerStore((s) => s.transfers);
  const clearDoneTransfers = useFileManagerStore((s) => s.clearDoneTransfers);
  const cancelTransfer = useFileManagerStore((s) => s.cancelTransfer);
  const retryTransfer = useFileManagerStore((s) => s.retryTransfer);
  const hydrateTransfers = useFileManagerStore((s) => s.hydrateTransfers);

  useEffect(() => {
    void hydrateTransfers();
  }, [hydrateTransfers]);

  const openConnIds = useFilesWorkspaceSessionStore((s) => s.openConnIds);
  const previewConnId = useFilesWorkspaceSessionStore((s) => s.previewConnId);
  const activePanelId = useFilesWorkspaceSessionStore((s) => s.activePanelId);
  const savedLayout = useFilesWorkspaceSessionStore((s) => s.savedLayout);
  const panelStates = useFilesWorkspaceSessionStore((s) => s.panelStates);
  const workspaceOnlyConnIds = useFilesWorkspaceSessionStore((s) => s.workspaceOnlyConnIds);
  const setSavedLayout = useFilesWorkspaceSessionStore((s) => s.setSavedLayout);
  const setActivePanelId = useFilesWorkspaceSessionStore((s) => s.setActivePanelId);
  const openConnection = useFilesWorkspaceSessionStore((s) => s.openConnection);
  const promotePreview = useFilesWorkspaceSessionStore((s) => s.promotePreview);
  const closeConnection = useFilesWorkspaceSessionStore((s) => s.closeConnection);
  const setPanelState = useFilesWorkspaceSessionStore((s) => s.setPanelState);
  const pruneMissingConnections = useFilesWorkspaceSessionStore((s) => s.pruneMissingConnections);
  const setConnectionWorkspaceOnly = useFilesWorkspaceSessionStore((s) => s.setConnectionWorkspaceOnly);
  const favorites = useFilesFavoritesStore((s) => s.favorites);
  const removeFavorite = useFilesFavoritesStore((s) => s.removeFavorite);
  const renameFavorite = useFilesFavoritesStore((s) => s.renameFavorite);
  const setFavoritePinned = useFilesFavoritesStore((s) => s.setFavoritePinned);
  const activeWorkspaceId = useWorkspaceStore((state) => state.workspace.id);
  const workspaces = useWorkspaceStore((state) => state.workspaces);

  const [sessionHydrated, setSessionHydrated] = useState(
    () => useFilesWorkspaceSessionStore.persist.hasHydrated(),
  );
  const [connections, setConnections] = useState<FileManagerConnectionInfo[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogInitialProtocol, setDialogInitialProtocol] = useState<FileProtocol | undefined>();
  const [dialogInitialSshId, setDialogInitialSshId] = useState<string | undefined>();
  const [editConnection, setEditConnection] = useState<Connection | undefined>();
  const [syncingSshSftp, setSyncingSshSftp] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<ConnCtxState>(null);
  const [favCtxMenu, setFavCtxMenu] = useState<FavCtxState>(null);
  const [tabCtxMenu, setTabCtxMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
    index: number;
  } | null>(null);
  const [quickPaths, setQuickPaths] = useState<{
    home: string;
    desktop: string;
    documents: string;
    downloads: string;
  } | null>(null);
  const [localSystemInfo, setLocalSystemInfo] = useState<FileLocalSystemInfo | null>(null);
  const [connBanner, setConnBanner] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [indexStatuses, setIndexStatuses] = useState<Record<string, FileIndexStatus>>({});
  const activeNavigateRef = useRef<((path: string) => void) | null>(null);
  const activeNavigateConnIdRef = useRef<string | null>(null);
  const pendingNavigateRef = useRef<{ connId: string; path: string } | null>(null);
  const bootstrappedDefaultRef = useRef(false);
  const sftpDeepLinkHandledKeyRef = useRef<string | null>(null);

  useEffect(() => {
    migrateLayoutStorage("files", ["omnipanel.filesDockLayout.v3"]);
  }, []);

  const modeIconItems = useMemo(
    () => [{ id: "browser", label: t("files.tabs.browser"), icon: "file-local" as const }],
    [t],
  );

  const tagAllowedIds = useModuleTagFilter("files", CONNECTION_TAG_KINDS);
  const visibleConnections = useMemo(
    () =>
      connections.filter(
        (c) => c.id === LOCAL_CONNECTION_ID || passTagFilter(tagAllowedIds, c.id),
      ),
    [connections, tagAllowedIds],
  );

  useEffect(() => {
    if (useFilesWorkspaceSessionStore.persist.hasHydrated()) {
      setSessionHydrated(true);
      return;
    }
    return useFilesWorkspaceSessionStore.persist.onFinishHydration(() => {
      setSessionHydrated(true);
    });
  }, []);

  const sidebarActiveId = useMemo(() => {
    if (!activePanelId) return LOCAL_CONNECTION_ID;
    return parseFileConnPanelId(activePanelId) ?? LOCAL_CONNECTION_ID;
  }, [activePanelId]);

  const loadIndexStatuses = useCallback(async (connIds: string[]) => {
    const entries = await Promise.all(
      connIds.map(async (id) => {
        try {
          const status = await getFileIndexStatus(id);
          return [id, status] as const;
        } catch {
          return null;
        }
      }),
    );
    setIndexStatuses((prev) => {
      const next = { ...prev };
      for (const entry of entries) {
        if (entry) next[entry[0]] = entry[1];
      }
      return next;
    });
  }, []);

  const loadConnections = useCallback(async () => {
    try {
      const list = await listFileConnections();
      setConnections(list);
      void loadIndexStatuses([LOCAL_CONNECTION_ID]);
    } catch (e) {
      setConnBanner({ kind: "error", text: fmtError(e) });
    }
  }, [loadIndexStatuses]);

  const patchConnectionStatus = useCallback((connId: string, status: "online" | "offline") => {
    setConnections((prev) =>
      prev.map((conn) => (conn.id === connId ? { ...conn, status } : conn)),
    );
  }, []);

  const openConnectionPanel = useCallback((
    conn: FileManagerConnectionInfo,
    mode: FileDockOpenMode = "preview",
  ) => {
    openDockTabNow({
      applyTabSync: () => {
        openConnection(conn.id, mode);
        const isPreview =
          useFilesWorkspaceSessionStore.getState().previewConnId === conn.id;
        patchDockTabPreviewMeta(fileConnPanelId(conn.id), isPreview);
      },
    });
  }, [openConnection]);

  const navigateConnectionToPath = useCallback((
    connId: string,
    path: string,
    mode: FileDockOpenMode = "preview",
  ) => {
    const prev = useFilesWorkspaceSessionStore.getState().panelStates[connId];
    setPanelState(connId, {
      viewMode: prev?.viewMode ?? "list",
      detailVisible: prev?.detailVisible ?? readStoredFilesDetailVisible(),
      currentPath: path,
      history: [path],
      historyIndex: 0,
      s3BindKey: prev?.s3BindKey,
    });
    pendingNavigateRef.current = { connId, path };
    openDockTabNow({
      applyTabSync: () => {
        openConnection(connId, mode);
        const isPreview =
          useFilesWorkspaceSessionStore.getState().previewConnId === connId;
        patchDockTabPreviewMeta(fileConnPanelId(connId), isPreview);
      },
    });
    if (
      activeNavigateConnIdRef.current === connId
      && activeNavigateRef.current
    ) {
      activeNavigateRef.current(path);
      pendingNavigateRef.current = null;
    }
  }, [openConnection, setPanelState]);

  const handleCloseTab = useCallback((tabId: string) => {
    const connId = parseFileConnPanelId(tabId);
    if (!connId) return;
    closeDockTabNow({
      removeTabSync: () => closeConnection(connId),
    });
  }, [closeConnection]);

  const handlePromotePreviewTab = useCallback((tabId: string) => {
    const connId = parseFileConnPanelId(tabId);
    if (!connId) return;
    if (useFilesWorkspaceSessionStore.getState().previewConnId !== connId) return;
    promotePreview(connId);
    patchDockTabPreviewMeta(tabId, false);
  }, [promotePreview]);

  const clearTabDropHighlights = useCallback(() => {
    document
      .querySelectorAll(".fm-tab-drop-target")
      .forEach((el) => el.classList.remove("fm-tab-drop-target"));
  }, []);

  /** HTML5 drop 当帧里 dockview 常吞掉 setActive，需延后强制切 Tab */
  const activateFilesDockTab = useCallback((tabId: string) => {
    setActivePanelId(tabId);
    const run = () => {
      try {
        const panel = getDockviewInstanceByScope("files-browser")?.api.getPanel(tabId);
        panel?.api.setActive();
      } catch {
        /* dock 卸载中 */
      }
    };
    run();
    requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
    });
    window.setTimeout(run, 32);
    window.setTimeout(run, 120);
  }, [setActivePanelId]);

  const handleWorkspaceDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!hasFilesDrag(e.dataTransfer)) return;
      // 只认 Tab 头，避免命中面板内容上的 data-dock-tab-id
      const tabEl = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(
        ".dv-default-tab[data-dock-tab-id]",
      );
      if (!tabEl) return;
      const tabId = tabEl.getAttribute("data-dock-tab-id") ?? "";
      const connId = parseFileConnPanelId(tabId);
      if (!connId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      clearTabDropHighlights();
      tabEl.classList.add("fm-tab-drop-target");
    },
    [clearTabDropHighlights],
  );

  const handleWorkspaceDragLeave = useCallback(
    (e: React.DragEvent) => {
      const related = e.relatedTarget as Node | null;
      if (related && e.currentTarget.contains(related)) return;
      clearTabDropHighlights();
    },
    [clearTabDropHighlights],
  );

  const handleWorkspaceDrop = useCallback(
    (e: React.DragEvent) => {
      clearTabDropHighlights();
      if (!hasFilesDrag(e.dataTransfer)) return;
      const tabEl = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(
        ".dv-default-tab[data-dock-tab-id]",
      );
      if (!tabEl) return;
      const tabId = tabEl.getAttribute("data-dock-tab-id") ?? "";
      const destConnectionId = parseFileConnPanelId(tabId);
      if (!destConnectionId) return;
      e.preventDefault();
      e.stopPropagation();
      const payload = parseFilesDrag(e.dataTransfer);
      clearFilesDrag();
      if (!payload?.items.length) return;
      if (payload.connectionId === destConnectionId) return;
      queuePendingFilesTabDrop({
        destConnectionId,
        items: payload.items,
      });
      activateFilesDockTab(tabId);
    },
    [activateFilesDockTab, clearTabDropHighlights],
  );

  const dockTabs = useMemo((): DockableTab[] => {
    const tabs: DockableTab[] = [];
    const workspaceOnlySet = new Set(workspaceOnlyConnIds);
    for (const connId of openConnIds) {
      if (workspaceOnlySet.has(connId)) continue;
      const conn = connections.find((c) => c.id === connId);
      if (!conn) continue;
      tabs.push({
        id: fileConnPanelId(connId),
        label: conn.name,
        panelType: "file-connection",
        icon: fileProtocolDockIcon(conn.protocol),
        tooltip: conn.name,
        closable: true,
        preview: previewConnId === connId,
      });
    }
    return tabs;
  }, [connections, openConnIds, previewConnId, workspaceOnlyConnIds]);

  useEffect(() => {
    void loadConnections();
    void loadQuickPaths().then(setQuickPaths).catch(() => undefined);
    void loadLocalSystemInfo().then(setLocalSystemInfo).catch(() => undefined);
    void refreshConnections();
  }, [loadConnections, refreshConnections]);

  useEffect(() => {
    const onSynced = () => {
      void loadConnections();
      void refreshConnections();
    };
    window.addEventListener(CLIENT_SYNC_MODULES_APPLIED_EVENT, onSynced);
    return () => window.removeEventListener(CLIENT_SYNC_MODULES_APPLIED_EVENT, onSynced);
  }, [loadConnections, refreshConnections]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<FileIndexProgress>("file-index-progress", (event) => {
      const { connectionId, status, indexedCount, error } = event.payload;
      setIndexStatuses((prev) => ({
        ...prev,
        [connectionId]: {
          connectionId,
          status: status === "building" ? "building" : status === "done" ? "ready" : "failed",
          rootPath: prev[connectionId]?.rootPath ?? "",
          indexedCount: indexedCount ?? null,
          error: error ?? "",
          startedAt: prev[connectionId]?.startedAt ?? 0,
          finishedAt: status === "building" ? 0 : Date.now(),
        },
      }));
      if (status === "done") {
        setConnBanner({
          kind: "info",
          text: t("files.index.buildDone", { count: indexedCount ?? 0 }),
        });
      } else if (status === "failed") {
        setConnBanner({
          kind: "error",
          text: error || t("files.index.buildFailed"),
        });
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [t]);

  useEffect(() => {
    if (!sessionHydrated || connections.length === 0) return;
    pruneMissingConnections(connections.map((c) => c.id));
  }, [sessionHydrated, connections, pruneMissingConnections]);

  useEffect(() => {
    if (!sessionHydrated || connections.length === 0 || bootstrappedDefaultRef.current) return;
    if (openConnIds.length > 0) {
      bootstrappedDefaultRef.current = true;
      return;
    }
    const local = connections.find((c) => c.id === LOCAL_CONNECTION_ID);
    if (local) {
      bootstrappedDefaultRef.current = true;
      openConnection(local.id, "permanent");
    }
  }, [sessionHydrated, connections, openConnIds.length, openConnection]);

  const handleSavedConnection = useCallback(async (saved?: Connection) => {
    setEditConnection(undefined);
    if (saved) {
      const prev = useFilesWorkspaceSessionStore.getState().panelStates[saved.id];
      useFilesWorkspaceSessionStore.getState().setPanelState(saved.id, {
        viewMode: prev?.viewMode ?? "list",
        detailVisible: prev?.detailVisible ?? readStoredFilesDetailVisible(),
        // 配置（尤其 S3 bucket）变更后回到根目录，避免继续展示旧桶目录缓存
        currentPath: "",
        history: [""],
        historyIndex: 0,
        s3BindKey: buildS3BindKey(saved.config),
      });
      try {
        const cfg = JSON.parse(saved.config || "{}") as { protocol?: string };
        if (cfg.protocol === "s3") {
          await clearFileIndex(saved.id);
        }
      } catch {
        // ignore
      }
    }
    await refreshConnections();
    await loadConnections();
  }, [loadConnections, refreshConnections]);

  const openNewConnectionDialog = (protocol?: FileProtocol, sshConnectionId?: string) => {
    setEditConnection(undefined);
    setDialogInitialProtocol(protocol);
    setDialogInitialSshId(sshConnectionId);
    setDialogOpen(true);
  };

  const openConnectionById = useCallback(
    (connId: string, mode: FileDockOpenMode = "permanent") => {
      openDockTabNow({
        applyTabSync: () => {
          openConnection(connId, mode);
          const isPreview =
            useFilesWorkspaceSessionStore.getState().previewConnId === connId;
          patchDockTabPreviewMeta(fileConnPanelId(connId), isPreview);
        },
      });
      setActivePanelId(fileConnPanelId(connId));
    },
    [openConnection, setActivePanelId],
  );

  const consumeSftpDeepLink = useCallback(
    (link: SshSftpDeepLink, clearRouterState: boolean) => {
      const key = `${link.openSftpForSshId}:${link.openSftpNonce}`;
      if (sftpDeepLinkHandledKeyRef.current === key) return;
      sftpDeepLinkHandledKeyRef.current = key;
      clearSftpDeepLink();

      void (async () => {
        try {
          const fileId = await ensureSftpForSsh(link.openSftpForSshId);
          await loadConnections();
          const targetPath = link.openSftpPath?.trim();
          if (targetPath) {
            navigateConnectionToPath(fileId, targetPath, "permanent");
          } else {
            openConnectionById(fileId, "permanent");
          }
        } catch {
          openNewConnectionDialog("sftp", link.openSftpForSshId);
        } finally {
          if (clearRouterState) {
            window.history.replaceState({}, "");
          }
        }
      })();
    },
    [loadConnections, navigateConnectionToPath, openConnectionById],
  );

  // 处理从 SSH 模块跳转过来的 SFTP 深链接：优先打开已关联连接，缺失则自动创建
  useEffect(() => {
    const fromState = location.state as Partial<SshSftpDeepLink> | null;
    if (fromState?.openSftpForSshId) {
      consumeSftpDeepLink(
        {
          openSftpForSshId: fromState.openSftpForSshId,
          openSftpHostName: fromState.openSftpHostName,
          openSftpNonce: fromState.openSftpNonce ?? Date.now(),
        },
        true,
      );
      return;
    }
    const fromStorage = takeSftpDeepLink();
    if (fromStorage) {
      consumeSftpDeepLink(fromStorage, false);
    }
  }, [consumeSftpDeepLink, location.state]);

  useEffect(() => {
    const onOpenSftp = (event: Event) => {
      const detail = (event as CustomEvent<SshSftpDeepLink>).detail;
      if (!detail?.openSftpForSshId) return;
      // 事件路径下 storage 可能已被 take，直接用 detail
      consumeSftpDeepLink(detail, false);
    };
    window.addEventListener(OPEN_SFTP_FOR_SSH_EVENT, onOpenSftp);
    return () => window.removeEventListener(OPEN_SFTP_FOR_SSH_EVENT, onOpenSftp);
  }, [consumeSftpDeepLink]);

  const handleSyncSshSftp = useCallback(async () => {
    if (syncingSshSftp) return;
    setSyncingSshSftp(true);
    try {
      await refreshConnections();
      const latest = useConnectionStore.getState().connections;
      if (!latest.some((c) => c.kind === "ssh")) {
        showToast(t("files.sidebar.syncSshSftpEmpty"));
        return;
      }
      const result = await syncSshSftpConnections(latest);
      await refreshConnections();
      await loadConnections();
      showToast(
        t("files.sidebar.syncSshSftpResult", {
          added: result.added,
          updated: result.updated,
          skipped: result.skipped,
        }),
        3200,
      );
    } catch (e) {
      showToast(fmtError(e));
    } finally {
      setSyncingSshSftp(false);
    }
  }, [loadConnections, refreshConnections, syncingSshSftp, t]);

  const openEditConnectionDialog = (connId: string) => {
    const conn = storedConnections.find((c) => c.id === connId && c.kind === "file");
    if (!conn) return;
    setEditConnection(conn);
    setDialogOpen(true);
  };

  const handleDeleteConnection = useCallback(async (conn: FileManagerConnectionInfo) => {
    if (conn.id === LOCAL_CONNECTION_ID) return;
    if (!(await appConfirm(t("files.context.deleteConnConfirm", { name: conn.name })))) return;
    try {
      await removeConnection(conn.id);
      const orphanFavIds = useFilesFavoritesStore
        .getState()
        .favorites.filter((item) => item.connectionId === conn.id)
        .map((item) => item.id);
      for (const id of orphanFavIds) {
        removeFavorite(id);
      }
      await loadConnections();
      if (openConnIds.includes(conn.id)) {
        handleCloseTab(fileConnPanelId(conn.id));
      }
    } catch (e) {
      setConnBanner({ kind: "error", text: fmtError(e) });
    }
  }, [handleCloseTab, loadConnections, openConnIds, removeConnection, removeFavorite, t]);

  const handleTestConnection = useCallback(async (connId: string) => {
    try {
      const msg = await testFileConnection(connId);
      setConnBanner({ kind: "info", text: msg });
      patchConnectionStatus(connId, "online");
    } catch (e) {
      setConnBanner({ kind: "error", text: fmtError(e) });
      patchConnectionStatus(connId, "offline");
    }
  }, [patchConnectionStatus]);

  const handleBuildIndex = useCallback(async (conn: FileManagerConnectionInfo) => {
    try {
      const status = await buildFileIndex(conn.id);
      setIndexStatuses((prev) => ({ ...prev, [conn.id]: status }));
      setConnBanner({ kind: "info", text: t("files.index.buildStarted", { name: conn.name }) });
    } catch (e) {
      setConnBanner({ kind: "error", text: fmtError(e) });
    }
  }, [t]);

  const handleClearIndex = useCallback(async (conn: FileManagerConnectionInfo) => {
    if (!(await appConfirm(t("files.index.clearConfirm", { name: conn.name })))) return;
    try {
      await clearFileIndex(conn.id);
      setIndexStatuses((prev) => {
        const next = { ...prev };
        delete next[conn.id];
        return next;
      });
      setConnBanner({ kind: "info", text: t("files.index.clearDone") });
    } catch (e) {
      setConnBanner({ kind: "error", text: fmtError(e) });
    }
  }, [t]);

  const handleConnContextMenu = (e: React.MouseEvent, conn: FileManagerConnectionInfo) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, conn });
  };

  const connCtxItems = useMemo((): ContextMenuItem[] => {
    if (!ctxMenu) return [];
    const conn = ctxMenu.conn;
    const indexStatus = indexStatuses[conn.id];
    const isBuilding = indexStatus?.status === "building";
    const hasIndex = indexStatus?.status === "ready" || indexStatus?.status === "failed";
    const openItems: ContextMenuItem[] = [
      {
        id: "open-pinned",
        label: t("files.sidebar.openPinned"),
        onClick: () => openConnectionPanel(conn, "permanent"),
      },
    ];
    const indexItems: ContextMenuItem[] = [
      {
        id: "build-index",
        label: hasIndex ? t("files.index.rebuild") : t("files.index.build"),
        disabled: isBuilding,
        onClick: () => void handleBuildIndex(conn),
      },
    ];
    if (hasIndex || isBuilding) {
      indexItems.push({
        id: "clear-index",
        label: t("files.index.clear"),
        disabled: isBuilding,
        onClick: () => void handleClearIndex(conn),
      });
    }
    if (conn.id === LOCAL_CONNECTION_ID) {
      return [...openItems, { id: "sep-index", separator: true, label: "" }, ...indexItems];
    }
    return [
      ...openItems,
      { id: "sep-open", separator: true, label: "" },
      {
        id: "edit",
        label: t("files.context.edit"),
        onClick: () => openEditConnectionDialog(conn.id),
      },
      {
        id: "test",
        label: t("files.context.test"),
        onClick: () => void handleTestConnection(conn.id),
      },
      { id: "sep1", separator: true, label: "" },
      {
        id: "delete",
        label: t("files.context.deleteConn"),
        danger: true,
        onClick: () => void handleDeleteConnection(conn),
      },
    ];
  }, [
    ctxMenu,
    handleBuildIndex,
    handleClearIndex,
    handleDeleteConnection,
    handleTestConnection,
    indexStatuses,
    openConnectionPanel,
    t,
  ]);

  const handleFavoriteOpen = useCallback((
    favorite: FileFavorite,
    mode: FileDockOpenMode,
  ) => {
    const conn = connections.find((c) => c.id === favorite.connectionId);
    if (!conn) {
      showToast(t("files.sidebar.favoriteMissingConn"));
      return;
    }
    navigateConnectionToPath(favorite.connectionId, favorite.path, mode);
  }, [connections, navigateConnectionToPath, t]);

  const handleToggleFavoritePin = useCallback((favorite: FileFavorite) => {
    const next = !(favorite.pinned === true);
    setFavoritePinned(favorite.id, next);
    showToast(
      next ? t("files.sidebar.pinFavoriteDone") : t("files.sidebar.unpinFavoriteDone"),
    );
  }, [setFavoritePinned, t]);

  const handleFavoriteContextMenu = (e: React.MouseEvent, favorite: FileFavorite) => {
    e.preventDefault();
    e.stopPropagation();
    setFavCtxMenu({ x: e.clientX, y: e.clientY, favorite });
  };

  const favCtxItems = useMemo((): ContextMenuItem[] => {
    if (!favCtxMenu) return [];
    const favorite = favCtxMenu.favorite;
    return [
      {
        id: "open-preview",
        label: t("files.context.open"),
        onClick: () => handleFavoriteOpen(favorite, "preview"),
      },
      {
        id: "open-pinned",
        label: t("files.sidebar.openPinned"),
        onClick: () => handleFavoriteOpen(favorite, "permanent"),
      },
      { id: "sep1", separator: true, label: "" },
      {
        id: "rename",
        label: t("files.sidebar.favoriteRename"),
        onClick: () => {
          void (async () => {
            const next = await quickInput({
              title: t("files.sidebar.favoriteRenameTitle"),
              defaultValue: favorite.label,
              placeholder: t("files.sidebar.favoriteRenamePlaceholder"),
              validate: (v) => (v.trim() ? null : t("files.sidebar.favoriteRenamePlaceholder")),
            });
            if (!next?.trim()) return;
            renameFavorite(favorite.id, next.trim());
          })();
        },
      },
      {
        id: "delete",
        label: t("files.sidebar.favoriteDelete"),
        danger: true,
        onClick: () => {
          removeFavorite(favorite.id);
          showToast(t("files.sidebar.favoriteRemoved"));
        },
      },
    ];
  }, [favCtxMenu, handleFavoriteOpen, removeFavorite, renameFavorite, t]);

  const registerNavigate = useCallback((
    connId: string,
    navigate: ((path: string) => void) | null,
  ) => {
    if (navigate) {
      activeNavigateRef.current = navigate;
      activeNavigateConnIdRef.current = connId;
      const pending = pendingNavigateRef.current;
      if (pending && pending.connId === connId) {
        navigate(pending.path);
        pendingNavigateRef.current = null;
      }
      return;
    }
    if (activeNavigateConnIdRef.current === connId) {
      activeNavigateRef.current = null;
      activeNavigateConnIdRef.current = null;
    }
  }, []);

  const handleQuickNavigate = useCallback((path: string) => {
    navigateConnectionToPath(LOCAL_CONNECTION_ID, path, "preview");
  }, [navigateConnectionToPath]);

  const handlePanelTransferredOut = useCallback(
    (panelId: string, targetScope: string) => {
      if (!targetScope.startsWith("workspace-bottom-")) return;
      const connId = parseFileConnPanelId(panelId);
      if (!connId) return;
      // 拖入工作区：标记 workspaceOnly，从布局移除，保留连接以便拖回时恢复
      setConnectionWorkspaceOnly(connId, true);
      setSavedLayout(removeFileTabFromLayout(savedLayout, panelId));
    },
    [savedLayout, setConnectionWorkspaceOnly, setSavedLayout],
  );

  const performMoveTabToWorkspace = useCallback(
    (tabId: string, targetWorkspaceId: string) => {
      if (!targetWorkspaceId) return;
      const connId = parseFileConnPanelId(tabId);
      if (!connId) return;
      if (workspaceOnlyConnIds.includes(connId)) return;

      const conn = connections.find((c) => c.id === connId);
      if (!conn) return;

      // 标记 workspaceOnly + 从布局移除
      setConnectionWorkspaceOnly(connId, true);
      setSavedLayout(removeFileTabFromLayout(savedLayout, tabId));

      // 投递镜像 tab 到目标工作区
      const dockScope = `workspace-bottom-${targetWorkspaceId}`;
      void deliverMirroredTabToWorkspace(targetWorkspaceId, {
        id: `${dockScope}:${tabId}`,
        label: conn.name,
        originScope: "files-browser",
        originPanelId: tabId,
        panelType: "file-connection",
        closable: true,
      });

      setTabCtxMenu(null);
    },
    [connections, savedLayout, setConnectionWorkspaceOnly, setSavedLayout, workspaceOnlyConnIds],
  );

  const handleDockTabContextMenu = useCallback(
    (event: React.MouseEvent, tabId: string, index: number) => {
      event.preventDefault();
      setTabCtxMenu({ x: event.clientX, y: event.clientY, tabId, index });
    },
    [],
  );

  const handleContextAction = useCallback(
    (action: TabContextMenuAction) => {
      if (!tabCtxMenu) return;
      const { tabId } = tabCtxMenu;
      const visibleTabs = dockTabs;
      const idx = visibleTabs.findIndex((tab) => tab.id === tabId);

      if (action === "close") {
        handleCloseTab(tabId);
      } else if (action === "closeLeft") {
        if (idx > 0) {
          for (const tab of visibleTabs.slice(0, idx)) {
            handleCloseTab(tab.id);
          }
        }
      } else if (action === "closeRight") {
        if (idx >= 0 && idx < visibleTabs.length - 1) {
          for (const tab of visibleTabs.slice(idx + 1)) {
            handleCloseTab(tab.id);
          }
        }
      } else if (action === "closeOthers") {
        if (idx >= 0) {
          for (const tab of visibleTabs.filter((t) => t.id !== tabId)) {
            handleCloseTab(tab.id);
          }
        }
      } else if (action === "closeAll") {
        for (const tab of visibleTabs) {
          handleCloseTab(tab.id);
        }
      }
      setTabCtxMenu(null);
    },
    [dockTabs, handleCloseTab, tabCtxMenu],
  );

  // 监听跨 dockview 实例拖拽转移：从工作区 dock 拖回文件主面板时恢复 tab
  useEffect(() => {
    return subscribeDockviewTransfer((meta) => {
      if (!meta.newPanelId.startsWith("files-browser:")) return;
      if (!meta.originScope.startsWith("workspace-bottom-")) return;

      // 从 originPanelId 中解析出原始文件 tab id
      // workspace dock 中 panel id 格式: "workspace-bottom-{wsId}:{原始tabId}"
      const prefix = `${meta.originScope}:`;
      const originalTabId = meta.originPanelId.startsWith(prefix)
        ? meta.originPanelId.slice(prefix.length)
        : meta.originPanelId;
      const connId = parseFileConnPanelId(originalTabId);
      if (!connId) return;

      // 恢复 workspaceOnly = false，让 tab 重新在主面板可见
      setConnectionWorkspaceOnly(connId, false);
      setActivePanelId(originalTabId);
      requestAnimationFrame(() => relayoutDockviewInstances("files-browser"));
    });
  }, [setActivePanelId, setConnectionWorkspaceOnly]);

  // 监听跨窗「移动到主窗口」恢复事件
  useEffect(() => {
    const handleRestore = (e: Event) => {
      const detail = (e as CustomEvent<{ connId: string }>).detail;
      if (!detail?.connId) return;
      const connId = detail.connId;
      // 确保连接已打开
      const store = useFilesWorkspaceSessionStore.getState();
      if (!store.openConnIds.includes(connId)) {
        store.openConnection(connId, "permanent");
      } else {
        store.setConnectionWorkspaceOnly(connId, false);
        if (store.previewConnId === connId) {
          store.promotePreview(connId);
        }
      }
      store.setActivePanelId(fileConnPanelId(connId));
      patchDockTabPreviewMeta(fileConnPanelId(connId), false);
      requestAnimationFrame(() => relayoutDockviewInstances("files-browser"));
    };
    window.addEventListener("omnipanel:restore-files-workspace-tab", handleRestore);
    return () => {
      window.removeEventListener("omnipanel:restore-files-workspace-tab", handleRestore);
    };
  }, []);

  // 离开路由时关闭 tab 右键菜单
  useEffect(() => {
    if (!isActiveRoute) {
      setTabCtxMenu(null);
    }
  }, [isActiveRoute]);

  const renderDockPanel = useCallback(
    (panelId: string) => {
      const connId = parseFileConnPanelId(panelId);
      if (!connId) return null;
      const conn = connections.find((c) => c.id === connId);
      if (!conn) return null;
      return (
        <FileConnectionPanel
          connection={conn}
          quickPaths={quickPaths}
          localSystemInfo={localSystemInfo}
          isActive={activePanelId === panelId}
          savedState={panelStates[connId] ?? null}
          onPatchStatus={patchConnectionStatus}
          onRegisterNavigate={(navigate) => registerNavigate(connId, navigate)}
        />
      );
    },
    [activePanelId, connections, localSystemInfo, panelStates, patchConnectionStatus, quickPaths, registerNavigate],
  );

  if (!sessionHydrated) {
    return null;
  }

  const filesAiContext = {
    connectionId: sidebarActiveId,
    connectionName:
      connections.find((c) => c.id === sidebarActiveId)?.name ??
      (sidebarActiveId === LOCAL_CONNECTION_ID ? "本机" : null),
    currentPath: panelStates[sidebarActiveId]?.currentPath ?? null,
  };

  return (
    <>
      <FilesModuleContextBridge active={isActiveRoute} context={filesAiContext} />
      <ModuleWorkspaceLayout
        className="files-workspace"
        leftColumnTitle={t("routes.files")}
        leftPreset="schema"
        tagModuleKey="files"
        leftHeaderActions={<ModuleLeftHeaderActions moduleKey="files" />}
        leftIconRail={
          <ModuleModeIconRail
            items={modeIconItems}
            activeId="browser"
            onChange={() => {}}
          />
        }
        leftSidebar={
          <FilesSidebar
            connections={visibleConnections}
            activeId={sidebarActiveId}
            openConnIds={openConnIds}
            quickPaths={quickPaths}
            favorites={favorites}
            syncingSshSftp={syncingSshSftp}
            onPreviewConnection={(conn) => openConnectionPanel(conn, "preview")}
            onPinConnection={(conn) => openConnectionPanel(conn, "permanent")}
            onConnContextMenu={handleConnContextMenu}
            onAddConnection={openNewConnectionDialog}
            onSyncSshSftp={() => void handleSyncSshSftp()}
            onQuickNavigate={handleQuickNavigate}
            onFavoriteOpen={handleFavoriteOpen}
            onFavoriteContextMenu={handleFavoriteContextMenu}
            onToggleFavoritePin={handleToggleFavoritePin}
          />
        }
        footer={
          transfers.length > 0 ? (
            <div className="fm-transfers">
              <span className="transfer-label">{t("files.transfers.title")}</span>
              {transfers.slice(0, 6).map((item) => {
                const routeLabel =
                  item.route === "fastpath"
                    ? t("files.transfers.routeFastpath")
                    : item.route === "remoteDirect"
                      ? t("files.transfers.routeDirect")
                      : t("files.transfers.routeRelay");
                return (
                  <span key={item.id} className={`fm-transfer-item transfer-${item.state}`}>
                    <span className="transfer-name" title={`${item.source.name} → ${item.dest.path}`}>
                      {item.source.name}
                      <span className="transfer-route"> · {routeLabel}</span>
                    </span>
                    <span className="transfer-progress">
                      <span
                        className="transfer-progress-fill"
                        style={{ width: `${Math.max(0, Math.min(100, item.progress))}%` }}
                      />
                    </span>
                    <span className="transfer-pct">
                      {item.state === "error" || item.state === "cancelled"
                        ? "!"
                        : item.state === "done"
                          ? "✓"
                          : `${Math.round(item.progress)}%`}
                    </span>
                    {(item.state === "running" || item.state === "queued") && (
                      <button
                        type="button"
                        className="transfer-cancel"
                        title={t("files.transfers.cancel")}
                        onClick={() => void cancelTransfer(item.id)}
                      >
                        ×
                      </button>
                    )}
                    {(item.state === "error" || item.state === "cancelled") && (
                      <button
                        type="button"
                        className="transfer-cancel"
                        title={t("files.transfers.retry")}
                        onClick={() => void retryTransfer(item.id)}
                      >
                        ↻
                      </button>
                    )}
                  </span>
                );
              })}
              <span className="transfer-spacer" />
              <button
                type="button"
                className="transfer-toggle"
                onClick={() => void clearDoneTransfers()}
              >
                {t("files.transfers.clear")}
              </button>
            </div>
          ) : undefined
        }
      >
        <div className="fm-main">
          {connBanner && (
            <div className={connBanner.kind === "error" ? "fm-error-banner" : "fm-info-banner"}>
              {connBanner.text}
            </div>
          )}
          <div
            className="fm-workspace-drop-zone"
            onDragOver={handleWorkspaceDragOver}
            onDragLeave={handleWorkspaceDragLeave}
            onDrop={handleWorkspaceDrop}
          >
            <ModuleSegmentDock
              className="files-module-dock fm-dock-workspace fm-workspace"
              variant="workspace"
              dockScope="files-browser"
              moduleTitle={t("routes.files")}
              enabled={isActiveRoute}
              contentSuspended={!isActiveRoute}
              stickyVisit
              windowControl
              tabs={dockTabs}
              activeTabId={activePanelId ?? ""}
              onActiveTabChange={setActivePanelId}
              onCloseTab={handleCloseTab}
              onTabDoubleClick={handlePromotePreviewTab}
              onTabContextMenu={handleDockTabContextMenu}
              onPanelTransferredOut={handlePanelTransferredOut}
              acceptExternalDrops
              savedLayout={savedLayout}
              onSavedLayoutChange={setSavedLayout}
              renderPanel={renderDockPanel}
              softRefreshKey={openConnIds
                .map((id) => {
                  const c = storedConnections.find((x) => x.id === id);
                  return `${id}@${c?.updatedAt ?? 0}@${previewConnId === id ? "p" : "f"}`;
                })
                .join("|")}
              emptyContent={
                <WorkspaceEmptyPage
                  title={t("routes.files")}
                  prompt={t("files.workspace.emptyTabs")}
                />
              }
            />
          </div>
        </div>
      </ModuleWorkspaceLayout>

      <FileConnectionDialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setEditConnection(undefined);
          setDialogInitialProtocol(undefined);
          setDialogInitialSshId(undefined);
        }}
        editConnection={editConnection}
        initialProtocol={dialogInitialProtocol}
        initialSshConnectionId={dialogInitialSshId}
        onSaved={(saved) => void handleSavedConnection(saved)}
        onTestSuccess={(connId) => patchConnectionStatus(connId, "online")}
      />

      {ctxMenu && (
        <ContextMenu
          items={connCtxItems}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {favCtxMenu && (
        <ContextMenu
          items={favCtxItems}
          position={{ x: favCtxMenu.x, y: favCtxMenu.y }}
          onClose={() => setFavCtxMenu(null)}
        />
      )}

      {isActiveRoute && tabCtxMenu && (() => {
        const visibleDockTabs = dockTabs;
        const menuTabIndex = visibleDockTabs.findIndex((tab) => tab.id === tabCtxMenu.tabId);
        const closeItems = buildTabCloseMenuItems(
          t,
          visibleDockTabs.length,
          menuTabIndex >= 0 ? menuTabIndex : 0,
          handleContextAction,
          {
            showWorkspaceActions: true,
            currentWorkspaceId: activeWorkspaceId,
            workspaces,
            onMoveToWorkspace: (workspaceId) =>
              performMoveTabToWorkspace(tabCtxMenu.tabId, workspaceId),
          },
        );
        return (
          <ContextMenu
            items={closeItems}
            position={{ x: tabCtxMenu.x, y: tabCtxMenu.y }}
            onClose={() => setTabCtxMenu(null)}
          />
        );
      })()}
    </>
  );
}

export function FilesPanel() {
  return <FilesBrowserView />;
}

