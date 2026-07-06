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
import {
  usePersistedVerticalSplitSections,
  VerticalSplitSidebar,
  VerticalSplitSidebarSection,
} from "../../components/ui/VerticalSplitSidebar";
import { useKnowledgeEmbeddingProviderConfig } from "../../components/knowledge/KnowledgeEmbeddingModelSelect";
import { useI18n } from "../../i18n";
import { quickInput } from "../../lib/quickInput";
import { appConfirm } from "../../lib/appConfirm";
import { publishModuleStatusLog } from "../../lib/moduleStatusLog";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { KnowledgeEntry } from "../../ipc/bindings";
import {
  buildKnowledgeTree,
  filterEntriesForLibrarySection,
  filterKnowledgeTree,
  isKnowledgeFolder,
  isKnowledgeImported,
  knowledgeLibrarySectionForEntry,
  nextSortOrder,
  normalizeParentId,
  type KnowledgeLibrarySection,
  type KnowledgeTreeNode,
} from "./knowledgeTree";
import { loadKnowledgeVectorStatus, submitKnowledgeVectorize, isKnowledgeEntryVectorizing, subscribeKnowledgeVectorizeState, KNOWLEDGE_VECTORIZED_EVENT, KNOWLEDGE_CHUNKS_CHANGED_EVENT } from "./knowledgeVectorize";
import { useKnowledgeOpenEntry } from "./useKnowledgeOpenEntry";

const SECTION_STORAGE_KEY = "omnipanel-knowledge-sidebar-sections";
const KNOWLEDGE_ROW_CLICK_DELAY_MS = 200;

type SidebarSectionKey = KnowledgeLibrarySection;

function resolveParentForNew(
  sectionEntries: KnowledgeEntry[],
  section: KnowledgeLibrarySection,
  ctxEntry: KnowledgeEntry | null,
  selectedEntryId: string | null,
  allEntries: KnowledgeEntry[],
): string {
  const sectionIds = new Set(sectionEntries.map((entry) => entry.id));
  const entryInSection = (entry: KnowledgeEntry) =>
    section === "imported" ? isKnowledgeImported(entry) : !isKnowledgeImported(entry);

  const pick = (entry: KnowledgeEntry | undefined) => {
    if (!entry || !entryInSection(entry)) return "";
    if (isKnowledgeFolder(entry) && sectionIds.has(entry.id)) return entry.id;
    const parent = normalizeParentId(entry.parentId);
    return sectionIds.has(parent) ? parent : "";
  };

  if (ctxEntry) return pick(ctxEntry);
  if (selectedEntryId) {
    return pick(allEntries.find((entry) => entry.id === selectedEntryId));
  }
  return "";
}

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
  onOpenPreview?: (id: string) => void;
  onOpenPermanent?: (id: string) => void;
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
  onOpenPreview,
  onOpenPermanent,
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
  const clickTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (clickTimerRef.current != null) {
        window.clearTimeout(clickTimerRef.current);
      }
    },
    [],
  );

  const handleRowClick = () => {
    onSelect(entry.id);
    if (isFolder) {
      onToggle(entry.id);
      return;
    }
    if (!onOpenPreview) {
      return;
    }
    if (onOpenPermanent) {
      if (clickTimerRef.current != null) {
        window.clearTimeout(clickTimerRef.current);
      }
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null;
        onOpenPreview(entry.id);
      }, KNOWLEDGE_ROW_CLICK_DELAY_MS);
      return;
    }
    onOpenPreview(entry.id);
  };

  const handleRowDoubleClick = () => {
    if (isFolder || !onOpenPermanent) {
      return;
    }
    if (clickTimerRef.current != null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    onOpenPermanent(entry.id);
  };

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
      onClick={handleRowClick}
      onDoubleClick={handleRowDoubleClick}
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
        onOpenPreview={opts.onOpenPreview}
        onOpenPermanent={opts.onOpenPermanent}
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
  const { openEntry, openEntryChunks } = useKnowledgeOpenEntry();

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

  const embeddingProvider = useKnowledgeEmbeddingProviderConfig();
  const knowledgeChunkSize = useSettingsStore((s) => s.knowledgeChunkSize);
  const knowledgeChunkOverlap = useSettingsStore((s) => s.knowledgeChunkOverlap);

  const [ctxMenu, setCtxMenu] = useState<TreeCtx | null>(null);
  const [ctxVectorized, setCtxVectorized] = useState(false);
  const [blankCtx, setBlankCtx] = useState<{ x: number; y: number; section: KnowledgeLibrarySection } | null>(
    null,
  );
  const [showNewMenuSection, setShowNewMenuSection] = useState<KnowledgeLibrarySection | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const [, setVectorizeTick] = useState(0);

  useEffect(() => subscribeKnowledgeVectorizeState(() => setVectorizeTick((n) => n + 1)), []);

  const { sections, toggleSection, setSectionExpanded } =
    usePersistedVerticalSplitSections<SidebarSectionKey>(SECTION_STORAGE_KEY, {
      selfBuilt: true,
      imported: true,
    });

  const selfBuiltEntries = useMemo(
    () => filterEntriesForLibrarySection(entries, "selfBuilt"),
    [entries],
  );
  const importedEntries = useMemo(
    () => filterEntriesForLibrarySection(entries, "imported"),
    [entries],
  );

  const sectionTrees = useMemo(
    () => ({
      selfBuilt: buildKnowledgeTree(selfBuiltEntries),
      imported: buildKnowledgeTree(importedEntries),
    }),
    [selfBuiltEntries, importedEntries],
  );

  const visibleSectionTrees = useMemo(
    () => ({
      selfBuilt: filterKnowledgeTree(sectionTrees.selfBuilt, searchQuery),
      imported: filterKnowledgeTree(sectionTrees.imported, searchQuery),
    }),
    [sectionTrees, searchQuery],
  );

  const ctxEntry = ctxMenu?.entry ?? null;

  useEffect(() => {
    if (!ctxEntry || isKnowledgeFolder(ctxEntry)) {
      setCtxVectorized(false);
      return;
    }
    let cancelled = false;
    void loadKnowledgeVectorStatus(ctxEntry.id)
      .then((status) => {
        if (!cancelled) {
          setCtxVectorized(Boolean(status?.chunkCount && status.chunkCount > 0));
        }
      })
      .catch(() => {
        if (!cancelled) setCtxVectorized(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ctxEntry?.id]);

  useEffect(() => {
    const onVectorized = (event: Event) => {
      const detail = (event as CustomEvent<{ entryId: string }>).detail;
      if (ctxEntry && detail?.entryId === ctxEntry.id) {
        setCtxVectorized(true);
      }
    };
    const onChunksChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ entryId: string }>).detail;
      if (!ctxEntry || detail?.entryId !== ctxEntry.id) return;
      void loadKnowledgeVectorStatus(ctxEntry.id)
        .then((status) => {
          setCtxVectorized(Boolean(status?.chunkCount && status.chunkCount > 0));
        })
        .catch(() => setCtxVectorized(false));
    };
    window.addEventListener(KNOWLEDGE_VECTORIZED_EVENT, onVectorized);
    window.addEventListener(KNOWLEDGE_CHUNKS_CHANGED_EVENT, onChunksChanged);
    return () => {
      window.removeEventListener(KNOWLEDGE_VECTORIZED_EVENT, onVectorized);
      window.removeEventListener(KNOWLEDGE_CHUNKS_CHANGED_EVENT, onChunksChanged);
    };
  }, [ctxEntry?.id]);

  const parentForNew = useCallback(
    (section: KnowledgeLibrarySection) => {
      const sectionEntries = section === "imported" ? importedEntries : selfBuiltEntries;
      return resolveParentForNew(
        sectionEntries,
        section,
        ctxEntry,
        selectedEntryId,
        entries,
      );
    },
    [ctxEntry, entries, importedEntries, selectedEntryId, selfBuiltEntries],
  );

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

  const handleCreateDocument = useCallback(
    async (parentId: string) => {
      const entryId = await createDocument(parentId);
      if (entryId) {
        openEntry(entryId, "permanent");
      }
    },
    [createDocument, openEntry],
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
          const entryId = await importPdfFromPath(selected, parentId);
          if (entryId) {
            openEntry(entryId, "permanent");
          }
        }
      } catch {
        // 用户取消选择时不提示
      }
    },
    [importPdfFromPath, openEntry, t],
  );

  const handleVectorize = useCallback(
    async (entry: KnowledgeEntry) => {
      if (!embeddingProvider) {
        publishModuleStatusLog("knowledge", t("knowledge.vectorize.noModel"), "error");
        return;
      }
      try {
        await submitKnowledgeVectorize(entry.id, embeddingProvider, {
          knowledgeChunkSize,
          knowledgeChunkOverlap,
        });
      } catch (err) {
        publishModuleStatusLog("knowledge", err instanceof Error ? err.message : String(err), "error");
      }
    },
    [embeddingProvider, knowledgeChunkOverlap, knowledgeChunkSize, t],
  );

  const buildMenuItems = useCallback((): ContextMenuItem[] => {
    if (!ctxEntry) return [];
    const section = knowledgeLibrarySectionForEntry(ctxEntry);
    const parentId = parentForNew(section);
    const creationItems: ContextMenuItem[] =
      section === "selfBuilt"
        ? [
            {
              id: "new-folder",
              label: t("knowledge.tree.newFolder"),
              onClick: () => void createFolder(parentId),
            },
            {
              id: "new-doc",
              label: t("knowledge.tree.newDocument"),
              onClick: () => void handleCreateDocument(parentId),
            },
          ]
        : [];
    return [
      ...creationItems,
      {
        id: "import-pdf",
        label: t("knowledge.tree.importPdf"),
        onClick: () => void handleImportPdf(parentId),
      },
      ...(!isKnowledgeFolder(ctxEntry)
        ? [
            { id: "sep-vectorize", separator: true, label: "" } as ContextMenuItem,
            {
              id: "vectorize",
              label: t("knowledge.vectorize.parse"),
              shortcut: ctxVectorized ? t("knowledge.vectorize.reparse") : undefined,
              disabled: !embeddingProvider || isKnowledgeEntryVectorizing(ctxEntry.id),
              onClick: () => void handleVectorize(ctxEntry),
            },
            {
              id: "text-chunks",
              label: t("knowledge.chunks.open"),
              disabled: !ctxVectorized,
              onClick: () => openEntryChunks(ctxEntry.id),
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
    handleCreateDocument,
    createFolder,
    deleteEntryRecursive,
    duplicateEntry,
    handleImportPdf,
    handleRename,
    handleVectorize,
    embeddingProvider,
    ctxVectorized,
    openEntryChunks,
    parentForNew,
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

  const handleDrop = async (targetId: string, e: DragEvent, section: KnowledgeLibrarySection) => {
    e.preventDefault();
    const sourceId = dragIdRef.current;
    setDropHint(null);
    dragIdRef.current = null;
    if (!sourceId || sourceId === targetId) return;

    const sectionEntries =
      section === "imported" ? importedEntries : selfBuiltEntries;
    const source = sectionEntries.find((x) => x.id === sourceId);
    const target = sectionEntries.find((x) => x.id === targetId);
    if (!source || !target) return;

    const row = e.currentTarget as HTMLElement;
    const position = resolveDropPosition(e, row);

    if (position === "inside" && isKnowledgeFolder(target)) {
      await moveEntry(sourceId, targetId, nextSortOrder(sectionEntries, targetId));
      return;
    }

    const parentId = normalizeParentId(target.parentId);
    const siblings = sectionEntries
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
    if (!showNewMenuSection) return;
    const onDoc = (e: MouseEvent) => {
      if (newMenuRef.current?.contains(e.target as Node)) return;
      setShowNewMenuSection(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showNewMenuSection]);

  useEffect(() => {
    if (!selectedEntryId) return;
    const entry = entries.find((item) => item.id === selectedEntryId);
    if (!entry) return;
    setSectionExpanded(knowledgeLibrarySectionForEntry(entry), true);
  }, [entries, selectedEntryId, setSectionExpanded]);

  const renderSectionTree = (section: KnowledgeLibrarySection) => {
    const visibleTree = visibleSectionTrees[section];

    return (
      <div
        className="knowledge-tree"
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest(".knowledge-tree-row")) return;
          e.preventDefault();
          setBlankCtx({ x: e.clientX, y: e.clientY, section });
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
            onSelect: setSelectedEntry,
            onOpenPreview: (id) => openEntry(id, "preview"),
            onOpenPermanent: (id) => openEntry(id, "permanent"),
            onToggle: toggleExpanded,
            onContextMenu: (entry, e) => {
              e.preventDefault();
              e.stopPropagation();
              setCtxMenu({ x: e.clientX, y: e.clientY, entry });
            },
            onDragStart: handleDragStart,
            onDragOver: handleDragOver,
            onDrop: (id, e) => void handleDrop(id, e, section),
            onDragEnd: () => {
              dragIdRef.current = null;
              setDropHint(null);
            },
          })
        )}
      </div>
    );
  };

  const renderSelfBuiltActions = () => (
    <div className="schema-toolbar schema-toolbar--inline knowledge-sidebar-section-actions" ref={newMenuRef}>
      <Button
        variant="icon"
        size="sm"
        title={t("knowledge.tree.new")}
        onClick={() =>
          setShowNewMenuSection((current) => (current === "selfBuilt" ? null : "selfBuilt"))
        }
      >
        +
      </Button>
      {showNewMenuSection === "selfBuilt" && (
        <div className="knowledge-new-menu">
          <button
            type="button"
            onClick={() => {
              setShowNewMenuSection(null);
              void createFolder(parentForNew("selfBuilt"));
            }}
          >
            {t("knowledge.tree.newFolder")}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowNewMenuSection(null);
              void handleCreateDocument(parentForNew("selfBuilt"));
            }}
          >
            {t("knowledge.tree.newDocument")}
          </button>
        </div>
      )}
    </div>
  );

  const renderImportedActions = () => (
    <div className="schema-toolbar schema-toolbar--inline knowledge-sidebar-section-actions">
      <Button
        variant="icon"
        size="sm"
        title={t("knowledge.tree.importPdf")}
        onClick={() => void handleImportPdf(parentForNew("imported"))}
      >
        +
      </Button>
    </div>
  );

  return (
    <div className="knowledge-sidebar">
      <ScopedSearch
        className="knowledge-tree-scoped-search"
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder={t("knowledge.searchPlaceholder")}
      >
        <VerticalSplitSidebar className="knowledge-sidebar-sections">
          <VerticalSplitSidebarSection
            title={t("knowledge.sidebar.selfBuilt")}
            expanded={sections.selfBuilt}
            onToggle={() => toggleSection("selfBuilt")}
            actions={renderSelfBuiltActions()}
          >
            {renderSectionTree("selfBuilt")}
          </VerticalSplitSidebarSection>
          <VerticalSplitSidebarSection
            title={t("knowledge.sidebar.imported")}
            expanded={sections.imported}
            onToggle={() => toggleSection("imported")}
            actions={renderImportedActions()}
          >
            {renderSectionTree("imported")}
          </VerticalSplitSidebarSection>
        </VerticalSplitSidebar>
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
          items={
            blankCtx.section === "selfBuilt"
              ? [
                  {
                    id: "blank-folder",
                    label: t("knowledge.tree.newFolder"),
                    onClick: () => void createFolder(parentForNew("selfBuilt")),
                  },
                  {
                    id: "blank-doc",
                    label: t("knowledge.tree.newDocument"),
                    onClick: () => void handleCreateDocument(parentForNew("selfBuilt")),
                  },
                ]
              : [
                  {
                    id: "blank-import-pdf",
                    label: t("knowledge.tree.importPdf"),
                    onClick: () => void handleImportPdf(parentForNew("imported")),
                  },
                ]
          }
          position={blankCtx}
          onClose={() => setBlankCtx(null)}
        />
      )}
    </div>
  );
}
