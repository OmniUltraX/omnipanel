import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { commands } from "../../ipc/bindings";
import { Button } from "../ui/primitives/Button";
import { TextInput } from "../ui/form/TextInput";
import { FileEntryIcon } from "../ui/icons/FileEntryIcon";
import { ContextMenu } from "../ui/menu/ContextMenu";
import { useSshDetailNavigationStore } from "../../stores/sshDetailNavigationStore";
import { useI18n } from "../../i18n";
import { pathToRemoteDir } from "../../modules/server/ssh/utils/parseCommandPaths";
import { fmtSftpError, formatSftpSize, type SftpEntry } from "./sftpUtils";
import {
  sftpEntryDisplayName,
  sftpEntryIconType,
  sftpEntryNameClass,
  sftpEntryRowClass,
} from "./sftpEntryDisplay";
import { FilePreviewSubWindow } from "../../modules/files/FilePreviewSubWindow";
import { uploadRemote } from "../../modules/files/fileApi";
import { LOCAL_CONNECTION_ID } from "../../modules/files/utils";
import type { SftpPanelAdapter } from "./sftpAdapter";
import { resolveSftpCapabilities } from "./sftpAdapter";
import { SftpComposer } from "./SftpComposer";
import {
  buildFileEntryContextMenuItems,
  type FileEntryCtxLabels,
} from "./buildFileEntryContextMenu";

export type SftpPanelProps = {
  resourceId: string | null;
  /** 非 SSH 场景的文件操作适配器（如 Docker 容器目录） */
  adapter?: SftpPanelAdapter;
  /** adapter 模式下的会话缓存键 */
  cacheKey?: string;
  /** 首次打开 / adapter 模式下的起始目录 */
  initialPath?: string;
};

const QUICK_PATHS = [
  { label: "/", path: "/" },
  { label: "/etc", path: "/etc" },
  { label: "/var/log", path: "/var/log" },
  { label: "/home", path: "/home" },
  { label: "/tmp", path: "/tmp" },
];

type ComposerMode = "mkdir" | "rename" | "chmod" | null;

function IconUp() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function IconFolderPlus() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  );
}

export function SftpPanel({ resourceId, adapter, cacheKey, initialPath }: SftpPanelProps) {
  const { t } = useI18n();
  const capabilities = resolveSftpCapabilities(adapter);
  const sessionKey = adapter ? (cacheKey ?? "sftp-adapter") : resourceId;
  const startPath = initialPath?.trim() || "/";
  const [path, setPath] = useState(() => {
    if (sessionKey && !adapter) {
      const store = useSshDetailNavigationStore.getState();
      if (store.pendingSftp?.resourceId === sessionKey) return store.pendingSftp.path;
      if (store.sftpCaches[sessionKey]) return store.sftpCaches[sessionKey].path;
    }
    return startPath;
  });
  const [entries, setEntries] = useState<SftpEntry[]>(() => {
    if (sessionKey && !adapter) {
      const store = useSshDetailNavigationStore.getState();
      const pending = store.pendingSftp;
      const cached = store.sftpCaches[sessionKey];
      if (pending?.resourceId === sessionKey) {
        if (cached && cached.path === pending.path) return cached.entries;
        return [];
      }
      if (cached) return cached.entries;
    }
    return [];
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerMode>(null);
  const [mkdirName, setMkdirName] = useState("");
  const [composerBusy, setComposerBusy] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: SftpEntry } | null>(null);
  const [renameTarget, setRenameTarget] = useState<SftpEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [chmodTarget, setChmodTarget] = useState<SftpEntry | null>(null);
  const [chmodValue, setChmodValue] = useState("");
  const [pathEditing, setPathEditing] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const sessionKeyRef = useRef(sessionKey);
  const pathEditSkipCommitRef = useRef(false);
  const loadSeqRef = useRef(0);
  const dragDepthRef = useRef(0);
  const handledSftpNonceRef = useRef<number | null>(null);
  const pendingSftp = useSshDetailNavigationStore((s) => s.pendingSftp);
  sessionKeyRef.current = sessionKey;

  const canUpload = Boolean(adapter?.writeBytes) || Boolean(resourceId);

  const [previewEntry, setPreviewEntry] = useState<SftpEntry | null>(null);
  const fullPathOf = useCallback(
    (entry: SftpEntry) => (path === "/" ? `/${entry.name}` : `${path}/${entry.name}`),
    [path],
  );
  const openPreview = useCallback((entry: SftpEntry) => {
    if (entry.isDir || !capabilities.preview) return;
    setPreviewEntry(entry);
  }, [capabilities.preview]);
  const closePreview = useCallback(() => setPreviewEntry(null), []);

  const closeComposer = useCallback(() => {
    setComposer(null);
    setMkdirName("");
    setRenameTarget(null);
    setRenameValue("");
    setChmodTarget(null);
    setChmodValue("");
    setComposerBusy(false);
  }, []);

  const openMkdir = useCallback(() => {
    setRenameTarget(null);
    setRenameValue("");
    setChmodTarget(null);
    setChmodValue("");
    setMkdirName("");
    setComposer("mkdir");
  }, []);

  const openRename = useCallback((entry: SftpEntry) => {
    setMkdirName("");
    setChmodTarget(null);
    setChmodValue("");
    setRenameTarget(entry);
    setRenameValue(entry.name);
    setComposer("rename");
  }, []);

  const openChmod = useCallback((entry: SftpEntry) => {
    setMkdirName("");
    setRenameTarget(null);
    setRenameValue("");
    setChmodTarget(entry);
    setChmodValue("");
    setComposer("chmod");
  }, []);

  const loadDir = async (
    dir: string,
    opts?: { fromNavigation?: boolean; originalPath?: string; seq?: number; silent?: boolean },
  ) => {
    if (!sessionKeyRef.current) return;
    const seq = opts?.seq ?? ++loadSeqRef.current;
    if (!opts?.silent) setLoading(true);
    setError(null);
    if (!opts?.fromNavigation) setInfo(null);
    try {
      const list = adapter
        ? await adapter.list(dir)
        : await invoke<SftpEntry[]>("sftp_list", {
            id: sessionKeyRef.current,
            path: dir,
          });
      if (seq !== loadSeqRef.current) return;
      const normalized = list.map((entry) => ({
        name: entry.name,
        isDir: entry.isDir ?? false,
        isSymlink: entry.isSymlink ?? false,
        linkTarget: entry.linkTarget ?? null,
        size: entry.size ?? 0,
      }));
      normalized.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(normalized);
      setPath(dir);
      setSelectedName(null);
      if (!adapter && sessionKeyRef.current) {
        useSshDetailNavigationStore.getState().setSftpCache(sessionKeyRef.current, {
          path: dir,
          entries: normalized,
        });
      }
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      if (opts?.fromNavigation && dir !== "/") {
        const parent = dir.split("/").slice(0, -1).join("/") || "/";
        setInfo(t("ssh.sftp.pathFallback", { path: opts.originalPath ?? dir, parent }));
        await loadDir(parent, {
          fromNavigation: true,
          originalPath: opts.originalPath ?? dir,
          seq,
        });
        return;
      }
      setError(fmtSftpError(e));
      setEntries([]);
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!sessionKey) return;
    let disposed = false;
    const run = async () => {
      if (adapter) {
        await loadDir(startPath, { fromNavigation: true, originalPath: startPath });
        return;
      }
      const store = useSshDetailNavigationStore.getState();
      const pending = store.pendingSftp;
      if (pending?.resourceId === sessionKey) {
        handledSftpNonceRef.current = pending.nonce;
        await loadDir(pending.path, {
          fromNavigation: true,
          originalPath: pending.path,
        });
        return;
      }

      const cached = store.sftpCaches[sessionKey];
      if (cached) {
        if (!disposed) {
          setPath(cached.path);
          setEntries(cached.entries);
        }
        await loadDir(cached.path, { silent: true });
        return;
      }

      await loadDir(startPath);
    };
    void run();
    return () => {
      disposed = true;
      loadSeqRef.current += 1;
    };
  }, [adapter, sessionKey, startPath]);

  useEffect(() => {
    if (adapter || !sessionKey || !pendingSftp) return;
    if (pendingSftp.resourceId !== sessionKey) return;
    if (handledSftpNonceRef.current === pendingSftp.nonce) return;
    handledSftpNonceRef.current = pendingSftp.nonce;
    void loadDir(pendingSftp.path, {
      fromNavigation: true,
      originalPath: pendingSftp.path,
    });
  }, [adapter, pendingSftp, sessionKey]);

  const navigateUp = () => {
    if (path === "/") return;
    const parent = path.split("/").slice(0, -1).join("/") || "/";
    void loadDir(parent);
  };

  const navigateTo = (entry: SftpEntry) => {
    if (!entry.isDir) return;
    const newPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
    void loadDir(newPath);
  };

  const handleDelete = async (entry: SftpEntry) => {
    if (!sessionKey || !capabilities.delete) return;
    const fullPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
    try {
      if (adapter?.remove) {
        await adapter.remove(fullPath);
      } else if (resourceId) {
        await invoke("sftp_remove", { id: resourceId, path: fullPath });
      } else {
        return;
      }
      void loadDir(path);
    } catch (e) {
      setError(fmtSftpError(e));
    }
  };

  const handleDownload = useCallback(async (entry: SftpEntry) => {
    if (entry.isDir) return;
    const remotePath = fullPathOf(entry);
    const savePath = await saveFileDialog({ defaultPath: entry.name });
    if (!savePath) return;
    try {
      let bytes: number[];
      if (adapter?.readBytes) {
        bytes = await adapter.readBytes(remotePath, 512 * 1024 * 1024);
      } else if (resourceId) {
        const result = await commands.sftpDownload(resourceId, remotePath);
        if (result.status !== "ok") {
          throw new Error(result.error.message || "download failed");
        }
        bytes = result.data;
      } else {
        return;
      }
      await uploadRemote(LOCAL_CONNECTION_ID, savePath, bytes);
      setInfo(t("files.entryCtx.downloadDone", { name: entry.name }));
    } catch (e) {
      setError(fmtSftpError(e));
    }
  }, [adapter, fullPathOf, resourceId, t]);

  const ctxLabels = useMemo((): FileEntryCtxLabels => ({
    open: t("files.entryCtx.open"),
    openDir: t("files.entryCtx.openDir"),
    openFile: t("files.entryCtx.openFile"),
    edit: t("files.entryCtx.edit"),
    download: t("files.entryCtx.download"),
    copyName: t("files.entryCtx.copyName"),
    copyPath: t("files.entryCtx.copyPath"),
    copyCd: t("files.entryCtx.copyCd"),
    listDir: t("files.entryCtx.listDir"),
    viewContent: t("files.entryCtx.viewContent"),
    showInfo: t("files.entryCtx.showInfo"),
    revealInSftp: t("files.entryCtx.revealInSftp"),
    rename: t("files.entryCtx.rename"),
    chmod: t("files.entryCtx.chmod"),
    delete: t("files.entryCtx.delete"),
  }), [t]);

  const contextMenuItems = useMemo(() => {
    if (!contextMenu) return [];
    const entry = contextMenu.entry;
    const absolutePath = fullPathOf(entry);
    const canDownload = !entry.isDir && (Boolean(adapter?.readBytes) || Boolean(resourceId));
    return buildFileEntryContextMenuItems({
      isDir: entry.isDir,
      labels: ctxLabels,
      handlers: {
        onOpen: entry.isDir
          ? () => navigateTo(entry)
          : capabilities.preview
            ? () => openPreview(entry)
            : undefined,
        onEdit: entry.isDir || !capabilities.preview
          ? undefined
          : () => openPreview(entry),
        onDownload: canDownload ? () => void handleDownload(entry) : undefined,
        onCopyName: () => void navigator.clipboard.writeText(entry.name),
        onCopyPath: () => void navigator.clipboard.writeText(absolutePath),
        onRename: capabilities.rename ? () => openRename(entry) : undefined,
        onChmod: capabilities.chmod ? () => openChmod(entry) : undefined,
        onDelete: capabilities.delete ? () => void handleDelete(entry) : undefined,
      },
    });
  }, [
    adapter?.readBytes,
    capabilities.chmod,
    capabilities.delete,
    capabilities.preview,
    capabilities.rename,
    contextMenu,
    ctxLabels,
    fullPathOf,
    handleDownload,
    openChmod,
    openPreview,
    openRename,
    resourceId,
  ]);

  const handleMkdir = async () => {
    const name = mkdirName.trim();
    if (!sessionKey || !capabilities.mkdir || !name) {
      if (!name) setError(t("ssh.sftp.mkdirRequired"));
      return;
    }
    const fullPath = path === "/" ? `/${name}` : `${path}/${name}`;
    setComposerBusy(true);
    try {
      if (adapter?.mkdir) {
        await adapter.mkdir(fullPath);
      } else if (resourceId) {
        await invoke("sftp_mkdir", { id: resourceId, path: fullPath });
      } else {
        return;
      }
      closeComposer();
      void loadDir(path);
    } catch (e) {
      setError(fmtSftpError(e));
      setComposerBusy(false);
    }
  };

  const handleRename = async () => {
    if (!sessionKey || !capabilities.rename || !renameTarget || !renameValue.trim()) return;
    const oldPath = path === "/" ? `/${renameTarget.name}` : `${path}/${renameTarget.name}`;
    const dir = path === "/" ? "" : path;
    const newPath = `${dir}/${renameValue.trim()}`;
    setComposerBusy(true);
    try {
      if (adapter?.rename) {
        await adapter.rename(oldPath, newPath);
      } else if (resourceId) {
        const res = await commands.sftpRename(resourceId, oldPath, newPath);
        if (res.status !== "ok") {
          setError(res.error.message);
          setComposerBusy(false);
          return;
        }
      } else {
        return;
      }
      closeComposer();
      void loadDir(path);
    } catch (e) {
      setError(fmtSftpError(e));
      setComposerBusy(false);
    }
  };

  const handleChmod = async () => {
    if (!sessionKey || !capabilities.chmod || !chmodTarget || !chmodValue.trim()) return;
    const fullPath = path === "/" ? `/${chmodTarget.name}` : `${path}/${chmodTarget.name}`;
    const mode = parseInt(chmodValue.trim(), 8);
    if (isNaN(mode) || mode < 0 || mode > 0o777) {
      setError(t("ssh.sftp.invalidChmod"));
      return;
    }
    setComposerBusy(true);
    try {
      if (adapter?.chmod) {
        await adapter.chmod(fullPath, mode);
      } else if (resourceId) {
        const res = await commands.sftpChmod(resourceId, fullPath, mode);
        if (res.status !== "ok") {
          setError(res.error.message);
          setComposerBusy(false);
          return;
        }
      } else {
        return;
      }
      closeComposer();
      void loadDir(path);
    } catch (e) {
      setError(fmtSftpError(e));
      setComposerBusy(false);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, entry: SftpEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedName(entry.name);
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  };

  const hasFileDrag = (dt: DataTransfer | null): boolean => {
    if (!dt) return false;
    if (dt.types.includes("Files")) return true;
    return Array.from(dt.items ?? []).some((item) => item.kind === "file");
  };

  const uploadLocalFiles = async (files: FileList | File[]) => {
    if (!sessionKey || !canUpload || uploading) return;
    const list = Array.from(files).filter((file) => file && file.name);
    if (list.length === 0) return;

    setUploading(true);
    setError(null);
    setInfo(t("ssh.sftp.uploading", { count: list.length }));
    let ok = 0;
    let fail = 0;
    let lastError: string | null = null;

    for (const file of list) {
      const remotePath = path === "/" ? `/${file.name}` : `${path}/${file.name}`;
      try {
        const buffer = await file.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buffer));
        if (adapter?.writeBytes) {
          await adapter.writeBytes(remotePath, bytes);
        } else if (resourceId) {
          const result = await commands.sftpUpload(resourceId, remotePath, bytes);
          if (result.status !== "ok") {
            throw new Error(result.error.message || "upload failed");
          }
        } else {
          return;
        }
        ok += 1;
      } catch (e) {
        fail += 1;
        lastError = fmtSftpError(e);
      }
    }

    setUploading(false);
    if (fail === 0) {
      setInfo(t("ssh.sftp.uploadSuccess", { count: ok }));
    } else if (ok === 0) {
      setError(lastError || t("ssh.sftp.uploadFailed"));
      setInfo(null);
    } else {
      setInfo(t("ssh.sftp.uploadPartial", { ok, fail }));
      if (lastError) setError(lastError);
    }
    void loadDir(path);
  };

  const handleDragEnter = (e: React.DragEvent) => {
    if (!canUpload || uploading) return;
    if (!hasFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!canUpload) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!canUpload || uploading) return;
    if (!hasFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!canUpload || uploading) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    void uploadLocalFiles(files);
  };

  const pathParts = path.split("/").filter(Boolean);
  const selectedEntry = entries.find((entry) => entry.name === selectedName) ?? null;

  const startPathEdit = () => {
    pathEditSkipCommitRef.current = false;
    setPathInput(path);
    setPathEditing(true);
  };

  const cancelPathEdit = () => {
    pathEditSkipCommitRef.current = true;
    setPathEditing(false);
    setPathInput("");
  };

  const commitPathEdit = () => {
    if (pathEditSkipCommitRef.current) {
      pathEditSkipCommitRef.current = false;
      return;
    }
    const next = pathToRemoteDir(pathInput);
    setPathEditing(false);
    setPathInput("");
    if (next !== path) void loadDir(next);
  };

  const isQuickPathActive = (qp: string) => path === qp || (qp !== "/" && path.startsWith(`${qp}/`));

  return (
    <div className="sftp-panel">
      <div className="sftp-toolbar">
        <Button
          variant="secondary"
          size="icon-sm"
          className="sftp-toolbar-icon-btn"
          onClick={navigateUp}
          disabled={path === "/"}
          title={t("ssh.sftp.up")}
        >
          <IconUp />
        </Button>
        {capabilities.mkdir ? (
          <Button
            variant="secondary"
            size="icon-sm"
            className="sftp-toolbar-icon-btn"
            onClick={openMkdir}
            title={t("ssh.sftp.mkdir")}
            aria-label={t("ssh.sftp.mkdir")}
            aria-pressed={composer === "mkdir"}
          >
            <IconFolderPlus />
          </Button>
        ) : null}
        <div className={`sftp-path${pathEditing ? " sftp-path--editing" : ""}`}>
          {pathEditing ? (
            <TextInput
              autoFocus
              copyable={false}
              clearable={false}
              className="sftp-path-input"
              value={pathInput}
              onChange={setPathInput}
              placeholder={t("ssh.sftp.pathEditPlaceholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitPathEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelPathEdit();
                }
              }}
              onBlur={commitPathEdit}
            />
          ) : (
            <>
              <div className="sftp-path-crumbs">
                <button type="button" className="sftp-path-seg" onClick={() => void loadDir("/")}>/</button>
                {pathParts.map((seg, i) => {
                  const segPath = "/" + pathParts.slice(0, i + 1).join("/");
                  return (
                    <span key={segPath} className="sftp-path-group">
                      {i > 0 && <span className="sftp-path-sep">/</span>}
                      <button type="button" className="sftp-path-seg" onClick={() => void loadDir(segPath)}>{seg}</button>
                    </span>
                  );
                })}
              </div>
              <button
                type="button"
                className="sftp-path-edit-hit"
                aria-label={t("ssh.sftp.pathEditPlaceholder")}
                onClick={startPathEdit}
              />
            </>
          )}
        </div>
      </div>

      <div className="sftp-quick-paths sftp-quick-paths--top">
        {QUICK_PATHS.map((qp) => (
          <button
            key={qp.path}
            type="button"
            className={`sftp-quick-btn${isQuickPathActive(qp.path) ? " is-active" : ""}`}
            onClick={() => void loadDir(qp.path)}
          >
            {qp.label}
          </button>
        ))}
      </div>

      {composer === "mkdir" && (
        <SftpComposer
          title={t("ssh.sftp.mkdir")}
          value={mkdirName}
          onChange={setMkdirName}
          placeholder={t("ssh.sftp.mkdirPlaceholder")}
          confirmLabel={t("ssh.sftp.create")}
          cancelLabel={t("ssh.keys.cancel")}
          onConfirm={() => void handleMkdir()}
          onCancel={closeComposer}
          submitting={composerBusy}
        />
      )}
      {composer === "rename" && renameTarget && (
        <SftpComposer
          title={t("ssh.sftp.rename")}
          hint={<code className="sftp-composer__code">{renameTarget.name}</code>}
          value={renameValue}
          onChange={setRenameValue}
          placeholder={renameTarget.name}
          confirmLabel={t("ssh.sftp.confirm")}
          cancelLabel={t("ssh.keys.cancel")}
          onConfirm={() => void handleRename()}
          onCancel={closeComposer}
          submitting={composerBusy}
        />
      )}
      {composer === "chmod" && chmodTarget && (
        <SftpComposer
          title={t("ssh.sftp.chmod")}
          hint={<code className="sftp-composer__code">{chmodTarget.name}</code>}
          value={chmodValue}
          onChange={setChmodValue}
          placeholder="755"
          confirmLabel={t("ssh.sftp.confirm")}
          cancelLabel={t("ssh.keys.cancel")}
          onConfirm={() => void handleChmod()}
          onCancel={closeComposer}
          submitting={composerBusy}
          inputStyle={{ maxWidth: 96 }}
        />
      )}

      {error && <div className="sftp-error">{error}</div>}
      {info && <div className="sftp-info">{info}</div>}

      {!sessionKey ? (
        <div className="sftp-empty sftp-empty--centered">{adapter?.emptyMessage ?? t("ssh.empty.selectHost")}</div>
      ) : (
        <div
          className={`sftp-table-wrap${dragOver ? " sftp-table-wrap--drag-over" : ""}${uploading ? " sftp-table-wrap--uploading" : ""}`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {dragOver ? (
            <div className="sftp-drop-overlay" aria-hidden>
              {t("ssh.sftp.dropHint")}
            </div>
          ) : null}
          {loading ? (
            <div className="sftp-empty sftp-empty--centered">{t("ssh.sftp.loading")}</div>
          ) : entries.length === 0 ? (
            <div className="sftp-empty sftp-empty--centered">
              <div className="sftp-empty__title">{t("ssh.sftp.emptyDir")}</div>
              {canUpload ? <div className="sftp-empty-hint">{t("ssh.sftp.dropHint")}</div> : null}
            </div>
          ) : (
            <table className="sftp-table">
              <thead>
                <tr>
                  <th className="sftp-col-name">{t("ssh.sftp.name")}</th>
                  <th className="sftp-col-size">{t("ssh.sftp.size")}</th>
                  {capabilities.delete ? <th className="sftp-col-actions" /> : null}
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const selected = selectedName === entry.name;
                  return (
                    <tr
                      key={entry.name}
                      className={[
                        sftpEntryRowClass(entry),
                        selected ? "sftp-row-selected" : "",
                      ].filter(Boolean).join(" ")}
                      onClick={() => setSelectedName(entry.name)}
                      onDoubleClick={() => {
                        if (entry.isDir) {
                          navigateTo(entry);
                        } else {
                          openPreview(entry);
                        }
                      }}
                      onContextMenu={(e) => handleContextMenu(e, entry)}
                    >
                      <td className="sftp-col-name">
                        <span className={`sftp-icon sftp-icon-${sftpEntryIconType(entry)}`}>
                          <FileEntryIcon type={sftpEntryIconType(entry)} fileName={entry.name} size={14} />
                        </span>
                        <span className={sftpEntryNameClass(entry)} title={sftpEntryDisplayName(entry)}>
                          {sftpEntryDisplayName(entry)}
                        </span>
                      </td>
                      <td className="sftp-col-size text-muted">
                        {entry.isDir && !entry.isSymlink ? "—" : entry.isSymlink ? "link" : formatSftpSize(entry.size)}
                      </td>
                      {capabilities.delete ? (
                        <td className="sftp-col-actions">
                          <button
                            type="button"
                            className="sftp-action-btn"
                            onClick={(e) => { e.stopPropagation(); void handleDelete(entry); }}
                            title={t("ssh.sftp.delete")}
                          >
                            <IconTrash />
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {selectedEntry && (
        <div className="sftp-status-bar">
          {t("ssh.sftp.selected", {
            name: selectedEntry.isSymlink && selectedEntry.linkTarget
              ? `${selectedEntry.name} → ${selectedEntry.linkTarget}`
              : selectedEntry.name,
          })}
        </div>
      )}

      {contextMenu && contextMenuItems.length > 0 ? (
        <ContextMenu
          items={contextMenuItems}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
      <FilePreviewSubWindow
        open={previewEntry != null}
        entry={
          previewEntry
            ? {
                name: previewEntry.name,
                path: fullPathOf(previewEntry),
                kind: previewEntry.isDir ? "dir" : "file",
                size: previewEntry.size ?? null,
                modified: null,
                permissions: null,
              }
            : null
        }
        connectionId={resourceId ?? sessionKey ?? ""}
        onClose={closePreview}
        customIO={
          previewEntry && (adapter?.readBytes || resourceId)
            ? {
                readBytes: (filePath, maxBytes) => {
                  if (adapter?.readBytes) {
                    return adapter.readBytes(filePath, maxBytes).then((bytes) => {
                      return maxBytes > 0 && bytes.length > maxBytes ? bytes.slice(0, maxBytes) : bytes;
                    });
                  }
                  return commands.sftpDownload(resourceId!, filePath).then((result) => {
                    if (result.status !== "ok") {
                      throw new Error(result.error.message || "download failed");
                    }
                    const bytes = result.data;
                    return maxBytes > 0 && bytes.length > maxBytes ? bytes.slice(0, maxBytes) : bytes;
                  });
                },
                writeBytes: (filePath, bytes) => {
                  if (adapter?.writeBytes) {
                    return adapter.writeBytes(filePath, Array.from(bytes));
                  }
                  return commands.sftpUpload(resourceId!, filePath, Array.from(bytes)).then((result) => {
                    if (result.status !== "ok") {
                      throw new Error(result.error.message || "upload failed");
                    }
                  });
                },
              }
            : undefined
        }
      />
    </div>
  );
}
