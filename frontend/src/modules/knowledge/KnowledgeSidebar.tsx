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
import { commands, type KnowledgeSearchResult } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { quickInput } from "../../lib/quickInput";
import { appConfirm } from "../../lib/appConfirm";
import { publishModuleStatusLog } from "../../lib/moduleStatusLog";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { useKnowledgeWorkspaceStore } from "../../stores/knowledgeWorkspaceStore";
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
import {
  loadKnowledgeVectorStatus,
  submitKnowledgeVectorize,
  isKnowledgeEntryVectorizing,
  subscribeKnowledgeVectorizeState,
  KNOWLEDGE_VECTORIZED_EVENT,
  KNOWLEDGE_CHUNKS_CHANGED_EVENT,
} from "./knowledgeVectorize";
import { exportKnowledgeMarkdown, exportKnowledgePdf } from "./knowledgeExport";
import { KnowledgeSearchResults } from "./panels/KnowledgeSearchResults";
import { useKnowledgeOpenEntry } from "./useKnowledgeOpenEntry";
import { KNOWLEDGE_TAG_KINDS } from "../tags/tagKinds";
import { useModuleTagFilter } from "../tags/useModuleTagFilter";
import {
  SidebarTreeNode,
  SidebarTreeSelectionProvider,
  resolveSidebarTreeDeleteTargets,
  useSidebarTreeSelection,
} from "@/components/ui/sidebar-tree";
import type { TreeRowMouseEvent } from "@/components/ui/sidebar-tree";

const SECTION_STORAGE_KEY = "omnipanel-knowledge-sidebar-sections";

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
  /** 侧栏多选高亮 */
  selected: boolean;
  /** 右侧工作区当前打开的条目 */
  active: boolean;
  vectorized?: boolean;
  dropHint: DropHint | null;
  /** 单击：选中 + 打开预览 Tab（对齐数据库） */
  onPreviewOpen: (id: string) => void;
  /** 双击：常驻打开 / 文件夹展开 */
  onActivate: (id: string) => void;
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
  active,
  vectorized,
  dropHint,
  onPreviewOpen,
  onActivate,
  onToggle,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: TreeRowProps) {
  const { entry } = node;
  const isFolder = isKnowledgeFolder(entry);
  const selection = useSidebarTreeSelection();

  const handleSelect = (event: TreeRowMouseEvent) => {
    selection?.handleSelect(entry.id, event);
    // 多选修饰键时仅更新选区，不抢开预览
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    onPreviewOpen(entry.id);
  };

  return (
    <SidebarTreeNode
      depth={depth}
      module="knowledge"
      nodeType={isFolder ? "folder" : "document"}
      treeKey={entry.id}
      expanded={expanded}
      hasChildren={isFolder}
      active={active}
      selected={selection?.isSelected(entry.id) ?? selected}
      className={`knowledge-tree-row${active ? " knowledge-tree-row--active" : ""}${
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
      icon={isFolder ? <FolderIcon /> : <DocIcon />}
      label={entry.title}
      afterLabel={
        !isFolder && vectorized ? (
          <span className="knowledge-tree-vector-dot" title="已向量化" aria-hidden />
        ) : null
      }
      draggable
      onDragStart={(event) => onDragStart(entry.id, event)}
      onDragOver={(event) => onDragOver(entry.id, event)}
      onDrop={(event) => onDrop(entry.id, event)}
      onDragEnd={onDragEnd}
      onContextMenu={(event) => onContextMenu(entry, event)}
      onToggle={() => onToggle(entry.id)}
      onSelect={handleSelect}
      onActivate={() => onActivate(entry.id)}
    />
  );
}

function renderTreeNodes(
  nodes: KnowledgeTreeNode[],
  opts: Omit<TreeRowProps, "node" | "depth" | "expanded" | "selected" | "active" | "vectorized"> & {
    depth?: number;
    expandedIds: string[];
    selectedId: string | null;
    activeEntryId: string | null;
    vectorizedIds: ReadonlySet<string>;
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
        active={opts.activeEntryId === id}
        vectorized={Boolean(opts.vectorizedIds?.has(id))}
        dropHint={opts.dropHint}
        onPreviewOpen={opts.onPreviewOpen}
        onActivate={opts.onActivate}
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
  const setExpanded = useKnowledgeStore((s) => s.setExpanded);
  const createFolder = useKnowledgeStore((s) => s.createFolder);
  const createDocument = useKnowledgeStore((s) => s.createDocument);
  const importPdfFromPath = useKnowledgeStore((s) => s.importPdfFromPath);
  const renameEntry = useKnowledgeStore((s) => s.renameEntry);
  const duplicateEntry = useKnowledgeStore((s) => s.duplicateEntry);
  const deleteEntryRecursive = useKnowledgeStore((s) => s.deleteEntryRecursive);
  const moveEntry = useKnowledgeStore((s) => s.moveEntry);

  const workspaceTabs = useKnowledgeWorkspaceStore((s) => s.workspaceTabs);
  const activeTabId = useKnowledgeWorkspaceStore((s) => s.activeTabId);
  const activeEntryId = useMemo(() => {
    const tab = workspaceTabs.find((item) => item.id === activeTabId);
    return tab?.entryId ?? selectedEntryId;
  }, [activeTabId, selectedEntryId, workspaceTabs]);

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
  const [vectorizedIds, setVectorizedIds] = useState<ReadonlySet<string>>(() => new Set());
  const allowedEntryIds = useModuleTagFilter("knowledge", KNOWLEDGE_TAG_KINDS);
  const [ftsResults, setFtsResults] = useState<KnowledgeSearchResult[]>([]);
  const [ftsLoading, setFtsLoading] = useState(false);
  const dragIdRef = useRef<string | null>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const selectedIdsRef = useRef<ReadonlySet<string>>(new Set());
  const [, setVectorizeTick] = useState(0);

  const handleSelectedIdsChange = useCallback((ids: ReadonlySet<string>) => {
    selectedIdsRef.current = ids;
  }, []);

  const markVectorized = useCallback((entryId: string, on: boolean) => {
    setVectorizedIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(entryId);
      else next.delete(entryId);
      return next;
    });
  }, []);

  const deleteEntries = useCallback(
    async (clickedId: string) => {
      const ids = resolveSidebarTreeDeleteTargets(clickedId, selectedIdsRef.current, {
        filter: (id) => entries.some((entry) => entry.id === id),
      });
      if (ids.length === 0) return;
      const confirmed = await appConfirm(
        ids.length === 1
          ? t("knowledge.confirmDelete")
          : t("sidebarTree.confirmDeleteSelected", { count: String(ids.length) }),
      );
      if (!confirmed) return;
      for (const id of ids) {
        await deleteEntryRecursive(id);
      }
    },
    [deleteEntryRecursive, entries, t],
  );

  useEffect(() => subscribeKnowledgeVectorizeState(() => setVectorizeTick((n) => n + 1)), []);

  // 后台批量探测已向量化条目（按 id 集合变化触发，避免保存正文时反复打满）
  const entryIdSignature = useMemo(
    () =>
      entries
        .filter((e) => !isKnowledgeFolder(e))
        .map((e) => e.id)
        .sort()
        .join(","),
    [entries],
  );

  useEffect(() => {
    let cancelled = false;
    const ids = entryIdSignature ? entryIdSignature.split(",") : [];
    if (ids.length === 0) {
      setVectorizedIds(new Set());
      return;
    }
    void (async () => {
      const next = new Set<string>();
      await Promise.all(
        ids.map(async (id) => {
          try {
            const status = await loadKnowledgeVectorStatus(id);
            if (status?.chunkCount && status.chunkCount > 0) next.add(id);
          } catch {
            // ignore
          }
        }),
      );
      if (!cancelled) setVectorizedIds(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [entryIdSignature]);

  useEffect(() => {
    const onVectorized = (event: Event) => {
      const detail = (event as CustomEvent<{ entryId: string }>).detail;
      if (detail?.entryId) markVectorized(detail.entryId, true);
    };
    window.addEventListener(KNOWLEDGE_VECTORIZED_EVENT, onVectorized);
    return () => window.removeEventListener(KNOWLEDGE_VECTORIZED_EVENT, onVectorized);
  }, [markVectorized]);

  const { sections, toggleSection, setSectionExpanded } =
    usePersistedVerticalSplitSections<SidebarSectionKey>(SECTION_STORAGE_KEY, {
      selfBuilt: true,
      imported: true,
    });

  const taggedEntries = useMemo(() => {
    if (!allowedEntryIds) return entries;
    return entries.filter((entry) => {
      if (isKnowledgeFolder(entry)) return true;
      return allowedEntryIds.has(entry.id);
    });
  }, [allowedEntryIds, entries]);

  const selfBuiltEntries = useMemo(
    () => filterEntriesForLibrarySection(taggedEntries, "selfBuilt"),
    [taggedEntries],
  );
  const importedEntries = useMemo(
    () => filterEntriesForLibrarySection(taggedEntries, "imported"),
    [taggedEntries],
  );

  const sectionTrees = useMemo(
    () => ({
      selfBuilt: buildKnowledgeTree(selfBuiltEntries),
      imported: buildKnowledgeTree(importedEntries),
    }),
    [selfBuiltEntries, importedEntries],
  );

  const useFts = searchQuery.trim().length >= 2;
  const visibleSectionTrees = useMemo(
    () => ({
      selfBuilt: useFts ? sectionTrees.selfBuilt : filterKnowledgeTree(sectionTrees.selfBuilt, searchQuery),
      imported: useFts ? sectionTrees.imported : filterKnowledgeTree(sectionTrees.imported, searchQuery),
    }),
    [sectionTrees, searchQuery, useFts],
  );

  useEffect(() => {
    if (!useFts) {
      setFtsResults([]);
      setFtsLoading(false);
      return;
    }
    let cancelled = false;
    setFtsLoading(true);
    const timer = window.setTimeout(() => {
      void unwrapCommand(commands.knowledgeSearch(searchQuery.trim(), null))
        .then((results) => {
          if (cancelled) return;
          const filtered = allowedEntryIds
            ? results.filter((item) => allowedEntryIds.has(item.entry.id))
            : results;
          setFtsResults(filtered);
        })
        .catch(() => {
          if (!cancelled) setFtsResults([]);
        })
        .finally(() => {
          if (!cancelled) setFtsLoading(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [allowedEntryIds, searchQuery, useFts]);

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

  const handleExportMarkdown = useCallback(
    async (entry: KnowledgeEntry) => {
      if (isKnowledgeFolder(entry)) return;
      try {
        const path = await exportKnowledgeMarkdown(entry.title, entry.content ?? "", {
          dialogTitle: t("knowledge.export.markdown"),
        });
        if (path) {
          publishModuleStatusLog("knowledge", t("knowledge.export.markdownDone", { path }), "info");
        }
      } catch (err) {
        publishModuleStatusLog("knowledge", err instanceof Error ? err.message : String(err), "error");
      }
    },
    [t],
  );

  const handleExportPdf = useCallback(
    async (entry: KnowledgeEntry) => {
      if (isKnowledgeFolder(entry)) return;
      try {
        await exportKnowledgePdf(entry.title, entry.content ?? "");
        publishModuleStatusLog("knowledge", t("knowledge.export.pdfStarted"), "info");
      } catch (err) {
        publishModuleStatusLog("knowledge", err instanceof Error ? err.message : String(err), "error");
      }
    },
    [t],
  );

  const handleCopyTitle = useCallback(
    async (entry: KnowledgeEntry) => {
      try {
        await navigator.clipboard.writeText(entry.title);
        publishModuleStatusLog("knowledge", t("knowledge.tree.titleCopied"), "info");
      } catch {
        publishModuleStatusLog("knowledge", t("knowledge.tree.copyFailed"), "error");
      }
    },
    [t],
  );

  /** 单击：文档打开预览 Tab；文件夹仅选中（对齐数据库 object-folder） */
  const handlePreviewOpen = useCallback(
    (id: string) => {
      const entry = entries.find((item) => item.id === id);
      if (!entry) return;
      setSelectedEntry(id);
      if (isKnowledgeFolder(entry)) {
        return;
      }
      openEntry(id, "preview");
    },
    [entries, openEntry, setSelectedEntry],
  );

  /** 双击：文档常驻；文件夹展开并打开概览 */
  const handleActivate = useCallback(
    (id: string) => {
      const entry = entries.find((item) => item.id === id);
      if (!entry) return;
      if (isKnowledgeFolder(entry)) {
        setExpanded(id, true);
        openEntry(id, "permanent");
        return;
      }
      openEntry(id, "permanent");
    },
    [entries, openEntry, setExpanded],
  );

  const buildMenuItems = useCallback((): ContextMenuItem[] => {
    if (!ctxEntry) return [];
    const section = knowledgeLibrarySectionForEntry(ctxEntry);
    const parentId = parentForNew(section);
    const isFolder = isKnowledgeFolder(ctxEntry);
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

    const openItems: ContextMenuItem[] = [
      {
        id: "open-preview",
        label: t("knowledge.tree.openPreview"),
        onClick: () => openEntry(ctxEntry.id, "preview"),
      },
      {
        id: "open-permanent",
        label: t("knowledge.tree.openPermanent"),
        onClick: () => {
          if (isFolder) {
            setExpanded(ctxEntry.id, true);
            openEntry(ctxEntry.id, "permanent");
          } else {
            openEntry(ctxEntry.id, "permanent");
          }
        },
      },
    ];

    return [
      ...openItems,
      { id: "sep-open", separator: true, label: "" },
      ...creationItems,
      {
        id: "import-pdf",
        label: t("knowledge.tree.importPdf"),
        onClick: () => void handleImportPdf(parentId),
      },
      ...(!isFolder
        ? [
            { id: "sep-export", separator: true, label: "" } as ContextMenuItem,
            {
              id: "export-md",
              label: t("knowledge.export.markdown"),
              onClick: () => void handleExportMarkdown(ctxEntry),
            },
            {
              id: "export-pdf",
              label: t("knowledge.export.pdf"),
              onClick: () => void handleExportPdf(ctxEntry),
            },
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
        id: "copy-title",
        label: t("knowledge.tree.copyTitle"),
        onClick: () => void handleCopyTitle(ctxEntry),
      },
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
          void deleteEntries(ctxEntry.id);
        },
      },
    ];
  }, [
    ctxEntry,
    handleCreateDocument,
    createFolder,
    deleteEntries,
    duplicateEntry,
    handleImportPdf,
    handleRename,
    handleVectorize,
    handleExportMarkdown,
    handleExportPdf,
    handleCopyTitle,
    embeddingProvider,
    ctxVectorized,
    openEntry,
    openEntryChunks,
    parentForNew,
    setExpanded,
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
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable) {
        return;
      }

      if (e.key === "F2") {
        e.preventDefault();
        void handleRename(entry);
      } else if (e.key === "Delete") {
        e.preventDefault();
        void deleteEntries(entry.id);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        void duplicateEntry(entry.id);
      } else if (e.key === "Enter") {
        e.preventDefault();
        handleActivate(entry.id);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e" && !isKnowledgeFolder(entry)) {
        e.preventDefault();
        void handleExportPdf(entry);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    deleteEntries,
    duplicateEntry,
    entries,
    handleActivate,
    handleExportPdf,
    handleRename,
    selectedEntryId,
  ]);

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
          if ((e.target as HTMLElement).closest(".sidebar-tree-node, .tree-node, .knowledge-tree-row")) return;
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
            activeEntryId,
            vectorizedIds,
            dropHint,
            onPreviewOpen: handlePreviewOpen,
            onActivate: handleActivate,
            onToggle: toggleExpanded,
            onContextMenu: (entry, e) => {
              e.preventDefault();
              e.stopPropagation();
              setSelectedEntry(entry.id);
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
            {useFts ? (
              <div className="knowledge-sidebar-fts">
                <div className="knowledge-sidebar-fts__title">{t("knowledge.search.results")}</div>
                <KnowledgeSearchResults
                  results={ftsResults}
                  loading={ftsLoading}
                  onOpen={(id) => {
                    setSelectedEntry(id);
                    openEntry(id, "preview");
                  }}
                />
              </div>
            ) : (
              <SidebarTreeSelectionProvider onSelectedIdsChange={handleSelectedIdsChange}>
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
              </SidebarTreeSelectionProvider>
            )}
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
