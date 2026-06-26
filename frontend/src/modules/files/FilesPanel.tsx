import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useLocation } from "react-router-dom";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/ContextMenu";
import { SidebarWorkspace } from "../../components/ui/SidebarWorkspace";
import { ModuleSegmentDock, type DockableTab } from "../../components/dock";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import type { Connection, FileIndexProgress, FileIndexStatus, FileManagerConnectionInfo } from "../../ipc/bindings";
import { useConnectionStore } from "../../stores/connectionStore";
import { useFileManagerStore } from "../../stores/fileManagerStore";
import { useFilesWorkspaceSessionStore } from "../../stores/filesWorkspaceSessionStore";
import { FileConnectionDialog, type FileProtocol } from "./FileConnectionDialog";
import { FileConnectionPanel } from "./FileConnectionPanel";
import { FilesSidebar } from "./FilesSidebar";
import { FilesWorkspaceDock } from "./FilesWorkspaceDock";
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
  loadQuickPaths,
  testFileConnection,
} from "./fileApi";
import { LOCAL_CONNECTION_ID } from "./utils";

type ConnCtxState = { x: number; y: number; conn: FileManagerConnectionInfo } | null;

type FilesModuleTab = "browser";
const FILES_TABS: FilesModuleTab[] = ["browser"];

function FilesBrowserView() {
  const { t } = useI18n();
  const refreshConnections = useConnectionStore((s) => s.refresh);
  const removeConnection = useConnectionStore((s) => s.remove);
  const storedConnections = useConnectionStore((s) => s.connections);
  const transfers = useFileManagerStore((s) => s.transfers);
  const clearDoneTransfers = useFileManagerStore((s) => s.clearDoneTransfers);

  const openConnIds = useFilesWorkspaceSessionStore((s) => s.openConnIds);
  const activePanelId = useFilesWorkspaceSessionStore((s) => s.activePanelId);
  const savedLayout = useFilesWorkspaceSessionStore((s) => s.savedLayout);
  const panelStates = useFilesWorkspaceSessionStore((s) => s.panelStates);
  const setSavedLayout = useFilesWorkspaceSessionStore((s) => s.setSavedLayout);
  const setActivePanelId = useFilesWorkspaceSessionStore((s) => s.setActivePanelId);
  const openConnection = useFilesWorkspaceSessionStore((s) => s.openConnection);
  const closeConnection = useFilesWorkspaceSessionStore((s) => s.closeConnection);
  const pruneMissingConnections = useFilesWorkspaceSessionStore((s) => s.pruneMissingConnections);

  const [sessionHydrated, setSessionHydrated] = useState(
    () => useFilesWorkspaceSessionStore.persist.hasHydrated(),
  );
  const [connections, setConnections] = useState<FileManagerConnectionInfo[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogInitialProtocol, setDialogInitialProtocol] = useState<FileProtocol | undefined>();
  const [editConnection, setEditConnection] = useState<Connection | undefined>();
  const [ctxMenu, setCtxMenu] = useState<ConnCtxState>(null);
  const [quickPaths, setQuickPaths] = useState<{
    home: string;
    desktop: string;
    documents: string;
    downloads: string;
  } | null>(null);
  const [connBanner, setConnBanner] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [indexStatuses, setIndexStatuses] = useState<Record<string, FileIndexStatus>>({});
  const activeNavigateRef = useRef<((path: string) => void) | null>(null);
  const bootstrappedDefaultRef = useRef(false);

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
    openConnection(conn.id);
  }, [openConnection]);

  const handleCloseTab = useCallback((tabId: string) => {
    const connId = parseFileConnPanelId(tabId);
    if (!connId) return;
    closeConnection(connId);
  }, [closeConnection]);

  const dockTabs = useMemo((): DockableTab[] => {
    const tabs: DockableTab[] = [];
    for (const connId of openConnIds) {
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
  }, [connections, openConnIds]);

  useEffect(() => {
    void loadConnections();
    void loadQuickPaths().then(setQuickPaths).catch(() => undefined);
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
          indexedCount,
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

  const openNewConnectionDialog = (protocol?: FileProtocol) => {
    setEditConnection(undefined);
    setDialogInitialProtocol(protocol);
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
          isActive={activePanelId === panelId}
          savedState={panelStates[connId] ?? null}
          onPatchStatus={patchConnectionStatus}
          onRegisterNavigate={registerNavigate}
        />
      );
    },
    [activePanelId, connections, panelStates, patchConnectionStatus, quickPaths, registerNavigate],
  );

  if (!sessionHydrated) {
    return null;
  }

  return (
    <>
      <SidebarWorkspace
        preset="schema"
        layoutPersistKey="files-sidebar"
        sidebarMinPx={280}
        className="files-workspace dock-workspace"
        sidebar={
          <FilesSidebar
            connections={connections}
            activeId={sidebarActiveId}
            quickPaths={quickPaths}
            onSelectConnection={openConnectionPanel}
            onConnContextMenu={handleConnContextMenu}
            onAddConnection={openNewConnectionDialog}
            onQuickNavigate={(path) => activeNavigateRef.current?.(path)}
          />
        }
      >
        <div className="fm-main">
          {connBanner && (
            <div className={connBanner.kind === "error" ? "fm-error-banner" : "fm-info-banner"}>
              {connBanner.text}
            </div>
          )}
          <div className="fm-workspace-drop-zone">
            <FilesWorkspaceDock
              dockTabs={dockTabs}
              activePanelId={activePanelId}
              onActivePanelChange={setActivePanelId}
              onCloseTab={handleCloseTab}
              dockLayout={savedLayout}
              onDockLayoutChange={setSavedLayout}
              renderPanel={renderDockPanel}
              softRefreshKey={openConnIds.join("|")}
            />
          </div>

          {transfers.length > 0 && (
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
          )}
        </div>
      </SidebarWorkspace>

      <FileConnectionDialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setEditConnection(undefined);
          setDialogInitialProtocol(undefined);
        }}
        editConnection={editConnection}
        initialProtocol={dialogInitialProtocol}
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
    </>
  );
}

export function FilesPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/files";
  const [tab, setTab] = usePersistedModuleTab("files", "browser", FILES_TABS);

  const segmentTabs = useMemo(
    () => [{ id: "browser", label: t("files.tabs.browser") }],
    [t],
  );

  const renderPanel = useCallback((tabId: string) => {
    if (tabId === "browser") {
      return <FilesBrowserView />;
    }
    return null;
  }, []);

  return (
    <ModuleSegmentDock
      className="files-module-dock"
      tabs={segmentTabs}
      activeTabId={tab}
      onActiveTabChange={(id) => setTab(id as FilesModuleTab)}
      enabled={isActiveRoute}
      renderPanel={renderPanel}
    />
  );
}

