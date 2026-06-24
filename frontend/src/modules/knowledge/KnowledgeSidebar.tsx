import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { ScopedSearch } from "../../components/ui/ScopedSearch";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/ContextMenu";
import { Button } from "../../components/ui/Button";
import { useKnowledgeEmbeddingModelSelectionId } from "../../components/knowledge/KnowledgeEmbeddingModelSelect";
import { useI18n } from "../../i18n";
import { quickInput } from "../../lib/quickInput";
import { appConfirm } from "../../lib/appConfirm";
import { publishModuleStatusLog } from "../../lib/moduleStatusLog";
import { useAiModelsStore } from "../../stores/aiModelsStore";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { KnowledgeEntry } from "../../ipc/bindings";
import {
  buildKnowledgeTree,
  filterKnowledgeTree,
  isKnowledgeFolder,
  nextSortOrder,
  normalizeParentId,
  type KnowledgeTreeNode,
} from "./knowledgeTree";
import { dispatchKnowledgeVectorized, vectorizeKnowledgeEntry } from "./knowledgeVectorize";

type TreeCtx = {
  x: number;
  y: number;
  entry: KnowledgeEntry;
};

type DropHint = {
  targetId: string;
  position: "before" | "inside" | "after";
};

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </svg>
  );
}

type TreeRowProps = {
  node: KnowledgeTreeNode;
  depth: number;
  expanded: boolean;
  selected: boolean;
  dropHint: DropHint | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onContextMenu: (entry: KnowledgeEntry, e: ReactMouseEvent) => void;
  onDragStart: (id: string, e: DragEvent) => void;
  onDragOver: (id: string, e: DragEvent) => void;
  onDrop: (id: string, e: DragEvent) => void;
  onDragEnd: () => void;
};

function TreeRow({
  node,
  depth,
  expanded,
  selected,
  dropHint,
  onSelect,
  onToggle,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: TreeRowProps) {
  const { entry } = node;
  const isFolder = isKnowledgeFolder(entry);
  const indent = depth * 14 + 8;

  return (
    <div
      className={`knowledge-tree-row${selected ? " knowledge-tree-row--active" : ""}${
        dropHint?.targetId === entry.id && dropHint.position === "inside"
          ? " knowledge-tree-row--drop-inside"
          : ""
      }${
        dropHint?.targetId === entry.id && dropHint.position === "before"
          ? " knowledge-tree-row--drop-before"
          : ""
      }${
        dropHint?.targetId === entry.id && dropHint.position === "after"
          ? " knowledge-tree-row--drop-after"
          : ""
      }`}
      style={{ paddingLeft: indent }}
      draggable
      onDragStart={(e) => onDragStart(entry.id, e)}
      onDragOver={(e) => onDragOver(entry.id, e)}
      onDrop={(e) => onDrop(entry.id, e)}
      onDragEnd={onDragEnd}
      onContextMenu={(e) => onContextMenu(entry, e)}
      onClick={() => onSelect(entry.id)}
    >
      <button
        type="button"
        className={`knowledge-tree-arrow${expanded ? " knowledge-tree-arrow--open" : ""}${!isFolder ? " knowledge-tree-arrow--leaf" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          if (isFolder) onToggle(entry.id);
        }}
        tabIndex={-1}
        aria-hidden
      >
        {isFolder ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
            <path d="M9 18l6-6-6-6" />
          </svg>
        ) : (
          <span className="knowledge-tree-dot" />
        )}
      </button>
      <span className="knowledge-tree-icon">{isFolder ? <FolderIcon /> : <DocIcon />}</span>
      <span className="knowledge-tree-label">{entry.title}</span>
    </div>
  );
}

function renderTreeNodes(
  nodes: KnowledgeTreeNode[],
  opts: Omit<TreeRowProps, "node" | "depth" | "expanded" | "selected"> & {
    depth?: number;
    expandedIds: string[];
    selectedId: string | null;
    onToggle: (id: string) => void;
  },
): React.ReactNode[] {
  const depth = opts.depth ?? 0;
  const rows: React.ReactNode[] = [];
  for (const node of nodes) {
    const id = node.entry.id;
    const expanded = opts.expandedIds.includes(id);
    rows.push(
      <TreeRow
        key={id}
        node={node}
        depth={depth}
        expanded={expanded}
        selected={opts.selectedId === id}
        dropHint={opts.dropHint}
        onSelect={opts.onSelect}
        onToggle={opts.onToggle}
        onContextMenu={opts.onContextMenu}
        onDragStart={opts.onDragStart}
        onDragOver={opts.onDragOver}
        onDrop={opts.onDrop}
        onDragEnd={opts.onDragEnd}
      />,
    );
    if (isKnowledgeFolder(node.entry) && expanded && node.children.length > 0) {
      rows.push(
        ...renderTreeNodes(node.children, {
          ...opts,
          depth: depth + 1,
        }),
      );
    }
  }
  return rows;
}

export function KnowledgeSidebar() {
  const { t } = useI18n();
  const entries = useKnowledgeStore((s) => s.entries);
  const expandedIds = useKnowledgeStore((s) => s.expandedIds);
  const selectedEntryId = useKnowledgeStore((s) => s.selectedEntryId);
  const searchQuery = useKnowledgeStore((s) => s.searchQuery);
  const isLoading = useKnowledgeStore((s) => s.isLoading);
  const setSearchQuery = useKnowledgeStore((s) => s.setSearchQuery);
  const setSelectedEntry = useKnowledgeStore((s) => s.setSelectedEntry);
  const toggleExpanded = useKnowledgeStore((s) => s.toggleExpanded);
  const createFolder = useKnowledgeStore((s) => s.createFolder);
  const createDocument = useKnowledgeStore((s) => s.createDocument);
  const importPdfFromPath = useKnowledgeStore((s) => s.importPdfFromPath);
  const renameEntry = useKnowledgeStore((s) => s.renameEntry);
  const duplicateEntry = useKnowledgeStore((s) => s.duplicateEntry);
  const deleteEntryRecursive = useKnowledgeStore((s) => s.deleteEntryRecursive);
  const moveEntry = useKnowledgeStore((s) => s.moveEntry);

  const modelSelectionId = useKnowledgeEmbeddingModelSelectionId();
  const providers = useAiModelsStore((s) => s.providers);
  const knowledgeChunkSize = useSettingsStore((s) => s.knowledgeChunkSize);
  const knowledgeChunkOverlap = useSettingsStore((s) => s.knowledgeChunkOverlap);

  const [ctxMenu, setCtxMenu] = useState<TreeCtx | null>(null);
  const [blankCtx, setBlankCtx] = useState<{ x: number; y: number } | null>(null);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() => buildKnowledgeTree(entries), [entries]);
  const visibleTree = useMemo(
    () => filterKnowledgeTree(tree, searchQuery),
    [tree, searchQuery],
  );

  const ctxEntry = ctxMenu?.entry ?? null;

  const handleRename = useCallback(
    async (entry: KnowledgeEntry) => {
      const next = await quickInput({
        title: t("knowledge.tree.rename"),
        defaultValue: entry.title,
        validate: (v) => (v.trim() ? null : t("knowledge.titleRequired")),
      });
      if (next) {
        await renameEntry(entry.id, next);
      }
    },
    [renameEntry, t],
  );

  const handleImportPdf = useCallback(
    async (parentId: string) => {
      try {
        const selected = await openFileDialog({
          title: t("knowledge.tree.importPdfDialogTitle"),
          multiple: false,
          directory: false,
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
        if (typeof selected === "string" && selected.length > 0) {
          await importPdfFromPath(selected, parentId);
        }
      } catch {
        // 用户取消选择时不提示
      }
    },
    [importPdfFromPath, t],
  );

  const handleVectorize = useCallback(
    async (entry: KnowledgeEntry) => {
      if (!modelSelectionId) {
        publishModuleStatusLog("knowledge", t("knowledge.vectorize.noModel"), "error");
        return;
      }
      publishModuleStatusLog("knowledge", t("knowledge.vectorize.parsing"), "progress");
      const result = await vectorizeKnowledgeEntry(entry.id, modelSelectionId, providers, {
        knowledgeChunkSize,
        knowledgeChunkOverlap,
      });
      if (result.ok) {
        publishModuleStatusLog(
          "knowledge",
          t("knowledge.vectorize.success", { count: result.chunkCount }),
          "success",
        );
        dispatchKnowledgeVectorized(entry.id);
      } else {
        publishModuleStatusLog("knowledge", result.error, "error");
      }
    },
    [knowledgeChunkOverlap, knowledgeChunkSize, modelSelectionId, providers, t],
  );

  const buildMenuItems = useCallback((): ContextMenuItem[] => {
    if (!ctxEntry) return [];
    const parentId = normalizeParentId(ctxEntry.parentId);
    return [
      {
        id: "new-folder",
        label: t("knowledge.tree.newFolder"),
        onClick: () => void createFolder(isKnowledgeFolder(ctxEntry) ? ctxEntry.id : parentId),
      },
      {
        id: "new-doc",
        label: t("knowledge.tree.newDocument"),
        onClick: () => void createDocument(isKnowledgeFolder(ctxEntry) ? ctxEntry.id : parentId),
      },
      {
        id: "import-pdf",
        label: t("knowledge.tree.importPdf"),
        onClick: () => void handleImportPdf(isKnowledgeFolder(ctxEntry) ? ctxEntry.id : parentId),
      },
      ...(!isKnowledgeFolder(ctxEntry)
        ? [
            { id: "sep-vectorize", separator: true, label: "" } as ContextMenuItem,
            {
              id: "vectorize",
              label: t("knowledge.vectorize.parse"),
              disabled: !modelSelectionId,
              onClick: () => void handleVectorize(ctxEntry),
            },
          ]
        : []),
      { id: "sep1", separator: true, label: "" },
      {
        id: "rename",
        label: t("knowledge.tree.rename"),
        shortcut: "F2",
        onClick: () => void handleRename(ctxEntry),
      },
      {
        id: "copy",
        label: t("knowledge.tree.duplicate"),
        shortcut: "Ctrl+D",
        onClick: () => void duplicateEntry(ctxEntry.id),
      },
      { id: "sep2", separator: true, label: "" },
      {
        id: "delete",
        label: t("knowledge.delete"),
        shortcut: "Del",
        danger: true,
        onClick: () => {
          void (async () => {
            if (!(await appConfirm(t("knowledge.confirmDelete")))) return;
            await deleteEntryRecursive(ctxEntry.id);
          })();
        },
      },
    ];
  }, [
    ctxEntry,
    createDocument,
    createFolder,
    deleteEntryRecursive,
    duplicateEntry,
    handleImportPdf,
    handleRename,
    handleVectorize,
    modelSelectionId,
    t,
  ]);

  const resolveDropPosition = (e: DragEvent, rowEl: HTMLElement): DropHint["position"] => {
    const rect = rowEl.getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (y < rect.height * 0.25) return "before";
    if (y > rect.height * 0.75) return "after";
    return "inside";
  };

  const handleDragStart = (id: string, e: DragEvent) => {
    dragIdRef.current = id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  };

  const handleDragOver = (targetId: string, e: DragEvent) => {
    e.preventDefault();
    const row = e.currentTarget as HTMLElement;
    const position = resolveDropPosition(e, row);
    setDropHint({ targetId, position });
  };

  const handleDrop = async (targetId: string, e: DragEvent) => {
    e.preventDefault();
    const sourceId = dragIdRef.current;
    setDropHint(null);
    dragIdRef.current = null;
    if (!sourceId || sourceId === targetId) return;

    const source = entries.find((x) => x.id === sourceId);
    const target = entries.find((x) => x.id === targetId);
    if (!source || !target) return;

    const row = e.currentTarget as HTMLElement;
    const position = resolveDropPosition(e, row);

    if (position === "inside" && isKnowledgeFolder(target)) {
      await moveEntry(sourceId, targetId, nextSortOrder(entries, targetId));
      return;
    }

    const parentId = normalizeParentId(target.parentId);
    const siblings = entries
      .filter((x) => normalizeParentId(x.parentId) === parentId && x.id !== sourceId)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const targetIndex = siblings.findIndex((x) => x.id === targetId);
    const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
    const reordered = [...siblings];
    reordered.splice(insertIndex, 0, source);
    for (let i = 0; i < reordered.length; i += 1) {
      const item = reordered[i];
      await moveEntry(item.id, parentId, i);
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!selectedEntryId) return;
      const entry = entries.find((x) => x.id === selectedEntryId);
      if (!entry) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "F2") {
        e.preventDefault();
        void handleRename(entry);
      } else if (e.key === "Delete") {
        e.preventDefault();
        void (async () => {
          if (!(await appConfirm(t("knowledge.confirmDelete")))) return;
          await deleteEntryRecursive(entry.id);
        })();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        void duplicateEntry(entry.id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteEntryRecursive, duplicateEntry, entries, handleRename, selectedEntryId, t]);

  useEffect(() => {
    if (!showNewMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (newMenuRef.current?.contains(e.target as Node)) return;
      setShowNewMenu(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showNewMenu]);

  const parentForNew = ctxEntry
    ? isKnowledgeFolder(ctxEntry)
      ? ctxEntry.id
      : normalizeParentId(ctxEntry.parentId)
    : selectedEntryId
      ? (() => {
          const sel = entries.find((e) => e.id === selectedEntryId);
          if (!sel) return "";
          return isKnowledgeFolder(sel) ? sel.id : normalizeParentId(sel.parentId);
        })()
      : "";

  return (
    <div className="knowledge-sidebar">
      <div className="knowledge-sidebar-header">
        <h3>{t("knowledge.tabs.library")}</h3>
        <div className="knowledge-sidebar-header-actions" ref={newMenuRef}>
          <Button
            variant="icon"
            size="sm"
            title={t("knowledge.tree.new")}
            onClick={() => setShowNewMenu((v) => !v)}
          >
            +
          </Button>
          {showNewMenu && (
            <div className="knowledge-new-menu">
              <button type="button" onClick={() => { setShowNewMenu(false); void createFolder(parentForNew); }}>
                {t("knowledge.tree.newFolder")}
              </button>
              <button type="button" onClick={() => { setShowNewMenu(false); void createDocument(parentForNew); }}>
                {t("knowledge.tree.newDocument")}
              </button>
              <button type="button" onClick={() => { setShowNewMenu(false); void handleImportPdf(parentForNew); }}>
                {t("knowledge.tree.importPdf")}
              </button>
            </div>
          )}
        </div>
      </div>

      <ScopedSearch
        className="knowledge-tree-scoped-search"
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder={t("knowledge.searchPlaceholder")}
      >
        <div
          className="knowledge-tree"
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest(".knowledge-tree-row")) return;
            e.preventDefault();
            setBlankCtx({ x: e.clientX, y: e.clientY });
          }}
        >
          {isLoading && entries.length === 0 ? (
            <div className="knowledge-tree-empty">{t("common.loading")}</div>
          ) : visibleTree.length === 0 ? (
            <div className="knowledge-tree-empty">
              {searchQuery.trim() ? t("knowledge.noResults") : t("knowledge.noEntries")}
            </div>
          ) : (
            renderTreeNodes(visibleTree, {
              expandedIds,
              selectedId: selectedEntryId,
              dropHint,
              onSelect: (id) => {
                const item = entries.find((e) => e.id === id);
                if (item && isKnowledgeFolder(item)) {
                  toggleExpanded(id);
                }
                setSelectedEntry(id);
              },
              onToggle: toggleExpanded,
              onContextMenu: (entry, e) => {
                e.preventDefault();
                e.stopPropagation();
                setCtxMenu({ x: e.clientX, y: e.clientY, entry });
              },
              onDragStart: handleDragStart,
              onDragOver: handleDragOver,
              onDrop: handleDrop,
              onDragEnd: () => {
                dragIdRef.current = null;
                setDropHint(null);
              },
            })
          )}
        </div>
      </ScopedSearch>

      {ctxMenu && (
        <ContextMenu
          items={buildMenuItems()}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
          className="context-menu--wide"
        />
      )}

      {blankCtx && (
        <ContextMenu
          items={[
            {
              id: "blank-folder",
              label: t("knowledge.tree.newFolder"),
              onClick: () => void createFolder(parentForNew),
            },
            {
              id: "blank-doc",
              label: t("knowledge.tree.newDocument"),
              onClick: () => void createDocument(parentForNew),
            },
            {
              id: "blank-import-pdf",
              label: t("knowledge.tree.importPdf"),
              onClick: () => void handleImportPdf(parentForNew),
            },
          ]}
          position={blankCtx}
          onClose={() => setBlankCtx(null)}
        />
      )}
    </div>
  );
}
