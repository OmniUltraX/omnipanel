import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/primitives/Button";
import { TextInput } from "../ui/form/TextInput";
import { FileEntryIcon } from "../ui/icons/FileEntryIcon";
import { ContextMenu } from "../ui/menu/ContextMenu";
import { useI18n } from "../../i18n";
import type { FileEntry } from "../../ipc/bindings";
import {
  deleteRemote,
  listDirectory,
  loadQuickPaths,
  mkdirRemote,
  renameRemote,
} from "../../modules/files/fileApi";
import {
  fmtError,
  formatFileSize,
  joinRemotePath,
  LOCAL_CONNECTION_ID,
  parentPath,
  sortFileEntries,
} from "../../modules/files/utils";
import { SftpComposer } from "../sftp/SftpComposer";
import {
  buildFileEntryContextMenuItems,
  type FileEntryCtxLabels,
} from "../sftp/buildFileEntryContextMenu";
import { useSshDetailNavigationStore } from "../../stores/sshDetailNavigationStore";
import { useTerminalFilePreviewStore } from "../../modules/terminal/terminalFilePreviewStore";

type ComposerMode = "mkdir" | "rename" | null;

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

function splitLocalBreadcrumb(path: string): { label: string; path: string }[] {
  if (!path) return [{ label: "~", path: "" }];
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
    acc = acc ? `${acc}${parts[i]}${sep}` : `${sep}${parts[i]}${sep}`;
    out.push({ label: parts[i], path: acc.replace(/[\\/]+$/, "") || acc });
  }
  return out.length ? out : [{ label: path, path }];
}

function isLocalRoot(path: string): boolean {
  if (!path) return true;
  const parent = parentPath(path, "local");
  return parent === path;
}

export function LocalFilePanel({ initialPath }: { initialPath?: string } = {}) {
  const { t } = useI18n();
  const [path, setPath] = useState(initialPath ?? "");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerMode>(null);
  const [mkdirName, setMkdirName] = useState("");
  const [composerBusy, setComposerBusy] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pathEditing, setPathEditing] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [quickPaths, setQuickPaths] = useState<{
    home: string;
    desktop: string;
    documents: string;
    downloads: string;
  } | null>(null);
  const pathEditSkipCommitRef = useRef(false);
  const loadSeqRef = useRef(0);
  const initRef = useRef(false);
  const handledLocalNavNonceRef = useRef<number | null>(null);
  const openFilePreview = useTerminalFilePreviewStore((s) => s.open);
  const pendingLocalNavigate = useSshDetailNavigationStore((s) => s.pendingLocalNavigate);
  const consumeLocalNavigate = useSshDetailNavigationStore((s) => s.consumeLocalNavigate);

  const closeComposer = useCallback(() => {
    setComposer(null);
    setMkdirName("");
    setRenameTarget(null);
    setRenameValue("");
    setComposerBusy(false);
  }, []);

  const openMkdir = useCallback(() => {
    setRenameTarget(null);
    setRenameValue("");
    setMkdirName("");
    setComposer("mkdir");
  }, []);

  const loadDir = async (dir: string, seq?: number) => {
    const currentSeq = seq ?? ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const list = await listDirectory(LOCAL_CONNECTION_ID, dir);
      if (currentSeq !== loadSeqRef.current) return;
      setEntries(sortFileEntries(list.entries));
      setPath(dir);
      setSelectedName(null);
    } catch (e) {
      if (currentSeq !== loadSeqRef.current) return;
      setError(fmtError(e));
      setEntries([]);
    } finally {
      if (currentSeq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    void (async () => {
      try {
        const qp = await loadQuickPaths();
        setQuickPaths(qp);
        await loadDir(qp.home);
      } catch (e) {
        setError(fmtError(e));
      }
    })();
  }, []);

  useEffect(() => {
    if (!pendingLocalNavigate) return;
    if (handledLocalNavNonceRef.current === pendingLocalNavigate.nonce) return;
    const consumed = consumeLocalNavigate();
    if (!consumed) return;
    handledLocalNavNonceRef.current = consumed.nonce;
    void loadDir(consumed.path);
  }, [pendingLocalNavigate, consumeLocalNavigate]);

  const navigateUp = () => {
    if (isLocalRoot(path)) return;
    void loadDir(parentPath(path, "local"));
  };

  const navigateTo = (entry: FileEntry) => {
    if (entry.kind !== "dir") return;
    void loadDir(entry.path);
  };

  const openLocalFile = useCallback((entry: FileEntry) => {
    if (entry.kind === "dir") return;
    openFilePreview({
      connectionId: LOCAL_CONNECTION_ID,
      absolutePath: entry.path,
      name: entry.name,
      resourceId: null,
      sessionType: "local",
    });
  }, [openFilePreview]);

  const handleDelete = async (entry: FileEntry) => {
    try {
      await deleteRemote(LOCAL_CONNECTION_ID, entry.path);
      void loadDir(path);
    } catch (e) {
      setError(fmtError(e));
    }
  };

  const handleMkdir = async () => {
    if (!mkdirName.trim()) {
      setError(t("ssh.sftp.mkdirRequired"));
      return;
    }
    const fullPath = joinRemotePath(path, mkdirName.trim(), "local");
    setComposerBusy(true);
    try {
      await mkdirRemote(LOCAL_CONNECTION_ID, fullPath);
      closeComposer();
      void loadDir(path);
    } catch (e) {
      setError(fmtError(e));
      setComposerBusy(false);
    }
  };

  const handleRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    const dir = parentPath(renameTarget.path, "local");
    const newPath = joinRemotePath(dir, renameValue.trim(), "local");
    setComposerBusy(true);
    try {
      await renameRemote(LOCAL_CONNECTION_ID, renameTarget.path, newPath);
      closeComposer();
      void loadDir(path);
    } catch (e) {
      setError(fmtError(e));
      setComposerBusy(false);
    }
  };

  const isQuickPathActive = (qp: string) => {
    if (!qp) return !path;
    if (path === qp) return true;
    const sep = qp.includes("\\") ? "\\" : "/";
    return path.startsWith(qp.endsWith(sep) ? qp : `${qp}${sep}`);
  };

  const handleContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedName(entry.name);
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  };

  const pathCrumbs = splitLocalBreadcrumb(path);
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
    const next = pathInput.trim();
    setPathEditing(false);
    setPathInput("");
    if (next && next !== path) void loadDir(next);
  };

  const quickButtons = quickPaths
    ? [
        { label: t("files.quick.home"), path: quickPaths.home },
        { label: t("files.quick.desktop"), path: quickPaths.desktop },
        { label: t("files.quick.documents"), path: quickPaths.documents },
        { label: t("files.quick.downloads"), path: quickPaths.downloads },
      ]
    : [];

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
    const isDir = entry.kind === "dir";
    return buildFileEntryContextMenuItems({
      isDir,
      labels: ctxLabels,
      handlers: {
        onOpen: () => {
          if (isDir) navigateTo(entry);
          else openLocalFile(entry);
        },
        onEdit: isDir ? undefined : () => openLocalFile(entry),
        onCopyName: () => void navigator.clipboard.writeText(entry.name),
        onCopyPath: () => void navigator.clipboard.writeText(entry.path),
        onRename: () => {
          setMkdirName("");
          setRenameTarget(entry);
          setRenameValue(entry.name);
          setComposer("rename");
        },
        onDelete: () => void handleDelete(entry),
      },
    });
  }, [contextMenu, ctxLabels, openLocalFile]);

  return (
    <div className="sftp-panel local-file-panel">
      <div className="sftp-toolbar">
        <Button
          variant="secondary"
          size="icon-sm"
          className="sftp-toolbar-icon-btn"
          onClick={navigateUp}
          disabled={isLocalRoot(path)}
          title={t("files.toolbar.up")}
        >
          <IconUp />
        </Button>
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
                {pathCrumbs.map((crumb, i) => (
                  <span key={`${crumb.path}-${i}`} className="sftp-path-group">
                    {i > 0 && <span className="sftp-path-sep">/</span>}
                    <button
                      type="button"
                      className="sftp-path-seg"
                      onClick={() => void loadDir(crumb.path)}
                    >
                      {crumb.label}
                    </button>
                  </span>
                ))}
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

      {quickButtons.length > 0 && (
        <div className="sftp-quick-paths sftp-quick-paths--top">
          {quickButtons.map((qp) => (
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
      )}

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

      {error && <div className="sftp-error">{error}</div>}

      <div className="sftp-table-wrap">
        {loading ? (
          <div className="sftp-empty sftp-empty--centered">{t("files.loading")}</div>
        ) : entries.length === 0 ? (
          <div className="sftp-empty sftp-empty--centered">
            <div className="sftp-empty__title">{t("files.empty")}</div>
          </div>
        ) : (
          <table className="sftp-table">
            <thead>
              <tr>
                <th className="sftp-col-name">{t("ssh.sftp.name")}</th>
                <th className="sftp-col-size">{t("ssh.sftp.size")}</th>
                <th className="sftp-col-actions" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const isDir = entry.kind === "dir";
                const selected = selectedName === entry.name;
                return (
                  <tr
                    key={entry.path}
                    className={[
                      isDir ? "sftp-row-dir" : "sftp-row-file",
                      selected ? "sftp-row-selected" : "",
                    ].filter(Boolean).join(" ")}
                    onClick={() => setSelectedName(entry.name)}
                    onDoubleClick={() => {
                      if (isDir) navigateTo(entry);
                      else openLocalFile(entry);
                    }}
                    onContextMenu={(e) => handleContextMenu(e, entry)}
                  >
                    <td className="sftp-col-name">
                      <span className={`sftp-icon ${isDir ? "sftp-icon-dir" : "sftp-icon-file"}`}>
                        <FileEntryIcon type={isDir ? "dir" : "file"} size={14} />
                      </span>
                      <span className={isDir ? "sftp-name-dir" : "sftp-name-file"} title={entry.name}>
                        {entry.name}
                      </span>
                    </td>
                    <td className="sftp-col-size text-muted">
                      {isDir ? "—" : formatFileSize(entry.size)}
                    </td>
                    <td className="sftp-col-actions">
                      <button
                        type="button"
                        className="sftp-action-btn"
                        onClick={(e) => { e.stopPropagation(); void handleDelete(entry); }}
                        title={t("ssh.sftp.delete")}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {selectedEntry && (
        <div className="sftp-status-bar">
          {t("ssh.sftp.selected", { name: selectedEntry.name })}
        </div>
      )}

      {contextMenu && contextMenuItems.length > 0 ? (
        <ContextMenu
          items={contextMenuItems}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  );
}
