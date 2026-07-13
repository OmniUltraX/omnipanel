import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { commands } from "../../ipc/bindings";
import { Button } from "../ui/primitives/Button";
import { TextInput } from "../ui/form/TextInput";
import { FileEntryIcon } from "../ui/icons/FileEntryIcon";
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
import type { SftpPanelAdapter } from "./sftpAdapter";
import { resolveSftpCapabilities } from "./sftpAdapter";

export type SftpPanelProps = {
  resourceId: string | null;
  /** 非 SSH 场景的文件操作适配器（如 Docker 容器目录） */
  adapter?: SftpPanelAdapter;
  /** adapter 模式下的会话缓存键 */
  cacheKey?: string;
};

const QUICK_PATHS = [
  { label: "/", path: "/" },
  { label: "/etc", path: "/etc" },
  { label: "/var/log", path: "/var/log" },
  { label: "/home", path: "/home" },
  { label: "/tmp", path: "/tmp" },
];

export function SftpPanel({ resourceId, adapter, cacheKey }: SftpPanelProps) {
  const { t } = useI18n();
  const capabilities = resolveSftpCapabilities(adapter);
  const sessionKey = adapter ? (cacheKey ?? "sftp-adapter") : resourceId;
  console.log(`[sftp-render] resourceId=${resourceId} sessionKey=${sessionKey}`);
  const [path, setPath] = useState(() => {
    if (sessionKey && !adapter) {
      const store = useSshDetailNavigationStore.getState();
      if (store.pendingSftp?.resourceId === sessionKey) return store.pendingSftp.path;
      if (store.sftpCaches[sessionKey]) return store.sftpCaches[sessionKey].path;
    }
    return "/";
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
  const [showMkdir, setShowMkdir] = useState(false);
  const [mkdirName, setMkdirName] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: SftpEntry } | null>(null);
  const [renameTarget, setRenameTarget] = useState<SftpEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [chmodTarget, setChmodTarget] = useState<SftpEntry | null>(null);
  const [chmodValue, setChmodValue] = useState("");
  const [pathEditing, setPathEditing] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const sessionKeyRef = useRef(sessionKey);
  const pathEditSkipCommitRef = useRef(false);
  const loadSeqRef = useRef(0);
  const handledSftpNonceRef = useRef<number | null>(null);
  const pendingSftp = useSshDetailNavigationStore((s) => s.pendingSftp);
  sessionKeyRef.current = sessionKey;

  // 双击文件预览：仅预览非目录；目录走 navigateTo
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

  const loadDir = async (
    dir: string,
    opts?: { fromNavigation?: boolean; originalPath?: string; seq?: number; silent?: boolean },
  ) => {
    console.log(`[sftp-loadDir] dir=${dir} silent=${opts?.silent} fromNav=${opts?.fromNavigation} sessionKey=${sessionKeyRef.current} stack=${new Error().stack?.split('\n').slice(2,5).join(' | ')}`);
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
    if (adapter) {
      void loadDir("/");
      return;
    }
    const store = useSshDetailNavigationStore.getState();
    const pending = store.pendingSftp;
    if (pending?.resourceId === sessionKey) {
      handledSftpNonceRef.current = pending.nonce;
      void loadDir(pending.path, {
        fromNavigation: true,
        originalPath: pending.path,
      });
      return;
    }

    const cached = store.sftpCaches[sessionKey];
    if (cached) {
      setPath(cached.path);
      setEntries(cached.entries);
      void loadDir(cached.path, { silent: true });
      return;
    }

    void loadDir("/");
  }, [adapter, sessionKey]);

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

  useEffect(() => {
    const handler = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener("click", handler);
      return () => document.removeEventListener("click", handler);
    }
  }, [contextMenu]);

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

  const handleMkdir = async () => {
    if (!sessionKey || !capabilities.mkdir || !mkdirName) return;
    const fullPath = path === "/" ? `/${mkdirName}` : `${path}/${mkdirName}`;
    try {
      if (adapter?.mkdir) {
        await adapter.mkdir(fullPath);
      } else if (resourceId) {
        await invoke("sftp_mkdir", { id: resourceId, path: fullPath });
      } else {
        return;
      }
      setShowMkdir(false);
      setMkdirName("");
      void loadDir(path);
    } catch (e) {
      setError(fmtSftpError(e));
    }
  };

  const handleRename = async () => {
    if (!sessionKey || !capabilities.rename || !renameTarget || !renameValue.trim()) return;
    const oldPath = path === "/" ? `/${renameTarget.name}` : `${path}/${renameTarget.name}`;
    const dir = path === "/" ? "" : path;
    const newPath = `${dir}/${renameValue.trim()}`;
    try {
      if (adapter?.rename) {
        await adapter.rename(oldPath, newPath);
      } else if (resourceId) {
        const res = await commands.sftpRename(resourceId, oldPath, newPath);
        if (res.status !== "ok") {
          setError(res.error.message);
          return;
        }
      } else {
        return;
      }
      setRenameTarget(null);
      setRenameValue("");
      void loadDir(path);
    } catch (e) {
      setError(fmtSftpError(e));
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
    try {
      if (adapter?.chmod) {
        await adapter.chmod(fullPath, mode);
      } else if (resourceId) {
        const res = await commands.sftpChmod(resourceId, fullPath, mode);
        if (res.status !== "ok") {
          setError(res.error.message);
          return;
        }
      } else {
        return;
      }
      setChmodTarget(null);
      setChmodValue("");
      void loadDir(path);
    } catch (e) {
      setError(fmtSftpError(e));
    }
  };

  const handleContextMenu = (e: React.MouseEvent, entry: SftpEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedName(entry.name);
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
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

  return (
    <div className="sftp-panel">
      <div className="sftp-toolbar">
        <Button variant="secondary" size="sm" onClick={navigateUp} disabled={path === "/"} title={t("ssh.sftp.up")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M15 18l-6-6 6-6" /></svg>
        </Button>
        {capabilities.mkdir ? (
          <Button variant="secondary" size="sm" onClick={() => setShowMkdir(true)}>
            {t("ssh.sftp.mkdir")}
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
          <button key={qp.path} type="button" className="sftp-quick-btn" onClick={() => void loadDir(qp.path)}>
            {qp.label}
          </button>
        ))}
      </div>

      {showMkdir && (
        <div className="sftp-mkdir-bar">
          <TextInput className="input input-sm" size="sm" value={mkdirName} onChange={setMkdirName} placeholder={t("ssh.sftp.mkdirPlaceholder")} />
          <Button variant="primary" size="sm" onClick={() => void handleMkdir()}>{t("ssh.sftp.create")}</Button>
          <Button variant="secondary" size="sm" onClick={() => { setShowMkdir(false); setMkdirName(""); }}>{t("ssh.keys.cancel")}</Button>
        </div>
      )}
      {renameTarget && (
        <div className="sftp-mkdir-bar">
          <span className="text-sm">{t("ssh.sftp.rename")} <code>{renameTarget.name}</code></span>
          <TextInput className="input input-sm" size="sm" value={renameValue} onChange={setRenameValue} autoFocus onKeyDown={(e) => e.key === "Enter" && void handleRename()} />
          <Button variant="primary" size="sm" onClick={() => void handleRename()}>{t("ssh.sftp.confirm")}</Button>
          <Button variant="secondary" size="sm" onClick={() => { setRenameTarget(null); setRenameValue(""); }}>{t("ssh.keys.cancel")}</Button>
        </div>
      )}
      {chmodTarget && (
        <div className="sftp-mkdir-bar">
          <span className="text-sm">{t("ssh.sftp.chmod")} <code>{chmodTarget.name}</code></span>
          <TextInput className="input input-sm" size="sm" value={chmodValue} onChange={setChmodValue} placeholder="755" autoFocus onKeyDown={(e) => e.key === "Enter" && void handleChmod()} style={{ width: 80 }} />
          <Button variant="primary" size="sm" onClick={() => void handleChmod()}>{t("ssh.sftp.confirm")}</Button>
          <Button variant="secondary" size="sm" onClick={() => { setChmodTarget(null); setChmodValue(""); }}>{t("ssh.keys.cancel")}</Button>
        </div>
      )}

      {error && <div className="sftp-error">{error}</div>}
      {info && <div className="sftp-info">{info}</div>}

      {!sessionKey ? (
        <div className="sftp-empty">{adapter?.emptyMessage ?? t("ssh.empty.selectHost")}</div>
      ) : (
        <div className="sftp-table-wrap">
          {loading ? (
            <div className="sftp-empty">{t("ssh.sftp.loading")}</div>
          ) : entries.length === 0 ? (
            <div className="sftp-empty">{t("ssh.sftp.emptyDir")}</div>
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
                          <button type="button" className="sftp-action-btn" onClick={(e) => { e.stopPropagation(); void handleDelete(entry); }} title={t("ssh.sftp.delete")}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
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

      {contextMenu && (
        <div
          className="sftp-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.entry.isDir && (
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
          {capabilities.rename ? (
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
          ) : null}
          {capabilities.chmod ? (
            <button
              type="button"
              className="sftp-ctx-item"
              onClick={() => {
                setChmodTarget(contextMenu.entry);
                setChmodValue("");
                setContextMenu(null);
              }}
            >
              {t("ssh.sftp.chmod")}
            </button>
          ) : null}
          {capabilities.delete ? (
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
          ) : null}
        </div>
      )}
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
