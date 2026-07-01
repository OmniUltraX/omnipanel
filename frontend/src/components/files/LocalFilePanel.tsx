import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { TextInput } from "../ui/TextInput";
import { FileEntryIcon } from "../ui/FileEntryIcon";
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
  const [showMkdir, setShowMkdir] = useState(false);
  const [mkdirName, setMkdirName] = useState("");
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
    const handler = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener("click", handler);
      return () => document.removeEventListener("click", handler);
    }
  }, [contextMenu]);

  const navigateUp = () => {
    if (isLocalRoot(path)) return;
    void loadDir(parentPath(path, "local"));
  };

  const navigateTo = (entry: FileEntry) => {
    if (entry.kind !== "dir") return;
    void loadDir(entry.path);
  };

  const handleDelete = async (entry: FileEntry) => {
    try {
      await deleteRemote(LOCAL_CONNECTION_ID, entry.path);
      void loadDir(path);
    } catch (e) {
      setError(fmtError(e));
    }
  };

  const handleMkdir = async () => {
    if (!mkdirName.trim()) return;
    const fullPath = joinRemotePath(path, mkdirName.trim(), "local");
    try {
      await mkdirRemote(LOCAL_CONNECTION_ID, fullPath);
      setShowMkdir(false);
      setMkdirName("");
      void loadDir(path);
    } catch (e) {
      setError(fmtError(e));
    }
  };

  const handleRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    const dir = parentPath(renameTarget.path, "local");
    const newPath = joinRemotePath(dir, renameValue.trim(), "local");
    try {
      await renameRemote(LOCAL_CONNECTION_ID, renameTarget.path, newPath);
      setRenameTarget(null);
      setRenameValue("");
      void loadDir(path);
    } catch (e) {
      setError(fmtError(e));
    }
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

  return (
    <div className="sftp-panel local-file-panel">
      <div className="sftp-toolbar">
        <Button
          variant="secondary"
          size="sm"
          onClick={navigateUp}
          disabled={isLocalRoot(path)}
          title={t("files.toolbar.up")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M15 18l-6-6 6-6" /></svg>
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setShowMkdir(true)}>
          {t("ssh.sftp.mkdir")}
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
              className="sftp-quick-btn"
              onClick={() => void loadDir(qp.path)}
            >
              {qp.label}
            </button>
          ))}
        </div>
      )}

      {showMkdir && (
        <div className="sftp-mkdir-bar">
          <TextInput
            className="input input-sm"
            size="sm"
            value={mkdirName}
            onChange={setMkdirName}
            placeholder={t("ssh.sftp.mkdirPlaceholder")}
          />
          <Button variant="primary" size="sm" onClick={() => void handleMkdir()}>{t("ssh.sftp.create")}</Button>
          <Button variant="secondary" size="sm" onClick={() => { setShowMkdir(false); setMkdirName(""); }}>{t("ssh.keys.cancel")}</Button>
        </div>
      )}
      {renameTarget && (
        <div className="sftp-mkdir-bar">
          <span className="text-sm">{t("ssh.sftp.rename")} <code>{renameTarget.name}</code></span>
          <TextInput
            className="input input-sm"
            size="sm"
            value={renameValue}
            onChange={setRenameValue}
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && void handleRename()}
          />
          <Button variant="primary" size="sm" onClick={() => void handleRename()}>{t("ssh.sftp.confirm")}</Button>
          <Button variant="secondary" size="sm" onClick={() => { setRenameTarget(null); setRenameValue(""); }}>{t("ssh.keys.cancel")}</Button>
        </div>
      )}

      {error && <div className="sftp-error">{error}</div>}

      <div className="sftp-table-wrap">
        {loading ? (
          <div className="sftp-empty">{t("files.loading")}</div>
        ) : entries.length === 0 ? (
          <div className="sftp-empty">{t("files.empty")}</div>
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
                    onDoubleClick={() => isDir && navigateTo(entry)}
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

      {contextMenu && (
        <div
          className="sftp-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.entry.kind === "dir" && (
            <button
              type="button"
              className="sftp-ctx-item"
              onClick={() => {
                navigateTo(contextMenu.entry);
                setContextMenu(null);
              }}
            >
              {t("ssh.sftp.openDir")}
            </button>
          )}
          <button
            type="button"
            className="sftp-ctx-item"
            onClick={() => {
              setRenameTarget(contextMenu.entry);
              setRenameValue(contextMenu.entry.name);
              setContextMenu(null);
            }}
          >
            {t("ssh.sftp.rename")}
          </button>
          <button
            type="button"
            className="sftp-ctx-item sftp-ctx-item--danger"
            onClick={() => {
              void handleDelete(contextMenu.entry);
              setContextMenu(null);
            }}
          >
            {t("ssh.sftp.delete")}
          </button>
        </div>
      )}
    </div>
  );
}
