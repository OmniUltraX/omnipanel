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
import {
  ModuleModeIconRail,
  ModuleWorkspaceLayout,
} from "../../components/workspace";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { useI18n } from "../../i18n";
import { migrateLayoutStorage } from "../../lib/layoutMigration";
import { appConfirm } from "../../lib/appConfirm";
import { subscribeDockviewTransfer, relayoutDockviewInstances } from "../../lib/dockviewRegistry";
import { deliverMirroredTabToWorkspace } from "../../lib/workspaceSnapshotDelivery";
import { removeFileTabFromLayout } from "../../stores/filesWorkspaceSessionStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { Connection, FileIndexStatus, FileLocalSystemInfo, FileManagerConnectionInfo } from "../../ipc/bindings";
import type { FileIndexProgress } from "./fileApi";
import { useConnectionStore } from "../../stores/connectionStore";
import { useFileManagerStore } from "../../stores/fileManagerStore";
import { useFilesWorkspaceSessionStore } from "../../stores/filesWorkspaceSessionStore";
import { FileConnectionDialog, type FileProtocol } from "./FileConnectionDialog";
import { FileConnectionPanel } from "./FileConnectionPanel";
import { FilesSidebar } from "./FilesSidebar";
import { CONNECTION_TAG_KINDS } from "../tags/tagKinds";
import { passTagFilter, useModuleTagFilter } from "../tags/useModuleTagFilter";
import {
  fileConnPanelId,
  fileProtocolDockIcon,
  parseFileConnPanelId,
} from "./filesWorkspacePanels";
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
import { LOCAL_CONNECTION_ID } from "./utils";
import { FilesModuleContextBridge } from "./ai/FilesModuleContextBridge";

type ConnCtxState = { x: number; y: number; conn: FileManagerConnectionInfo } | null;

function FilesBrowserView() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/files";
  const refreshConnections = useConnectionStore((s) => s.refresh);
  const removeConnection = useConnectionStore((s) => s.remove);
  const storedConnections = useConnectionStore((s) => s.connections);
  const transfers = useFileManagerStore((s) => s.transfers);
  const clearDoneTransfers = useFileManagerStore((s) => s.clearDoneTransfers);

  const openConnIds = useFilesWorkspaceSessionStore((s) => s.openConnIds);
  const activePanelId = useFilesWorkspaceSessionStore((s) => s.activePanelId);
  const savedLayout = useFilesWorkspaceSessionStore((s) => s.savedLayout);
  const panelStates = useFilesWorkspaceSessionStore((s) => s.panelStates);
  const workspaceOnlyConnIds = useFilesWorkspaceSessionStore((s) => s.workspaceOnlyConnIds);
  const setSavedLayout = useFilesWorkspaceSessionStore((s) => s.setSavedLayout);
  const setActivePanelId = useFilesWorkspaceSessionStore((s) => s.setActivePanelId);
  const openConnection = useFilesWorkspaceSessionStore((s) => s.openConnection);
  const closeConnection = useFilesWorkspaceSessionStore((s) => s.closeConnection);
  const pruneMissingConnections = useFilesWorkspaceSessionStore((s) => s.pruneMissingConnections);
  const setConnectionWorkspaceOnly = useFilesWorkspaceSessionStore((s) => s.setConnectionWorkspaceOnly);
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
  const [ctxMenu, setCtxMenu] = useState<ConnCtxState>(null);
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
  const bootstrappedDefaultRef = useRef(false);
  const sftpDeepLinkHandledRef = useRef(false);

  // 处理从 SSH 模块跳转过来的 SFTP 深链接
  useEffect(() => {
    if (sftpDeepLinkHandledRef.current) return;
    const state = location.state as { openSftpForSshId?: string; openSftpHostName?: string } | null;
    if (!state?.openSftpForSshId) return;
    sftpDeepLinkHandledRef.current = true;
    openNewConnectionDialog("sftp", state.openSftpForSshId);
    // 清除 state，防止刷新时重复触发
    window.history.replaceState({}, "");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

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

  const openConnectionPanel = useCallback((conn: FileManagerConnectionInfo) => {
    openDockTabNow({
      applyTabSync: () => openConnection(conn.id),
    });
  }, [openConnection]);

  const handleCloseTab = useCallback((tabId: string) => {
    const connId = parseFileConnPanelId(tabId);
    if (!connId) return;
    closeDockTabNow({
      removeTabSync: () => closeConnection(connId),
    });
  }, [closeConnection]);

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
      });
    }
    return tabs;
  }, [connections, openConnIds, workspaceOnlyConnIds]);

  useEffect(() => {
    void loadConnections();
    void loadQuickPaths().then(setQuickPaths).catch(() => undefined);
    void loadLocalSystemInfo().then(setLocalSystemInfo).catch(() => undefined);
    void refreshConnections();
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
      openConnection(local.id);
    }
  }, [sessionHydrated, connections, openConnIds.length, openConnection]);

  const handleSavedConnection = useCallback(async () => {
    setEditConnection(undefined);
    await refreshConnections();
    await loadConnections();
  }, [loadConnections, refreshConnections]);

  const openNewConnectionDialog = (protocol?: FileProtocol, sshConnectionId?: string) => {
    setEditConnection(undefined);
    setDialogInitialProtocol(protocol);
    setDialogInitialSshId(sshConnectionId);
    setDialogOpen(true);
  };

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
      await loadConnections();
      if (openConnIds.includes(conn.id)) {
        handleCloseTab(fileConnPanelId(conn.id));
      }
    } catch (e) {
      setConnBanner({ kind: "error", text: fmtError(e) });
    }
  }, [handleCloseTab, loadConnections, openConnIds, removeConnection, t]);

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
      return indexItems;
    }
    return [
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
  }, [ctxMenu, handleBuildIndex, handleClearIndex, handleDeleteConnection, handleTestConnection, indexStatuses, t]);

  const registerNavigate = useCallback((navigate: ((path: string) => void) | null) => {
    activeNavigateRef.current = navigate;
  }, []);

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
        store.openConnection(connId);
      } else {
        store.setConnectionWorkspaceOnly(connId, false);
      }
      store.setActivePanelId(fileConnPanelId(connId));
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
          onRegisterNavigate={registerNavigate}
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
            quickPaths={quickPaths}
            onSelectConnection={openConnectionPanel}
            onConnContextMenu={handleConnContextMenu}
            onAddConnection={openNewConnectionDialog}
            onQuickNavigate={(path) => activeNavigateRef.current?.(path)}
          />
        }
        footer={
          transfers.length > 0 ? (
            <div className="fm-transfers">
              <span className="transfer-label">{t("files.transfers.title")}</span>
              {transfers.map((item) => (
                <span key={item.id} className={`fm-transfer-item transfer-${item.status}`}>
                  <span className="transfer-name">{item.name}</span>
                  <span className="transfer-progress">
                    <span className="transfer-progress-fill" style={{ width: `${item.progress}%` }} />
                  </span>
                  <span className="transfer-pct">{item.status === "error" ? "!" : `${item.progress}%`}</span>
                </span>
              ))}
              <span className="transfer-spacer" />
              <button type="button" className="transfer-toggle" onClick={clearDoneTransfers}>
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
          <div className="fm-workspace-drop-zone">
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
              onTabContextMenu={handleDockTabContextMenu}
              onPanelTransferredOut={handlePanelTransferredOut}
              acceptExternalDrops
              savedLayout={savedLayout}
              onSavedLayoutChange={setSavedLayout}
              renderPanel={renderDockPanel}
              softRefreshKey={openConnIds.join("|")}
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
        onSaved={() => void handleSavedConnection()}
        onTestSuccess={(connId) => patchConnectionStatus(connId, "online")}
      />

      {ctxMenu && (
        <ContextMenu
          items={connCtxItems}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
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

