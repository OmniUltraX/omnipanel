import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/menu/ContextMenu";
import { TextInput } from "../../components/ui/form/TextInput";
import { FileEntryIcon } from "../../components/ui/icons/FileEntryIcon";
import { ModuleEmptyState } from "../../components/ui/feedback/ModuleEmptyState";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import type { FileEntry, FileIndexStatus, FileLocalSystemInfo, FileManagerConnectionInfo } from "../../ipc/bindings";
import type { FileIndexProgress } from "./fileApi";
import { useFileManagerStore } from "../../stores/fileManagerStore";
import { quickInput } from "../../stores/quickInputStore";
import { VirtualFileList, VirtualFileGrid } from "./VirtualFileList";
import {
  IconDetailPanel,
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
  getFileIndexStatus,
  listDirectory,
  loadQuickPaths,
  mkdirRemote,
  readRemotePreview,
  renameRemote,
  searchFileIndex,
  searchS3Files,
  uploadRemote,
} from "./fileApi";
import { mergeFileEntries } from "./mergeFileEntries";
import { decodePreviewBytes, isTextPreviewFile } from "./filePreviewKind";
import { FilePreviewSubWindow } from "./FilePreviewSubWindow";
import {
  fileTypeLabel,
  formatFileSize,
  formatFileTime,
  joinRemotePath,
  LOCAL_CONNECTION_ID,
  parentPath,
  resolvePreviewReadMaxBytes,
  exceedsPreviewThreshold,
  isPathNotFoundError,
  sortFileEntries,
} from "./utils";
import { useFilesWorkspaceSessionStore } from "../../stores/filesWorkspaceSessionStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  currentLocalDrive,
  isLocalAtRoot,
  LOCAL_COMPUTER_ROOT,
  splitLocalBreadcrumb,
} from "./localFilesystem";
import { buildS3PublicUrl, parseFileConfigJson } from "./s3PublicUrl";
import { formatPathForInput, parseFileNavigationPath, splitPathForPrefixFallback } from "./fileNavigationPath";
import type { FileConnectionPanelSnapshot } from "./filesWorkspaceSession";

type ViewMode = FileConnectionPanelSnapshot["viewMode"];
type FileCtxState = { x: number; y: number; entry: FileEntry } | null;

const PATH_INPUT_ID = "fm-breadcrumb-path-input";

function focusPathInput() {
  const el = document.getElementById(PATH_INPUT_ID);
  if (el instanceof HTMLInputElement) {
    el.focus();
    el.select();
  }
}

export type QuickPaths = {
  home: string;
  desktop: string;
  documents: string;
  downloads: string;
};

function splitBreadcrumb(
  path: string,
  protocol: string,
  localLabels?: { computer: string; home: string; root: string },
  localSystemInfo?: FileLocalSystemInfo | null,
): { label: string; path: string }[] {
  if (protocol === "local" && localLabels) {
    return splitLocalBreadcrumb(path, localLabels, localSystemInfo);
  }
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
    const segments = parts.map((part) => {
      acc = acc ? `${acc}${part}/` : `${part}/`;
      return { label: part, path: acc };
    });
    return [{ label: "/", path: "" }, ...segments];
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

export interface FileConnectionPanelProps {
  connection: FileManagerConnectionInfo;
  quickPaths: QuickPaths | null;
  localSystemInfo: FileLocalSystemInfo | null;
  isActive: boolean;
  savedState?: FileConnectionPanelSnapshot | null;
  onPatchStatus: (connId: string, status: "online" | "offline") => void;
  onRegisterNavigate?: (navigate: ((path: string) => void) | null) => void;
}

export function FileConnectionPanel({
  connection,
  quickPaths,
  localSystemInfo,
  isActive,
  savedState,
  onPatchStatus,
  onRegisterNavigate,
}: FileConnectionPanelProps) {
  const { t } = useI18n();
  const connId = connection.id;
  const protocol = connection.protocol;
  const addTransfer = useFileManagerStore((s) => s.addTransfer);
  const updateTransfer = useFileManagerStore((s) => s.updateTransfer);
  const filePreviewThresholdBytes = useSettingsStore((s) => s.filePreviewThresholdBytes);
  const storedConnection = useConnectionStore((s) => s.connections.find((c) => c.id === connId));

  const setPanelState = useFilesWorkspaceSessionStore((s) => s.setPanelState);

  const [currentPath, setCurrentPath] = useState(savedState?.currentPath ?? "");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [listNextToken, setListNextToken] = useState<string | null>(null);
  const [hasMoreEntries, setHasMoreEntries] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<FileEntry[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [indexStatus, setIndexStatus] = useState<FileIndexStatus | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(savedState?.viewMode ?? "list");
  const [detailVisible, setDetailVisible] = useState(savedState?.detailVisible ?? true);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [previewEntry, setPreviewEntry] = useState<FileEntry | null>(null);
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<FileCtxState>(null);
  const [history, setHistory] = useState<string[]>(savedState?.history ?? []);
  const [historyIndex, setHistoryIndex] = useState(savedState?.historyIndex ?? -1);
  const loadSeq = useRef(0);
  const searchSeq = useRef(0);
  const loadMoreSeq = useRef(0);
  const initializedRef = useRef(false);
  const sessionRef = useRef<FileConnectionPanelSnapshot>({
    viewMode: savedState?.viewMode ?? "list",
    detailVisible: savedState?.detailVisible ?? true,
    currentPath: savedState?.currentPath ?? "",
    history: savedState?.history ?? [],
    historyIndex: savedState?.historyIndex ?? -1,
  });
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoredStateRef = useRef(savedState);
  const [pathEditing, setPathEditing] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const pathEditSkipCommitRef = useRef(false);

  const displayEntries = useMemo(() => {
    const q = search.trim();
    const list = !q ? entries : (searchResults ?? []);
    return sortFileEntries(list);
  }, [entries, search, searchResults]);

  const clearSearchState = useCallback(() => {
    ++searchSeq.current;
    setSearch("");
    setSearchResults(null);
    setSearchLoading(false);
  }, []);

  const loadDir = useCallback(async (path: string) => {
    const seq = ++loadSeq.current;
    ++loadMoreSeq.current;
    setLoading(true);
    setError(null);
    setListNextToken(null);
    setHasMoreEntries(false);

    const applyDirResult = (
      result: Awaited<ReturnType<typeof listDirectory>>,
      resolvedPath: string,
      entriesOverride?: FileEntry[],
    ) => {
      setEntries(entriesOverride ?? result.entries);
      setListNextToken(result.nextContinuationToken);
      setHasMoreEntries(result.truncated);
      setCurrentPath(resolvedPath);
      setSelected(null);
      setPreviewText(null);
      if (connId !== LOCAL_CONNECTION_ID) {
        onPatchStatus(connId, "online");
      }
    };

    const filterByPrefix = (list: FileEntry[], prefix: string) => {
      const q = prefix.toLowerCase();
      return sortFileEntries(list.filter((entry) => entry.name.toLowerCase().startsWith(q)));
    };

    const prefixFallbackCandidate = splitPathForPrefixFallback(path, protocol);

    try {
      const result = await listDirectory(connId, path, null, null, {
        quiet: prefixFallbackCandidate !== null,
      });
      if (seq !== loadSeq.current) return;
      applyDirResult(result, path);
    } catch (e) {
      if (seq !== loadSeq.current) return;

      let resolved = false;
      if (isPathNotFoundError(e)) {
        let current = path;
        while (true) {
          const split = splitPathForPrefixFallback(current, protocol);
          if (!split) break;
          try {
            const parentResult = await listDirectory(
              connId,
              split.parentPath,
              null,
              null,
              { quiet: true },
            );
            if (seq !== loadSeq.current) return;
            applyDirResult(
              parentResult,
              split.parentPath,
              filterByPrefix(parentResult.entries, split.prefix),
            );
            resolved = true;
            break;
          } catch (parentErr) {
            if (!isPathNotFoundError(parentErr)) break;
            current = split.parentPath;
          }
        }
      }

      if (resolved) return;

      console.error("[files] loadDir failed:", { connectionId: connId, path, error: e });
      setError(fmtError(e));
      setEntries([]);
      setListNextToken(null);
      setHasMoreEntries(false);
      if (connId !== LOCAL_CONNECTION_ID) {
        onPatchStatus(connId, "offline");
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [connId, onPatchStatus, protocol]);

  const loadMoreEntries = useCallback(async () => {
    if (protocol !== "s3" || !hasMoreEntries || loadingMore || loading || !listNextToken) return;
    const q = search.trim();
    const seq = ++loadMoreSeq.current;
    setLoadingMore(true);
    try {
      const result = q
        ? await searchS3Files(connId, q, listNextToken)
        : await listDirectory(connId, currentPath, null, listNextToken);
      if (seq !== loadMoreSeq.current) return;
      if (q) {
        setSearchResults((prev) => mergeFileEntries(prev ?? [], result.entries));
      } else {
        setEntries((prev) => mergeFileEntries(prev, result.entries));
      }
      setListNextToken(result.nextContinuationToken);
      setHasMoreEntries(result.truncated);
    } catch (e) {
      if (seq !== loadMoreSeq.current) return;
      setError(fmtError(e));
    } finally {
      if (seq === loadMoreSeq.current) setLoadingMore(false);
    }
  }, [
    connId,
    currentPath,
    hasMoreEntries,
    listNextToken,
    loading,
    loadingMore,
    protocol,
    search,
  ]);

  const navigateTo = useCallback((path: string, pushHistory = true) => {
    clearSearchState();
    if (pushHistory) {
      setHistory((prev) => {
        const base = prev.slice(0, historyIndex + 1);
        return [...base, path];
      });
      setHistoryIndex((i) => i + 1);
    }
    void loadDir(path);
  }, [clearSearchState, historyIndex, loadDir]);

  const flushPanelState = useCallback(() => {
    setPanelState(connId, sessionRef.current);
  }, [connId, setPanelState]);

  const schedulePersistPanelState = useCallback(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      flushPanelState();
    }, 300);
  }, [flushPanelState]);

  useEffect(() => {
    sessionRef.current = {
      viewMode,
      detailVisible,
      currentPath,
      history,
      historyIndex,
    };
    if (!initializedRef.current) return;
    schedulePersistPanelState();
  }, [viewMode, detailVisible, currentPath, history, historyIndex, schedulePersistPanelState]);

  useEffect(() => {
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      if (initializedRef.current) {
        flushPanelState();
      }
    };
  }, [flushPanelState]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    let cancelled = false;
    void (async () => {
      const restored = restoredStateRef.current;
      if (restored && (restored.history.length > 0 || restored.currentPath !== undefined)) {
        const idx = restored.historyIndex >= 0 && restored.historyIndex < restored.history.length
          ? restored.historyIndex
          : restored.history.length > 0
            ? restored.history.length - 1
            : -1;
        const path = idx >= 0
          ? restored.history[idx]!
          : restored.currentPath;
        if (cancelled) return;
        if (restored.history.length > 0) {
          setHistory(restored.history);
          setHistoryIndex(idx);
        } else {
          setHistory([path]);
          setHistoryIndex(0);
        }
        await loadDir(path);
        return;
      }

      let initial = "";
      if (connection.protocol === "local") {
        try {
          const qp = quickPaths ?? (await loadQuickPaths());
          initial = qp.home;
        } catch {
          initial = "";
        }
      }
      if (cancelled) return;
      setHistory([initial]);
      setHistoryIndex(0);
      await loadDir(initial);
    })();
    return () => {
      cancelled = true;
    };
  }, [connection.protocol, connId, loadDir, quickPaths]);

  useEffect(() => {
    if (!isActive) return;
    onRegisterNavigate?.(navigateTo);
    return () => onRegisterNavigate?.(null);
  }, [isActive, navigateTo, onRegisterNavigate]);

  useEffect(() => {
    if (connId !== LOCAL_CONNECTION_ID) {
      setIndexStatus(null);
      return;
    }
    let cancelled = false;
    void getFileIndexStatus(connId)
      .then((status) => {
        if (!cancelled) setIndexStatus(status);
      })
      .catch(() => {
        if (!cancelled) setIndexStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connId]);

  useEffect(() => {
    if (connId !== LOCAL_CONNECTION_ID) return;
    let unlisten: (() => void) | undefined;
    void listen<FileIndexProgress>("file-index-progress", (event) => {
      if (event.payload.connectionId !== connId) return;
      if (event.payload.status === "building") {
        setIndexStatus((prev) => ({
          connectionId: connId,
          status: "building",
          rootPath: prev?.rootPath ?? "",
          indexedCount: event.payload.indexedCount ?? null,
          error: "",
          startedAt: prev?.startedAt ?? 0,
          finishedAt: 0,
        }));
        return;
      }
      void getFileIndexStatus(connId).then(setIndexStatus).catch(() => setIndexStatus(null));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [connId]);

  useEffect(() => {
    if (!isActive) return;
    const q = search.trim();
    if (!q) {
      setSearchResults(null);
      setSearchLoading(false);
      setListNextToken(null);
      setHasMoreEntries(false);
      return;
    }
    const seq = ++searchSeq.current;
    ++loadMoreSeq.current;
    const isLocal = connId === LOCAL_CONNECTION_ID;
    const useIndexSearch = isLocal && indexStatus?.status === "ready";
    const useS3Search = protocol === "s3";
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      const searchPromise = useIndexSearch
        ? searchFileIndex(connId, q).then((results) => ({
            entries: results.map((hit) => ({
              name: hit.entry.name,
              path: hit.entry.path,
              kind: hit.entry.kind,
              size: hit.entry.size,
              modified: hit.entry.modified,
              permissions: null as string | null,
            } satisfies FileEntry)),
            truncated: false,
            nextContinuationToken: null as string | null,
          }))
        : useS3Search
          ? searchS3Files(connId, q, null)
          : listDirectory(connId, currentPath, q, null);
      void searchPromise
        .then((result) => {
          if (seq !== searchSeq.current) return;
          setSearchResults(result.entries);
          setListNextToken(result.nextContinuationToken);
          setHasMoreEntries(result.truncated);
        })
        .catch((e) => {
          if (seq !== searchSeq.current) return;
          setSearchResults([]);
          setListNextToken(null);
          setHasMoreEntries(false);
          setError(fmtError(e));
        })
        .finally(() => {
          if (seq === searchSeq.current) setSearchLoading(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
    };
  }, [search, connId, currentPath, isActive, indexStatus?.status, protocol]);

  const s3InfiniteScroll = protocol === "s3" && hasMoreEntries;
  const listScrollProps = {
    onLoadMore: s3InfiniteScroll ? () => void loadMoreEntries() : undefined,
    loadingMore: s3InfiniteScroll && loadingMore,
  };

  useEffect(() => {
    if (!selected || selected.kind !== "file" || !isTextPreviewFile(selected.name)) {
      setPreviewText(null);
      return;
    }
    if (exceedsPreviewThreshold(selected.size, filePreviewThresholdBytes)) {
      setPreviewText(null);
      return;
    }
    const readMaxBytes = resolvePreviewReadMaxBytes(selected.size, filePreviewThresholdBytes);
    let cancelled = false;
    void readRemotePreview(connId, selected.path, readMaxBytes)
      .then((bytes) => {
        if (!cancelled) setPreviewText(decodePreviewBytes(bytes));
      })
      .catch(() => {
        if (!cancelled) setPreviewText(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, connId, filePreviewThresholdBytes]);

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
        await uploadRemote(connId, remotePath, bytes);
        updateTransfer(xferId, { progress: 100, status: "done" });
      } catch (e) {
        updateTransfer(xferId, { status: "error", error: fmtError(e) });
      }
    }
    void loadDir(currentPath);
  }, [addTransfer, connId, currentPath, loadDir, protocol, updateTransfer]);

  const handleDownload = useCallback(async (entry: FileEntry) => {
    if (entry.kind === "dir") return;
    const savePath = await saveFileDialog({ defaultPath: entry.name });
    if (!savePath) return;
    const xferId = addTransfer(entry.name);
    try {
      updateTransfer(xferId, { progress: 20 });
      await downloadRemote(connId, entry.path, savePath);
      updateTransfer(xferId, { progress: 100, status: "done" });
    } catch (e) {
      updateTransfer(xferId, { status: "error", error: fmtError(e) });
    }
  }, [addTransfer, connId, updateTransfer]);

  const handleMkdir = useCallback(async () => {
    const name = await quickInput({
      title: t("files.actions.mkdir"),
      placeholder: t("files.actions.mkdirPlaceholder"),
      validate: (v) => (v.trim() ? null : t("files.actions.mkdirRequired")),
    });
    if (!name) return;
    const path = joinRemotePath(currentPath, name.trim(), protocol);
    try {
      await mkdirRemote(connId, path);
      void loadDir(currentPath);
    } catch (e) {
      setError(fmtError(e));
    }
  }, [connId, currentPath, loadDir, protocol, t]);

  const handleRename = useCallback(async (entry: FileEntry) => {
    const newName = await quickInput({
      title: t("files.actions.rename"),
      defaultValue: entry.name,
      validate: (v) => (v.trim() && v.trim() !== entry.name ? null : t("files.actions.renameRequired")),
    });
    if (!newName) return;
    const newPath = joinRemotePath(parentPath(entry.path, protocol), newName.trim(), protocol);
    try {
      await renameRemote(connId, entry.path, newPath);
      void loadDir(currentPath);
    } catch (e) {
      setError(fmtError(e));
    }
  }, [connId, currentPath, loadDir, protocol, t]);

  const handleDelete = useCallback(async (entry: FileEntry) => {
    const confirmKey =
      protocol === "s3" && entry.kind === "dir"
        ? "files.actions.deleteS3FolderConfirm"
        : "files.actions.deleteConfirm";
    if (!(await appConfirm(t(confirmKey, { name: entry.name })))) return;
    try {
      await deleteRemote(connId, entry.path, entry.kind);
      setSelected(null);
      void loadDir(currentPath);
    } catch (e) {
      setError(fmtError(e));
    }
  }, [connId, currentPath, loadDir, protocol, t]);

  const handleOpenFile = useCallback((entry: FileEntry) => {
    if (entry.kind !== "file") return;
    setSelected(entry);
    setPreviewEntry(entry);
  }, []);

  const handleCopyS3Link = useCallback(async (entry: FileEntry) => {
    if (protocol !== "s3" || entry.kind !== "file") return;
    const cfg = parseFileConfigJson(storedConnection?.config ?? "{}");
    const url = buildS3PublicUrl(cfg, entry.path);
    if (!url) {
      setCopyToast(t("files.copyLinkUnavailable"));
    } else {
      try {
        await navigator.clipboard.writeText(url);
        setCopyToast(t("files.copyLinkDone"));
      } catch {
        setCopyToast(t("files.copyLinkFailed"));
      }
    }
    window.setTimeout(() => setCopyToast(null), 2200);
  }, [protocol, storedConnection?.config, t]);

  const handleEnter = useCallback((entry: FileEntry) => {
    if (entry.kind === "dir") {
      navigateTo(entry.path);
    } else {
      setSelected(entry);
    }
  }, [navigateTo]);

  const handleFileContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    setSelected(entry);
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  };

  const fileCtxItems = useMemo((): ContextMenuItem[] => {
    if (!ctxMenu) return [];
    const entry = ctxMenu.entry;
    const items: ContextMenuItem[] = [
      {
        id: "open",
        label: t("files.context.open"),
        onClick: () => (entry.kind === "file" ? handleOpenFile(entry) : handleEnter(entry)),
      },
    ];
    if (entry.kind === "file") {
      if (connId !== LOCAL_CONNECTION_ID) {
        items.push({
          id: "download",
          label: t("files.actions.download"),
          onClick: () => void handleDownload(entry),
        });
      }
      if (protocol === "s3") {
        items.push({
          id: "copyLink",
          label: t("files.context.copyLink"),
          onClick: () => void handleCopyS3Link(entry),
        });
      }
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
  }, [ctxMenu, handleCopyS3Link, handleDelete, handleDownload, handleEnter, handleOpenFile, handleRename, protocol, t]);

  const effectiveLocalPath =
    protocol === "local" && !currentPath && quickPaths?.home ? quickPaths.home : currentPath;
  const crumbs = splitBreadcrumb(currentPath, protocol, {
    computer: t("files.local.computer"),
    home: t("files.quick.home"),
    root: t("files.local.root"),
  }, localSystemInfo);
  const atLocalRoot = protocol === "local" && isLocalAtRoot(currentPath, localSystemInfo);
  const localDrive =
    protocol === "local" ? currentLocalDrive(effectiveLocalPath) : null;
  const pathForInput = useMemo(
    () =>
      formatPathForInput(currentPath, protocol, {
        homePath: quickPaths?.home,
        platform: localSystemInfo?.platform,
      }),
    [currentPath, localSystemInfo?.platform, protocol, quickPaths?.home],
  );
  const canBack = historyIndex > 0;
  const canForward = historyIndex >= 0 && historyIndex < history.length - 1;

  const startPathEdit = useCallback(() => {
    pathEditSkipCommitRef.current = false;
    setPathInput(pathForInput);
    setPathEditing(true);
    requestAnimationFrame(() => {
      focusPathInput();
    });
  }, [pathForInput]);

  const cancelPathEdit = useCallback(() => {
    pathEditSkipCommitRef.current = true;
    setPathEditing(false);
    setPathInput("");
  }, []);

  const commitPathEdit = useCallback(() => {
    if (pathEditSkipCommitRef.current) {
      pathEditSkipCommitRef.current = false;
      return;
    }
    const next = parseFileNavigationPath(pathInput, protocol, {
      platform: localSystemInfo?.platform,
    });
    setPathEditing(false);
    setPathInput("");
    if (next !== currentPath) {
      navigateTo(next);
    }
  }, [currentPath, localSystemInfo?.platform, navigateTo, pathInput, protocol]);

  useEffect(() => {
    if (!pathEditing) return;
    focusPathInput();
  }, [pathEditing]);

  return (
    <>
      <div className="fm-dock-pane">
        <div className="fm-toolbar">
          <button
            type="button"
            className="fm-action-btn"
            disabled={!canBack}
            onClick={() => {
              const next = historyIndex - 1;
              clearSearchState();
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
              clearSearchState();
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
            disabled={atLocalRoot || (protocol === "s3" && !currentPath) || (protocol !== "local" && protocol !== "s3" && currentPath === "/")}
            onClick={() => navigateTo(parentPath(effectiveLocalPath, protocol))}
            title={t("files.toolbar.up")}
          >
            <IconNavUp />
          </button>
          {protocol === "local" && localSystemInfo?.platform === "windows" ? (
            <select
              className="fm-drive-select"
              value={localDrive ?? ""}
              title={t("files.local.driveSelect")}
              onChange={(e) => {
                const next = e.target.value;
                navigateTo(next ? `${next}\\` : LOCAL_COMPUTER_ROOT);
              }}
            >
              <option value="">{t("files.local.computer")}</option>
              {localSystemInfo.volumes.map((volume) => (
                <option key={volume.path} value={volume.path.replace(/\\+$/, "")}>
                  {volume.label}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            className="fm-action-btn"
            onClick={() => void loadDir(currentPath)}
            title={t("files.toolbar.refresh")}
          >
            <IconRefresh />
          </button>
          <div className={`fm-breadcrumb${pathEditing ? " fm-breadcrumb--editing" : ""}`}>
            {pathEditing ? (
              <TextInput
                id={PATH_INPUT_ID}
                className="fm-breadcrumb-input"
                copyable
                clearable={false}
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
                <div className="fm-breadcrumb-crumbs">
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
                <button
                  type="button"
                  className="fm-breadcrumb-edit-hit"
                  aria-label={t("ssh.sftp.pathEditPlaceholder")}
                  onClick={startPathEdit}
                />
              </>
            )}
          </div>
          <div className="fm-search">
            <span className="search-icon">
              <IconSearch />
            </span>
            <TextInput
              copyable={false}
              size="sm"
              className="input"
              value={search}
              onChange={setSearch}
              placeholder={
                connId === LOCAL_CONNECTION_ID && indexStatus?.status === "ready"
                  ? t("files.toolbar.searchIndexed")
                  : connId === LOCAL_CONNECTION_ID && indexStatus?.status === "building"
                    ? t("files.toolbar.searchIndexing", { count: indexStatus.indexedCount ?? 0 })
                    : protocol === "s3"
                      ? t("files.toolbar.searchS3")
                      : t("files.toolbar.search")
              }
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
            <button
              type="button"
              className="fm-action-btn"
              onClick={() => void handleUpload()}
              title={t("files.actions.upload")}
            >
              <IconUpload />
            </button>
            <button
              type="button"
              className="fm-action-btn"
              onClick={() => void handleMkdir()}
              title={t("files.actions.mkdir")}
            >
              <IconNewFolder />
            </button>
            <button
              type="button"
              className={`fm-action-btn${detailVisible ? " active" : ""}`}
              onClick={() => setDetailVisible((v) => !v)}
              title={detailVisible ? t("files.toolbar.hideDetail") : t("files.toolbar.showDetail")}
            >
              <IconDetailPanel />
            </button>
          </div>
        </div>
        {error && <div className="fm-error-banner">{error}</div>}
        {copyToast && <div className="fm-copy-toast">{copyToast}</div>}
        <div className="fm-content-wrap">
          <div className="fm-content">
            {loading || (search.trim() && searchLoading) ? (
              <ModuleEmptyState preset="folder" title={t("files.loading")} />
            ) : displayEntries.length === 0 ? (
              <ModuleEmptyState
                preset="folder"
                title={
                  search.trim()
                    ? connId === LOCAL_CONNECTION_ID && indexStatus?.status === "ready"
                      ? t("files.searchNoIndexResults")
                      : t("files.searchNoResults")
                    : t("files.empty")
                }
              />
            ) : viewMode === "list" ? (
              <VirtualFileList
                entries={displayEntries}
                selected={selected}
                scrollResetSignal={`${currentPath}|${connId}|${search.trim()}`}
                onActivate={handleEnter}
                onContextMenu={handleFileContextMenu}
                onOpenFile={handleOpenFile}
                {...listScrollProps}
              />
            ) : (
              <VirtualFileGrid
                entries={displayEntries}
                selected={selected}
                connectionId={connId}
                scrollResetSignal={`${currentPath}|${connId}|${search.trim()}`}
                onActivate={handleEnter}
                onContextMenu={handleFileContextMenu}
                onOpenFile={handleOpenFile}
                {...listScrollProps}
              />
            )}
          </div>
          {detailVisible && (
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
                    <FileEntryIcon
                      type={selected.kind === "dir" ? "dir" : "file"}
                      fileName={selected.kind === "file" ? selected.name : undefined}
                      size={32}
                    />
                  </span>
                </div>
                {previewText && (
                  <pre className="fm-detail-text-preview">{previewText.slice(0, 4000)}</pre>
                )}
                <div className="fm-detail-info">
                  <div className="fm-detail-row">
                    <span className="label">{t("files.detail.name")}</span>
                    <span className="value">{selected.name}</span>
                  </div>
                  <div className="fm-detail-row">
                    <span className="label">{t("files.detail.type")}</span>
                    <span className="value">{fileTypeLabel(selected)}</span>
                  </div>
                  <div className="fm-detail-row">
                    <span className="label">{t("files.detail.size")}</span>
                    <span className="value">{formatFileSize(selected.size)}</span>
                  </div>
                  <div className="fm-detail-row">
                    <span className="label">{t("files.detail.modified")}</span>
                    <span className="value">{formatFileTime(selected.modified)}</span>
                  </div>
                  <div className="fm-detail-row">
                    <span className="label">{t("files.detail.path")}</span>
                    <span className="value" title={selected.path}>
                      {selected.path}
                    </span>
                  </div>
                </div>
                <div className="fm-detail-actions">
                  {selected.kind === "file" && connId !== LOCAL_CONNECTION_ID && (
                    <button
                      type="button"
                      className="fm-detail-action"
                      onClick={() => void handleDownload(selected)}
                    >
                      {t("files.actions.download")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="fm-detail-action"
                    onClick={() => void handleRename(selected)}
                  >
                    {t("files.actions.rename")}
                  </button>
                  <button
                    type="button"
                    className="fm-detail-action danger"
                    onClick={() => void handleDelete(selected)}
                  >
                    {t("files.actions.delete")}
                  </button>
                </div>
              </>
            )}
          </aside>
          )}
        </div>
      </div>

      {ctxMenu && (
        <ContextMenu
          items={fileCtxItems}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
        />
      )}

      <FilePreviewSubWindow
        open={previewEntry != null}
        entry={previewEntry}
        connectionId={connId}
        onClose={() => setPreviewEntry(null)}
        onSaved={() => void loadDir(currentPath)}
        onDownload={
          connId === LOCAL_CONNECTION_ID
            ? undefined
            : (entry) => void handleDownload(entry)
        }
      />
    </>
  );
}
