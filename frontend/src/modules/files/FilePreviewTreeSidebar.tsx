import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FileEntryIcon } from "../../components/ui/icons/FileEntryIcon";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/menu/ContextMenu";
import { useI18n } from "../../i18n";
import type { FileEntry } from "../../ipc/bindings";
import { quickInput } from "../../lib/quickInput";
import { cn } from "../../lib/utils";
import {
  createEmptyPreviewTreeFile,
  listPreviewTreeDir,
  mkdirPreviewTree,
  previewTreeIsRoot,
  previewTreeJoinPath,
  previewTreeParentPath,
  previewTreePathWithin,
  type FilePreviewTreeSession,
} from "./filePreviewTreeIo";
import { fmtError } from "./utils";

const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 180;
const MAX_WIDTH = 420;

export interface FilePreviewTreeSidebarProps {
  session: FilePreviewTreeSession;
  selectedPath: string;
  onSelectFile: (entry: FileEntry) => void;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  width?: number;
  onWidthChange?: (width: number) => void;
}

type ChildrenState = FileEntry[] | "loading" | "error";

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={cn("file-preview-tree-chevron", expanded && "is-expanded")}
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M6.2 3.2a.75.75 0 0 1 1.06 0l4 4a.75.75 0 0 1 0 1.06l-4 4A.75.75 0 0 1 6.2 11.2L9.64 7.8 6.2 4.36a.75.75 0 0 1 0-1.16z"
      />
    </svg>
  );
}

export function FilePreviewTreeSidebar({
  session,
  selectedPath,
  onSelectFile,
  collapsed,
  onCollapsedChange,
  width = DEFAULT_WIDTH,
  onWidthChange,
}: FilePreviewTreeSidebarProps) {
  const { t } = useI18n();
  const [rootPath, setRootPath] = useState("");
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [childrenByPath, setChildrenByPath] = useState<Record<string, ChildrenState>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null);
  const loadSeqRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const sessionKey = `${session.sessionType}:${session.connectionId}:${session.resourceId ?? ""}`;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const loadRoot = useCallback(async (path: string, options?: { keepExpanded?: string[] }) => {
    const current = sessionRef.current;
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const entries = await listPreviewTreeDir(current, path);
      if (seq !== loadSeqRef.current) return;
      setRootEntries(entries);
      setRootPath(path);
      if (options?.keepExpanded?.length) {
        setChildrenByPath({});
        setExpandedPaths(new Set(options.keepExpanded));
        for (const dir of options.keepExpanded) {
          void listPreviewTreeDir(current, dir)
            .then((childEntries) => {
              if (seq !== loadSeqRef.current) return;
              setChildrenByPath((prev) => ({ ...prev, [dir]: childEntries }));
            })
            .catch(() => {
              if (seq !== loadSeqRef.current) return;
              setChildrenByPath((prev) => ({ ...prev, [dir]: "error" }));
            });
        }
      } else {
        setChildrenByPath({});
        setExpandedPaths(new Set());
      }
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      setError(fmtError(e));
      setRootEntries([]);
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, []);

  // session 变化或预览文件跳出当前树根时，重置到文件所在目录
  useEffect(() => {
    const current = sessionRef.current;
    const fileDir = previewTreeParentPath(selectedPath, current);
    if (!previewTreePathWithin(rootPath, selectedPath, current)) {
      void loadRoot(fileDir);
    }
  }, [selectedPath, sessionKey, rootPath, loadRoot]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  const loadChildren = useCallback(async (dirPath: string) => {
    setChildrenByPath((prev) => ({ ...prev, [dirPath]: "loading" }));
    try {
      const entries = await listPreviewTreeDir(sessionRef.current, dirPath);
      setChildrenByPath((prev) => ({ ...prev, [dirPath]: entries }));
    } catch {
      setChildrenByPath((prev) => ({ ...prev, [dirPath]: "error" }));
    }
  }, []);

  const toggleDir = useCallback(
    (entry: FileEntry) => {
      if (entry.kind !== "dir") return;
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) {
          next.delete(entry.path);
        } else {
          next.add(entry.path);
          if (childrenByPath[entry.path] == null) {
            void loadChildren(entry.path);
          }
        }
        return next;
      });
    },
    [childrenByPath, loadChildren],
  );

  const navigateUp = useCallback(() => {
    if (previewTreeIsRoot(rootPath, session)) return;
    void loadRoot(previewTreeParentPath(rootPath, session));
  }, [loadRoot, rootPath, session]);

  const handleRefresh = useCallback(() => {
    void loadRoot(rootPath, { keepExpanded: [...expandedPaths] });
  }, [expandedPaths, loadRoot, rootPath]);

  const handleCreateFolder = useCallback(async () => {
    setNewMenu(null);
    const name = await quickInput({
      title: t("files.actions.mkdir"),
      placeholder: t("files.actions.mkdirPlaceholder"),
      validate: (v) => (v.trim() ? null : t("files.actions.mkdirRequired")),
    });
    if (!name) return;
    const path = previewTreeJoinPath(rootPath, name.trim(), session);
    try {
      await mkdirPreviewTree(session, path);
      void loadRoot(rootPath);
    } catch (e) {
      setError(fmtError(e));
    }
  }, [loadRoot, rootPath, session, t]);

  const handleCreateFile = useCallback(async () => {
    setNewMenu(null);
    const name = await quickInput({
      title: t("files.preview.tree.newFile"),
      placeholder: t("files.preview.tree.newFilePlaceholder"),
      validate: (v) => (v.trim() ? null : t("files.preview.tree.newFileRequired")),
    });
    if (!name) return;
    const path = previewTreeJoinPath(rootPath, name.trim(), session);
    try {
      await createEmptyPreviewTreeFile(session, path);
      await loadRoot(rootPath);
      onSelectFile({
        name: name.trim(),
        path,
        kind: "file",
        size: 0,
        modified: null,
        permissions: null,
      });
    } catch (e) {
      setError(fmtError(e));
    }
  }, [loadRoot, onSelectFile, rootPath, session, t]);

  const newMenuItems = useMemo((): ContextMenuItem[] => {
    return [
      {
        id: "new-file",
        label: t("files.preview.tree.newFile"),
        onClick: () => void handleCreateFile(),
      },
      {
        id: "new-folder",
        label: t("files.actions.mkdir"),
        onClick: () => void handleCreateFolder(),
      },
    ];
  }, [handleCreateFile, handleCreateFolder, t]);

  const query = searchQuery.trim().toLowerCase();

  const renderEntries = useCallback(
    (entries: FileEntry[], depth: number): ReactNode => {
      const filtered = query
        ? entries.filter((e) => e.name.toLowerCase().includes(query))
        : entries;

      return filtered.map((entry) => {
        const isDir = entry.kind === "dir";
        const expanded = expandedPaths.has(entry.path);
        const selected = entry.path === selectedPath;
        const children = childrenByPath[entry.path];

        return (
          <div key={entry.path} className="file-preview-tree-node-wrap">
            <button
              type="button"
              className={cn("file-preview-tree-node", selected && "is-selected")}
              style={{ paddingLeft: 8 + depth * 14 }}
              title={entry.path}
              onClick={() => {
                if (isDir) toggleDir(entry);
                else onSelectFile(entry);
              }}
              onDoubleClick={() => {
                if (isDir) void loadRoot(entry.path);
                else onSelectFile(entry);
              }}
            >
              <span
                className={cn("file-preview-tree-twistie", !isDir && "is-file")}
                onClick={(e) => {
                  if (!isDir) return;
                  e.stopPropagation();
                  toggleDir(entry);
                }}
              >
                {isDir ? <Chevron expanded={expanded} /> : null}
              </span>
              <span className={cn("file-preview-tree-icon", isDir && "is-dir")}>
                <FileEntryIcon
                  type={isDir ? "dir" : "file"}
                  fileName={isDir ? undefined : entry.name}
                  size={14}
                />
              </span>
              <span className="file-preview-tree-name">{entry.name}</span>
            </button>
            {isDir && expanded ? (
              <div className="file-preview-tree-children">
                {children === "loading" ? (
                  <div
                    className="file-preview-tree-hint"
                    style={{ paddingLeft: 8 + (depth + 1) * 14 }}
                  >
                    {t("files.preview.loading")}
                  </div>
                ) : children === "error" ? (
                  <div
                    className="file-preview-tree-hint is-error"
                    style={{ paddingLeft: 8 + (depth + 1) * 14 }}
                  >
                    {t("files.preview.tree.loadFailed")}
                  </div>
                ) : Array.isArray(children) && children.length === 0 ? (
                  <div
                    className="file-preview-tree-hint"
                    style={{ paddingLeft: 8 + (depth + 1) * 14 }}
                  >
                    {t("files.preview.tree.empty")}
                  </div>
                ) : Array.isArray(children) ? (
                  renderEntries(children, depth + 1)
                ) : null}
              </div>
            ) : null}
          </div>
        );
      });
    },
    [
      childrenByPath,
      expandedPaths,
      loadRoot,
      onSelectFile,
      query,
      selectedPath,
      t,
      toggleDir,
    ],
  );

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startX: e.clientX, startW: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || !onWidthChange) return;
    const next = Math.min(
      MAX_WIDTH,
      Math.max(MIN_WIDTH, Math.round(dragRef.current.startW + (e.clientX - dragRef.current.startX))),
    );
    onWidthChange(next);
  };

  const handleResizePointerUp = () => {
    dragRef.current = null;
  };

  if (collapsed) {
    return (
      <div className="file-preview-tree-rail">
        <button
          type="button"
          className="file-preview-tree-rail-btn"
          title={t("files.preview.tree.expand")}
          aria-label={t("files.preview.tree.expand")}
          onClick={() => onCollapsedChange(false)}
        >
          ›
        </button>
      </div>
    );
  }

  return (
    <aside className="file-preview-tree" style={{ width }}>
      <div className="file-preview-tree-header">
        <div className="file-preview-tree-dir" title={rootPath}>
          <span className="file-preview-tree-dir-label">{t("files.preview.tree.directory")}</span>
          <span className="file-preview-tree-dir-path">{rootPath || "/"}</span>
        </div>
        <div className="file-preview-tree-actions">
          <button
            type="button"
            className="file-preview-tree-action"
            disabled={previewTreeIsRoot(rootPath, session)}
            title={t("files.toolbar.up")}
            onClick={navigateUp}
          >
            ↑ {t("files.preview.tree.up")}
          </button>
          <button
            type="button"
            className="file-preview-tree-action"
            title={t("files.toolbar.refresh")}
            onClick={handleRefresh}
          >
            ↺ {t("files.preview.tree.refresh")}
          </button>
          <button
            type="button"
            className="file-preview-tree-action"
            title={t("files.preview.tree.new")}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setNewMenu({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            + {t("files.preview.tree.new")}
          </button>
          <button
            type="button"
            className={cn("file-preview-tree-action", searchOpen && "is-active")}
            title={t("files.preview.tree.search")}
            onClick={() => {
              setSearchOpen((v) => !v);
              if (searchOpen) setSearchQuery("");
            }}
          >
            Q {t("files.preview.tree.search")}
          </button>
        </div>
        {searchOpen ? (
          <input
            ref={searchInputRef}
            className="file-preview-tree-search"
            value={searchQuery}
            placeholder={t("files.toolbar.search")}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearchOpen(false);
                setSearchQuery("");
              }
            }}
          />
        ) : null}
      </div>

      <div className="file-preview-tree-body">
        {loading && rootEntries.length === 0 ? (
          <div className="file-preview-tree-hint">{t("files.preview.loading")}</div>
        ) : error ? (
          <div className="file-preview-tree-hint is-error">{error}</div>
        ) : rootEntries.length === 0 ? (
          <div className="file-preview-tree-hint">{t("files.preview.tree.empty")}</div>
        ) : (
          renderEntries(rootEntries, 0)
        )}
      </div>

      <button
        type="button"
        className="file-preview-tree-collapse"
        title={t("files.preview.tree.collapse")}
        aria-label={t("files.preview.tree.collapse")}
        onClick={() => onCollapsedChange(true)}
      >
        ‹
      </button>

      {onWidthChange ? (
        <div
          className="file-preview-tree-resize"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
        />
      ) : null}

      {newMenu ? (
        <ContextMenu
          position={{ x: newMenu.x, y: newMenu.y }}
          items={newMenuItems}
          onClose={() => setNewMenu(null)}
        />
      ) : null}
    </aside>
  );
}
