import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/ContextMenu";
import { FileEntryIcon } from "../../components/ui/FileEntryIcon";
import { ModuleEmptyState } from "../../components/ui/ModuleEmptyState";
import { SidebarWorkspace } from "../../components/ui/SidebarWorkspace";
import { useI18n } from "../../i18n";
import type { Connection, FileEntry, FileManagerConnectionInfo } from "../../ipc/bindings";
import { useConnectionStore } from "../../stores/connectionStore";
import { useFileManagerStore } from "../../stores/fileManagerStore";
import { quickInput } from "../../stores/quickInputStore";
import { FileConnectionDialog } from "./FileConnectionDialog";
import { FilesSidebar } from "./FilesSidebar";
import {
  IconGridView,
  IconListView,
  IconNavBack,
  IconNavForward,
  IconNavUp,
  IconNewFolder,
  IconRefresh,
  IconSearch,
  IconUpload,
} from "./FilesPanelIcons";
import {
  deleteRemote,
  downloadRemote,
  fmtError,
  listDirectory,
  listFileConnections,
  loadQuickPaths,
  mkdirRemote,
  readRemotePreview,
  renameRemote,
  testFileConnection,
  uploadRemote,
} from "./fileApi";
import {
  fileTypeLabel,
  formatFileSize,
  formatFileTime,
  joinRemotePath,
  LOCAL_CONNECTION_ID,
  parentPath,
} from "./utils";

type ViewMode = "list" | "grid";

type FileCtxState = { kind: "file"; x: number; y: number; entry: FileEntry };
type ConnCtxState = { kind: "conn"; x: number; y: number; conn: FileManagerConnectionInfo };
type CtxState = FileCtxState | ConnCtxState | null;

function splitBreadcrumb(path: string, protocol: string): { label: string; path: string }[] {
  if (!path) return [{ label: protocol === "local" ? "~" : "/", path: "" }];
  if (protocol === "local") {
    const sep = path.includes("\\") ? "\\" : "/";
    const parts = path.split(sep).filter(Boolean);
    const out: { label: string; path: string }[] = [];
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      if (i === 0 && parts[0].endsWith(":")) {
        acc = `${parts[0]}${sep}`;
        out.push({ label: parts[0], path: acc });
        continue;
      }
      acc = acc ? `${acc}${sep}${parts[i]}` : `${sep}${parts[i]}`;
      out.push({ label: parts[i], path: acc });
    }
    return out.length ? out : [{ label: path, path }];
  }
  if (protocol === "s3") {
    const trimmed = path.replace(/^\/+/, "");
    if (!trimmed) return [{ label: "/", path: "" }];
    const parts = trimmed.split("/").filter(Boolean);
    let acc = "";
    return parts.map((part) => {
      acc = acc ? `${acc}${part}/` : `${part}/`;
      return { label: part, path: acc };
    });
  }
  const parts = path.split("/").filter(Boolean);
  const out: { label: string; path: string }[] = [{ label: "/", path: "/" }];
  let acc = "/";
  for (const part of parts) {
    acc = acc === "/" ? `/${part}` : `${acc}/${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}

function isTextPreview(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return [
    "txt", "md", "json", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf",
    "js", "ts", "tsx", "jsx", "css", "html", "rs", "go", "py", "sh", "sql", "log",
  ].includes(ext);
}

function decodePreview(bytes: number[]): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
  } catch {
    return "";
  }
}

export function FilesPanel() {
  const { t } = useI18n();
  const refreshConnections = useConnectionStore((s) => s.refresh);
  const removeConnection = useConnectionStore((s) => s.remove);
  const storedConnections = useConnectionStore((s) => s.connections);
  const transfers = useFileManagerStore((s) => s.transfers);
  const addTransfer = useFileManagerStore((s) => s.addTransfer);
  const updateTransfer = useFileManagerStore((s) => s.updateTransfer);
  const clearDoneTransfers = useFileManagerStore((s) => s.clearDoneTransfers);

  const [connections, setConnections] = useState<FileManagerConnectionInfo[]>([]);
  const [activeId, setActiveId] = useState(LOCAL_CONNECTION_ID);
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editConnection, setEditConnection] = useState<Connection | undefined>();
  const [ctxMenu, setCtxMenu] = useState<CtxState>(null);
  const [quickPaths, setQuickPaths] = useState<{ home: string; desktop: string; documents: string; downloads: string } | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const loadSeq = useRef(0);

  const activeConn = useMemo(
    () => connections.find((c) => c.id === activeId) ?? null,
    [connections, activeId],
  );
  const protocol = activeConn?.protocol ?? "local";

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, search]);

  const groupedConnections = useMemo(() => {
    const groups = new Map<string, FileManagerConnectionInfo[]>();
    for (const conn of connections) {
      const g = conn.group || t("files.groups.other");
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(conn);
    }
    return Array.from(groups.entries());
  }, [connections, t]);

  const loadConnections = useCallback(async () => {
    try {
      const list = await listFileConnections();
      setConnections(list);
    } catch (e) {
      setError(fmtError(e));
    }
  }, []);

  const loadDir = useCallback(async (path: string, connId = activeId) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const list = await listDirectory(connId, path);
      if (seq !== loadSeq.current) return;
      setEntries(list);
      setCurrentPath(path);
      setSelected(null);
      setPreviewText(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(fmtError(e));
      setEntries([]);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [activeId]);

  const navigateTo = useCallback((path: string, pushHistory = true) => {
    if (pushHistory) {
      setHistory((prev) => {
        const base = prev.slice(0, historyIndex + 1);
        return [...base, path];
      });
      setHistoryIndex((i) => i + 1);
    }
    void loadDir(path);
  }, [historyIndex, loadDir]);

  const selectConnection = useCallback(async (conn: FileManagerConnectionInfo) => {
    setActiveId(conn.id);
    setHistory([]);
    setHistoryIndex(-1);
    setSearch("");
    let initial = "";
    if (conn.protocol === "local") {
      try {
        const qp = quickPaths ?? (await loadQuickPaths());
        if (!quickPaths) setQuickPaths(qp);
        initial = qp.home;
      } catch {
        initial = "";
      }
    } else if (conn.protocol === "s3") {
      initial = "";
    } else {
      initial = "";
    }
    setHistory([initial]);
    setHistoryIndex(0);
    await loadDir(initial, conn.id);
  }, [loadDir, quickPaths]);

  useEffect(() => {
    void loadConnections();
    void loadQuickPaths().then(setQuickPaths).catch(() => undefined);
    void refreshConnections();
  }, [loadConnections, refreshConnections]);

  useEffect(() => {
    if (connections.length === 0) return;
    const local = connections.find((c) => c.id === LOCAL_CONNECTION_ID);
    if (local && activeId === LOCAL_CONNECTION_ID && !currentPath && !loading) {
      void selectConnection(local);
    }
  }, [connections, activeId, currentPath, loading, selectConnection]);

  useEffect(() => {
    if (!selected || selected.kind !== "file" || !isTextPreview(selected.name)) {
      setPreviewText(null);
      return;
    }
    let cancelled = false;
    void readRemotePreview(activeId, selected.path, 256 * 1024)
      .then((bytes) => {
        if (!cancelled) setPreviewText(decodePreview(bytes));
      })
      .catch(() => {
        if (!cancelled) setPreviewText(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, activeId]);

  const handleUpload = useCallback(async () => {
    const picked = await openFileDialog({ multiple: true });
    if (!picked) return;
    const files = Array.isArray(picked) ? picked : [picked];
    for (const localPath of files) {
      const name = localPath.split(/[/\\]/).pop() ?? localPath;
      const remotePath = joinRemotePath(currentPath, name, protocol);
      const xferId = addTransfer(name);
      try {
        updateTransfer(xferId, { progress: 10 });
        const bytes = await readRemotePreview(LOCAL_CONNECTION_ID, localPath, 512 * 1024 * 1024);
        updateTransfer(xferId, { progress: 50 });
        await uploadRemote(activeId, remotePath, bytes);
        updateTransfer(xferId, { progress: 100, status: "done" });
      } catch (e) {
        updateTransfer(xferId, { status: "error", error: fmtError(e) });
      }
    }
    void loadDir(currentPath);
  }, [activeId, addTransfer, currentPath, loadDir, protocol, updateTransfer]);

  const handleDownload = useCallback(async (entry: FileEntry) => {
    if (entry.kind === "dir") return;
    const savePath = await saveFileDialog({ defaultPath: entry.name });
    if (!savePath) return;
    const xferId = addTransfer(entry.name);
    try {
      updateTransfer(xferId, { progress: 20 });
      await downloadRemote(activeId, entry.path, savePath);
      updateTransfer(xferId, { progress: 100, status: "done" });
    } catch (e) {
      updateTransfer(xferId, { status: "error", error: fmtError(e) });
    }
  }, [activeId, addTransfer, updateTransfer]);

  const handleMkdir = useCallback(async () => {
    const name = await quickInput({
      title: t("files.actions.mkdir"),
      placeholder: t("files.actions.mkdirPlaceholder"),
      validate: (v) => (v.trim() ? null : t("files.actions.mkdirRequired")),
    });
    if (!name) return;
    const path = joinRemotePath(currentPath, name.trim(), protocol);
    try {
      await mkdirRemote(activeId, path);
      void loadDir(currentPath);
    } catch (e) {
      setError(fmtError(e));
    }
  }, [activeId, currentPath, loadDir, protocol, t]);

  const handleRename = useCallback(async (entry: FileEntry) => {
    const newName = await quickInput({
      title: t("files.actions.rename"),
      defaultValue: entry.name,
      validate: (v) => (v.trim() && v.trim() !== entry.name ? null : t("files.actions.renameRequired")),
    });
    if (!newName) return;
    const newPath = joinRemotePath(parentPath(entry.path, protocol), newName.trim(), protocol);
    try {
      await renameRemote(activeId, entry.path, newPath);
      void loadDir(currentPath);
    } catch (e) {
      setError(fmtError(e));
    }
  }, [activeId, currentPath, loadDir, protocol, t]);

  const handleDelete = useCallback(async (entry: FileEntry) => {
    if (!window.confirm(t("files.actions.deleteConfirm", { name: entry.name }))) return;
    try {
      await deleteRemote(activeId, entry.path);
      setSelected(null);
      void loadDir(currentPath);
    } catch (e) {
      setError(fmtError(e));
    }
  }, [activeId, currentPath, loadDir, t]);

  const handleEnter = useCallback((entry: FileEntry) => {
    if (entry.kind === "dir") {
      navigateTo(entry.path);
    } else {
      setSelected(entry);
    }
  }, [navigateTo]);

  const handleSavedConnection = useCallback(async () => {
    setEditConnection(undefined);
    await refreshConnections();
    await loadConnections();
  }, [loadConnections, refreshConnections]);

  const openNewConnectionDialog = () => {
    setEditConnection(undefined);
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
    if (!window.confirm(t("files.context.deleteConnConfirm", { name: conn.name }))) return;
    try {
      await removeConnection(conn.id);
      await loadConnections();
      if (activeId === conn.id) {
        const local = connections.find((c) => c.id === LOCAL_CONNECTION_ID);
        if (local) await selectConnection(local);
      }
    } catch (e) {
      setError(fmtError(e));
    }
  }, [activeId, connections, loadConnections, removeConnection, selectConnection, t]);

  const handleTestConnection = useCallback(async (connId: string) => {
    try {
      const msg = await testFileConnection(connId);
      setInfo(msg);
      setError(null);
    } catch (e) {
      setError(fmtError(e));
    }
  }, []);

  const handleFileContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    setSelected(entry);
    setCtxMenu({ kind: "file", x: e.clientX, y: e.clientY, entry });
  };

  const handleConnContextMenu = (e: React.MouseEvent, conn: FileManagerConnectionInfo) => {
    if (conn.id === LOCAL_CONNECTION_ID) return;
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ kind: "conn", x: e.clientX, y: e.clientY, conn });
  };

  const fileCtxItems = useMemo((): ContextMenuItem[] => {
    if (ctxMenu?.kind !== "file") return [];
    const entry = ctxMenu.entry;
    const items: ContextMenuItem[] = [
      {
        id: "open",
        label: t("files.context.open"),
        onClick: () => handleEnter(entry),
      },
    ];
    if (entry.kind === "file") {
      items.push({
        id: "download",
        label: t("files.actions.download"),
        onClick: () => void handleDownload(entry),
      });
    }
    items.push(
      { id: "sep1", separator: true, label: "" },
      {
        id: "rename",
        label: t("files.actions.rename"),
        onClick: () => void handleRename(entry),
      },
      {
        id: "delete",
        label: t("files.actions.delete"),
        danger: true,
        onClick: () => void handleDelete(entry),
      },
      { id: "sep2", separator: true, label: "" },
      {
        id: "properties",
        label: t("files.context.properties"),
        onClick: () => setSelected(entry),
      },
    );
    return items;
  }, [ctxMenu, handleDelete, handleDownload, handleEnter, handleRename, t]);

  const connCtxItems = useMemo((): ContextMenuItem[] => {
    if (ctxMenu?.kind !== "conn") return [];
    const conn = ctxMenu.conn;
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
      { id: "sep", separator: true, label: "" },
      {
        id: "delete",
        label: t("files.context.deleteConn"),
        danger: true,
        onClick: () => void handleDeleteConnection(conn),
      },
    ];
  }, [ctxMenu, handleDeleteConnection, handleTestConnection, t]);

  const crumbs = splitBreadcrumb(currentPath, protocol);
  const canBack = historyIndex > 0;
  const canForward = historyIndex >= 0 && historyIndex < history.length - 1;

  return (
    <>
      <SidebarWorkspace
        preset="server"
        className="files-workspace"
        sidebar={
          <FilesSidebar
            groupedConnections={groupedConnections}
            activeId={activeId}
            quickPaths={quickPaths}
            onSelectConnection={(conn) => void selectConnection(conn)}
            onConnContextMenu={handleConnContextMenu}
            onAddConnection={openNewConnectionDialog}
            onQuickNavigate={navigateTo}
          />
        }
      >
      <div className="fm-main">
        <div className="fm-toolbar">
          <button
            type="button"
            className="fm-action-btn"
            disabled={!canBack}
            onClick={() => {
              const next = historyIndex - 1;
              setHistoryIndex(next);
              void loadDir(history[next]);
            }}
            title={t("files.toolbar.back")}
          >
            <IconNavBack />
          </button>
          <button
            type="button"
            className="fm-action-btn"
            disabled={!canForward}
            onClick={() => {
              const next = historyIndex + 1;
              setHistoryIndex(next);
              void loadDir(history[next]);
            }}
            title={t("files.toolbar.forward")}
          >
            <IconNavForward />
          </button>
          <button
            type="button"
            className="fm-action-btn"
            onClick={() => navigateTo(parentPath(currentPath, protocol))}
            title={t("files.toolbar.up")}
          >
            <IconNavUp />
          </button>
          <button
            type="button"
            className="fm-action-btn"
            onClick={() => void loadDir(currentPath)}
            title={t("files.toolbar.refresh")}
          >
            <IconRefresh />
          </button>
          <div className="fm-breadcrumb">
            {crumbs.map((crumb, i) => (
              <span key={`${crumb.path}-${i}`} className="fm-crumb-segment">
                {i > 0 && <span className="fm-crumb-sep">›</span>}
                <button
                  type="button"
                  className={`fm-crumb${i === crumbs.length - 1 ? " current" : ""}`}
                  onClick={() => navigateTo(crumb.path)}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </div>
          <div className="fm-search">
            <span className="search-icon">
              <IconSearch />
            </span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("files.toolbar.search")}
            />
          </div>
          <span className="fm-toolbar-divider" />
          <div className="fm-toolbar-actions">
            <button
              type="button"
              className={`fm-action-btn${viewMode === "list" ? " active" : ""}`}
              onClick={() => setViewMode("list")}
              title={t("files.toolbar.listView")}
            >
              <IconListView />
            </button>
            <button
              type="button"
              className={`fm-action-btn${viewMode === "grid" ? " active" : ""}`}
              onClick={() => setViewMode("grid")}
              title={t("files.toolbar.gridView")}
            >
              <IconGridView />
            </button>
            <span className="fm-toolbar-divider" />
            <button type="button" className="fm-action-btn" onClick={() => void handleUpload()} title={t("files.actions.upload")}>
              <IconUpload />
            </button>
            <button type="button" className="fm-action-btn" onClick={() => void handleMkdir()} title={t("files.actions.mkdir")}>
              <IconNewFolder />
            </button>
          </div>
        </div>

        <div className="fm-content-wrap">
          <div className="fm-content">
            {error && (
              <div className="fm-error-banner">{error}</div>
            )}
            {info && !error && (
              <div className="fm-info-banner">{info}</div>
            )}
            {loading ? (
              <ModuleEmptyState preset="folder" title={t("files.loading")} />
            ) : filteredEntries.length === 0 ? (
              <ModuleEmptyState preset="folder" title={t("files.empty")} />
            ) : viewMode === "list" ? (
              <>
                <div className="fm-table-header">
                  <span className="fm-th-name">{t("files.columns.name")}</span>
                  <span className="fm-th-size">{t("files.columns.size")}</span>
                  <span className="fm-th-type">{t("files.columns.type")}</span>
                  <span className="fm-th-modified">{t("files.columns.modified")}</span>
                  <span className="fm-th-perms">{t("files.columns.permissions")}</span>
                </div>
                <div className="fm-file-list">
                  {filteredEntries.map((entry) => (
                    <div
                      key={entry.path}
                      className={`fm-file-row${selected?.path === entry.path ? " selected" : ""}`}
                      onClick={() => handleEnter(entry)}
                      onContextMenu={(e) => handleFileContextMenu(e, entry)}
                      onDoubleClick={() => entry.kind === "file" && void handleDownload(entry)}
                    >
                      <span className={`fm-file-icon${entry.kind === "dir" ? " folder" : ""}`}>
                        <FileEntryIcon type={entry.kind === "dir" ? "dir" : "file"} />
                      </span>
                      <span className="fm-file-name">{entry.name}</span>
                      <span className="fm-file-size">{entry.kind === "dir" ? "—" : formatFileSize(entry.size)}</span>
                      <span className="fm-file-type">{fileTypeLabel(entry)}</span>
                      <span className="fm-file-modified">{formatFileTime(entry.modified)}</span>
                      <span className="fm-file-perms">{entry.permissions ?? "—"}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="fm-grid">
                {filteredEntries.map((entry) => (
                  <div
                    key={entry.path}
                    className={`fm-grid-item${selected?.path === entry.path ? " selected" : ""}`}
                    onClick={() => handleEnter(entry)}
                    onContextMenu={(e) => handleFileContextMenu(e, entry)}
                    onDoubleClick={() => entry.kind === "file" && void handleDownload(entry)}
                  >
                    <span className={`grid-icon${entry.kind === "dir" ? " folder" : ""}`}>
                      <FileEntryIcon type={entry.kind === "dir" ? "dir" : "file"} />
                    </span>
                    <span className="grid-name">{entry.name}</span>
                    <span className="grid-size">{entry.kind === "dir" ? "—" : formatFileSize(entry.size)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <aside className={`fm-detail${selected ? "" : " empty"}`}>
            {!selected ? (
              <p>{t("files.detail.empty")}</p>
            ) : (
              <>
                <div className="fm-detail-header">
                  <h4>{t("files.detail.title")}</h4>
                </div>
                <div className="fm-detail-preview">
                  <span className={`preview-icon${selected.kind === "dir" ? " folder" : ""}`}>
                    <FileEntryIcon type={selected.kind === "dir" ? "dir" : "file"} />
                  </span>
                </div>
                {previewText && (
                  <pre className="fm-detail-text-preview">{previewText.slice(0, 4000)}</pre>
                )}
                <div className="fm-detail-info">
                  <div className="fm-detail-row"><span className="label">{t("files.detail.name")}</span><span className="value">{selected.name}</span></div>
                  <div className="fm-detail-row"><span className="label">{t("files.detail.type")}</span><span className="value">{fileTypeLabel(selected)}</span></div>
                  <div className="fm-detail-row"><span className="label">{t("files.detail.size")}</span><span className="value">{formatFileSize(selected.size)}</span></div>
                  <div className="fm-detail-row"><span className="label">{t("files.detail.modified")}</span><span className="value">{formatFileTime(selected.modified)}</span></div>
                  <div className="fm-detail-row"><span className="label">{t("files.detail.path")}</span><span className="value" title={selected.path}>{selected.path}</span></div>
                </div>
                <div className="fm-detail-actions">
                  {selected.kind === "file" && (
                    <button type="button" className="fm-detail-action" onClick={() => void handleDownload(selected)}>
                      {t("files.actions.download")}
                    </button>
                  )}
                  <button type="button" className="fm-detail-action" onClick={() => void handleRename(selected)}>
                    {t("files.actions.rename")}
                  </button>
                  <button type="button" className="fm-detail-action danger" onClick={() => void handleDelete(selected)}>
                    {t("files.actions.delete")}
                  </button>
                </div>
              </>
            )}
          </aside>
        </div>

        {transfers.length > 0 && (
          <div className="fm-transfers">
            <span className="transfer-label">{t("files.transfers.title")}</span>
            {transfers.map((item) => (
              <span key={item.id} className={`fm-transfer-item transfer-${item.status}`}>
                <span className="transfer-name">{item.name}</span>
                <span className="transfer-progress"><span className="transfer-progress-fill" style={{ width: `${item.progress}%` }} /></span>
                <span className="transfer-pct">{item.status === "error" ? "!" : `${item.progress}%`}</span>
              </span>
            ))}
            <span className="transfer-spacer" />
            <button type="button" className="transfer-toggle" onClick={clearDoneTransfers}>{t("files.transfers.clear")}</button>
          </div>
        )}
      </div>
      </SidebarWorkspace>

      <FileConnectionDialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setEditConnection(undefined);
        }}
        editConnection={editConnection}
        onSaved={() => void handleSavedConnection()}
      />

      {ctxMenu && (
        <ContextMenu
          items={ctxMenu.kind === "file" ? fileCtxItems : connCtxItems}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </>
  );
}
