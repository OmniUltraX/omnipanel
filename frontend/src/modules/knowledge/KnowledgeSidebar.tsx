import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  memo,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { ScopedSearch } from "../../components/ui/ScopedSearch";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/menu";
import { contextMenuIcons } from "../../components/ui/menu/contextMenuIcons";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import {
  buildKnowledgeTree,
  expandAncestorIds,
  filterKnowledgeTree,
  flattenVisibleTree,
  isInsideMirrorSubtree,
  isKnowledgeFolder,
  isMirrorLocked,
  isMirrorSourceRoot,
  mirrorNamespaceOf,
  nextSortOrder,
  normalizeParentId,
  type KnowledgeTreeNode,
} from "./knowledgeTree";
import { useKnowledgeEmbeddingProviderConfig } from "../../components/knowledge/KnowledgeEmbeddingModelSelect";
import { useI18n } from "../../i18n";
import { commands, type KnowledgeSearchResult } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { quickInput } from "../../lib/quickInput";
import { appConfirm } from "../../lib/appConfirm";
import { publishModuleStatusLog } from "../../lib/moduleStatusLog";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { useKnowledgeWorkspaceStore } from "../../stores/knowledgeWorkspaceStore";
import { useShareUiStore } from "../../stores/shareUiStore";
import { GLOBAL_SHARE_MENU_ID } from "../../components/ui/menu/withGlobalShareMenuItem";
import { buildKnowledgeEntrySharePayload } from "../share/resourceShare";
import { useSettingsStore } from "../../stores/settingsStore";
import type { KnowledgeEntry } from "../../ipc/bindings";
import {
  loadKnowledgeVectorStatus,
  submitKnowledgeVectorize,
  isKnowledgeEntryVectorizing,
  subscribeKnowledgeVectorizeState,
  KNOWLEDGE_VECTORIZED_EVENT,
  KNOWLEDGE_CHUNKS_CHANGED_EVENT,
} from "./knowledgeVectorize";
import { exportKnowledgeMarkdown, exportKnowledgePdf } from "./knowledgeExport";
import { KnowledgeSourceConsole } from "./KnowledgeSourceConsole";
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
import { SidebarTreeEmpty } from "@/components/ui/sidebar-tree";
import {
  ModuleSidebarSection,
  ModuleSidebarTreeToolbar,
  SidebarIcon,
} from "@/components/ui/module-sidebar";
import { usePersistedVerticalSplitSections } from "../../components/ui/sidebar/VerticalSplitSidebar";

/** 树行高（min-height 24 + 上下 padding）：固定高度虚拟化不漂移。 */
const KNOWLEDGE_TREE_ROW_HEIGHT = 30;
/** 超过该行数启用虚拟滚动（对齐 database schema 树的 200 行阈值）。 */
const KNOWLEDGE_TREE_VIRTUALIZE_THRESHOLD = 200;

type TreeCtx = {
  x: number;
  y: number;
  entry: KnowledgeEntry;
};

type DropHint = {
  targetId: string;
  position: "before" | "inside" | "after";
};

type TreeRowProps = {
  node: KnowledgeTreeNode;
  depth: number;
  expanded: boolean;
  /** 侧栏多选高亮 */
  selected: boolean;
  /** 右侧工作区当前打开的条目 */
  active: boolean;
  vectorized?: boolean;
  /** 来源根徽标（思源/Obsidian 等），非根为 null */
  mirrorLabel?: string | null;
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
  mirrorLabel,
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
  // 镜像锁定条目不可拖拽（拖走下次同步会被搬回）。
  const draggable = !isMirrorLocked(entry);
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
      hasChildren={isFolder || node.children.length > 0}
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
      icon={isFolder ? <SidebarIcon kind="folder" /> : <SidebarIcon kind="document" />}
      label={entry.title}
      afterLabel={
        <>
          {mirrorLabel ? (
            <span
              className="sidebar-tag-chip knowledge-import-badge"
              title={mirrorLabel}
            >
              {mirrorLabel}
            </span>
          ) : null}
          {!isFolder && vectorized ? (
            <span className="knowledge-tree-vector-dot" title="已向量化" aria-hidden />
          ) : null}
        </>
      }
      draggable={draggable}
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

/**
 * 行级 memo：展开/选中/拖拽提示变化时，只有受影响的行重渲。
 * 要求调用方传入稳定的 node 引用与回调（见下方 useCallback 化）。
 */
const MemoTreeRow = memo(TreeRow);

type RenderTreeRowOpts = Omit<
  TreeRowProps,
  "node" | "depth" | "expanded" | "selected" | "active" | "vectorized" | "mirrorLabel"
> & {
  expandedIds: string[];
  selectedId: string | null;
  activeEntryId: string | null;
  vectorizedIds: ReadonlySet<string>;
  getMirrorLabel: (entry: KnowledgeEntry) => string | null;
  onToggle: (id: string) => void;
};

function renderTreeRow(
  node: KnowledgeTreeNode,
  depth: number,
  opts: RenderTreeRowOpts,
): React.ReactNode {
  const id = node.entry.id;
  return (
    <MemoTreeRow
      key={id}
      node={node}
      depth={depth}
      expanded={opts.expandedIds.includes(id)}
      selected={opts.selectedId === id}
      active={opts.activeEntryId === id}
      vectorized={Boolean(opts.vectorizedIds?.has(id))}
      mirrorLabel={opts.getMirrorLabel(node.entry)}
      dropHint={opts.dropHint}
      onPreviewOpen={opts.onPreviewOpen}
      onActivate={opts.onActivate}
      onToggle={opts.onToggle}
      onContextMenu={opts.onContextMenu}
      onDragStart={opts.onDragStart}
      onDragOver={opts.onDragOver}
      onDrop={opts.onDrop}
      onDragEnd={opts.onDragEnd}
    />
  );
}

function renderTreeNodes(
  nodes: KnowledgeTreeNode[],
  opts: RenderTreeRowOpts & { depth?: number },
): React.ReactNode[] {
  const depth = opts.depth ?? 0;
  const rows: React.ReactNode[] = [];
  for (const node of nodes) {
    rows.push(renderTreeRow(node, depth, opts));
    // 文档也可能带子项（思源子文档镜像），展开即渲染。
    if (opts.expandedIds.includes(node.entry.id) && node.children.length > 0) {
      rows.push(...renderTreeNodes(node.children, { ...opts, depth: depth + 1 }));
    }
  }
  return rows;
}

export function KnowledgeSidebar() {
  const { t } = useI18n();
  const openShareDialog = useShareUiStore((s) => s.openShareDialog);
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
  const setExpandedIds = useKnowledgeStore((s) => s.setExpandedIds);
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
  const [blankCtx, setBlankCtx] = useState<{ x: number; y: number } | null>(null);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [ksConsoleOpen, setKsConsoleOpen] = useState(false);
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
      // 镜像锁定条目删了会复活：提前滤掉并提示，只删自建部分。
      const locked = ids.filter((id) =>
        entries.some((entry) => entry.id === id && isMirrorLocked(entry)),
      );
      const deletable = ids.filter((id) => !locked.includes(id));
      if (locked.length > 0) {
        publishModuleStatusLog(
          "knowledge",
          t("knowledge.tree.deleteMirrorDenied", { count: String(locked.length) }),
          "info",
        );
      }
      if (deletable.length === 0) return;
      const confirmed = await appConfirm(
        deletable.length === 1 && locked.length === 0
          ? t("knowledge.confirmDelete")
          : t("sidebarTree.confirmDeleteSelected", { count: String(deletable.length) }),
      );
      if (!confirmed) return;
      for (const id of deletable) {
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

  const taggedEntries = useMemo(() => {
    if (!allowedEntryIds) return entries;
    return entries.filter((entry) => {
      if (isKnowledgeFolder(entry)) return true;
      return allowedEntryIds.has(entry.id);
    });
  }, [allowedEntryIds, entries]);

  // 单树：一份 entries 建一棵树（标签/搜索天然跨自建与镜像）。
  const sectionTree = useMemo(() => buildKnowledgeTree(taggedEntries), [taggedEntries]);

  const useFts = searchQuery.trim().length >= 2;
  const visibleTree = useMemo(
    () => (useFts ? sectionTree : filterKnowledgeTree(sectionTree, searchQuery)),
    [sectionTree, searchQuery, useFts],
  );

  // 大树虚拟滚动（阈值以下走普通渲染，行为零变化）。
  const flatRows = useMemo(
    () => flattenVisibleTree(visibleTree, expandedIds),
    [visibleTree, expandedIds],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: flatRows.length > KNOWLEDGE_TREE_VIRTUALIZE_THRESHOLD ? flatRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => KNOWLEDGE_TREE_ROW_HEIGHT,
    getItemKey: (index) => flatRows[index]?.node.entry.id ?? index,
    overscan: 32,
    useFlushSync: false,
  });

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

  /** 新建落点：选中的自建文件夹（或其所在目录），镜像内回落根目录。 */
  const parentForNew = useCallback(() => {
    const pick = (entry: KnowledgeEntry | undefined): string => {
      if (!entry || isMirrorLocked(entry)) {
        // 镜像内不新建：找最近的自建祖先文件夹，没有则根。
        if (entry) {
          const byId = new Map(entries.map((e) => [e.id, e]));
          let current: KnowledgeEntry | undefined = entry;
          const seen = new Set<string>();
          while (current && !seen.has(current.id)) {
            seen.add(current.id);
            const parent = byId.get(normalizeParentId(current.parentId));
            if (parent && !isMirrorLocked(parent) && isKnowledgeFolder(parent)) {
              return parent.id;
            }
            current = parent;
          }
        }
        return "";
      }
      if (isKnowledgeFolder(entry)) return entry.id;
      const parent = entries.find((e) => e.id === normalizeParentId(entry.parentId));
      return parent && !isMirrorLocked(parent) && isKnowledgeFolder(parent) ? parent.id : "";
    };
    if (ctxMenu?.entry) return pick(ctxMenu.entry);
    if (selectedEntryId) {
      return pick(entries.find((entry) => entry.id === selectedEntryId));
    }
    return "";
  }, [ctxMenu, entries, selectedEntryId]);

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
    const parentId = parentForNew();
    const isFolder = isKnowledgeFolder(ctxEntry);
    const locked = isMirrorLocked(ctxEntry);
    // 镜像只读闭环：只留打开/导出/复制标题/向量化/分享；重命名/删除下次同步会还原·复活。
    const creationItems: ContextMenuItem[] = locked
      ? []
      : [
          {
            id: "new-folder",
            label: t("knowledge.tree.newFolder"),
            icon: contextMenuIcons.folder,
            onClick: () => void createFolder(parentId),
          },
          {
            id: "new-doc",
            label: t("knowledge.tree.newDocument"),
            icon: contextMenuIcons.file,
            onClick: () => void handleCreateDocument(parentId),
          },
        ];

    const openItems: ContextMenuItem[] = [
      {
        id: "open-preview",
        label: t("knowledge.tree.openPreview"),
        icon: contextMenuIcons.open,
        onClick: () => openEntry(ctxEntry.id, "preview"),
      },
      {
        id: "open-permanent",
        label: t("knowledge.tree.openPermanent"),
        icon: contextMenuIcons.open,
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
      ...(!locked
        ? [
            {
              id: "import-pdf",
              label: t("knowledge.tree.importPdf"),
              icon: contextMenuIcons.import,
              onClick: () => void handleImportPdf(parentId),
            },
          ]
        : []),
      ...(!isFolder
        ? [
            { id: "sep-export", separator: true, label: "" } as ContextMenuItem,
            {
              id: "export-md",
              label: t("knowledge.export.markdown"),
              icon: contextMenuIcons.export,
              onClick: () => void handleExportMarkdown(ctxEntry),
            },
            {
              id: "export-pdf",
              label: t("knowledge.export.pdf"),
              icon: contextMenuIcons.export,
              onClick: () => void handleExportPdf(ctxEntry),
            },
            {
              id: GLOBAL_SHARE_MENU_ID,
              label: t("share.menu"),
              icon: contextMenuIcons.share,
              onClick: () =>
                openShareDialog(buildKnowledgeEntrySharePayload(ctxEntry)),
            },
            { id: "sep-vectorize", separator: true, label: "" } as ContextMenuItem,
            {
              id: "vectorize",
              label: t("knowledge.vectorize.parse"),
              icon: contextMenuIcons.vectorize,
              shortcut: ctxVectorized ? t("knowledge.vectorize.reparse") : undefined,
              disabled: !embeddingProvider || isKnowledgeEntryVectorizing(ctxEntry.id),
              onClick: () => void handleVectorize(ctxEntry),
            },
            {
              id: "text-chunks",
              label: t("knowledge.chunks.open"),
              icon: contextMenuIcons.list,
              disabled: !ctxVectorized,
              onClick: () => openEntryChunks(ctxEntry.id),
            },
          ]
        : []),
      { id: "sep1", separator: true, label: "" },
      {
        id: "copy-title",
        label: t("knowledge.tree.copyTitle"),
        icon: contextMenuIcons.copy,
        onClick: () => void handleCopyTitle(ctxEntry),
      },
      ...(!locked
        ? [
            {
              id: "rename",
              label: t("knowledge.tree.rename"),
              icon: contextMenuIcons.rename,
              shortcut: "F2",
              onClick: () => void handleRename(ctxEntry),
            },
            {
              id: "copy",
              label: t("knowledge.tree.duplicate"),
              icon: contextMenuIcons.duplicate,
              shortcut: "Ctrl+D",
              onClick: () => void duplicateEntry(ctxEntry.id),
            },
            { id: "sep2", separator: true, label: "" } as ContextMenuItem,
            {
              id: "delete",
              label: t("knowledge.delete"),
              icon: contextMenuIcons.delete,
              shortcut: "Del",
              danger: true,
              onClick: () => {
                void deleteEntries(ctxEntry.id);
              },
            },
          ]
        : !isFolder
          ? [
              {
                id: "convert-local",
                label: t("knowledge.tree.convertToLocal"),
                icon: contextMenuIcons.duplicate,
                onClick: () => void duplicateEntry(ctxEntry.id),
              },
            ]
          : []),
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
    openShareDialog,
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

  const handleDragStart = useCallback((id: string, e: DragEvent) => {
    dragIdRef.current = id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }, []);

  const handleDragOver = useCallback((targetId: string, e: DragEvent) => {
    e.preventDefault();
    const row = e.currentTarget as HTMLElement;
    const position = resolveDropPosition(e, row);
    setDropHint({ targetId, position });
  }, []);

  const handleDrop = useCallback(
    async (targetId: string, e: DragEvent) => {
      e.preventDefault();
      const sourceId = dragIdRef.current;
      setDropHint(null);
      dragIdRef.current = null;
      if (!sourceId || sourceId === targetId) return;

      const source = entries.find((x) => x.id === sourceId);
      const target = entries.find((x) => x.id === targetId);
      if (!source || !target) return;
      // 镜像锁定：拖走下次同步会被搬回，直接拒绝并提示。
      if (isMirrorLocked(source)) {
        publishModuleStatusLog("knowledge", t("knowledge.tree.dragMirrorDenied"), "info");
        return;
      }

      const row = e.currentTarget as HTMLElement;
      const position = resolveDropPosition(e, row);
      // 落点最终父级在镜像子树内 → 拒绝（根级在镜像根前后排序除外）。
      const finalParent =
        position === "inside" ? targetId : normalizeParentId(target.parentId);
      if (finalParent && isInsideMirrorSubtree(finalParent, entries)) {
        publishModuleStatusLog("knowledge", t("knowledge.tree.dropMirrorDenied"), "info");
        return;
      }

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
    },
    [entries, moveEntry, t],
  );

  const handleDragEnd = useCallback(() => {
    dragIdRef.current = null;
    setDropHint(null);
  }, []);

  const handleRowContextMenu = useCallback(
    (entry: KnowledgeEntry, e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setSelectedEntry(entry.id);
      setCtxMenu({ x: e.clientX, y: e.clientY, entry });
    },
    [setSelectedEntry, setCtxMenu],
  );

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
        if (isMirrorLocked(entry)) {
          publishModuleStatusLog("knowledge", t("knowledge.tree.renameMirrorDenied"), "info");
          return;
        }
        void handleRename(entry);
      } else if (e.key === "Delete") {
        e.preventDefault();
        if (isMirrorLocked(entry)) {
          publishModuleStatusLog(
            "knowledge",
            t("knowledge.tree.deleteMirrorDenied", { count: "1" }),
            "info",
          );
          return;
        }
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
    if (!showNewMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (newMenuRef.current?.contains(e.target as Node)) return;
      setShowNewMenu(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showNewMenu]);

  useEffect(() => {
    if (!selectedEntryId) return;
    // 选中即展开祖先链（替代旧分区展开）。
    for (const ancestor of expandAncestorIds(entries, selectedEntryId)) {
      setExpanded(ancestor, true);
    }
  }, [entries, selectedEntryId, setExpanded]);

  /** 来源根徽标文案（思源/Obsidian 等；未知命名空间回落原文）。 */
  const getMirrorLabel = useCallback(
    (entry: KnowledgeEntry): string | null => {
      if (!isMirrorSourceRoot(entry)) return null;
      const ns = mirrorNamespaceOf(entry);
      if (!ns) return null;
      const key = `knowledge.tree.mirrorSources.${ns}`;
      const label = t(key);
      return label === key ? ns : label;
    },
    [t],
  );

  /** 单分组原则：整棵树包一层 L1 段头，通用功能挂载于此。 */
  const { sections, toggleSection } = usePersistedVerticalSplitSections<"library">(
    "omnipanel-knowledge-sidebar-sections",
    { library: true },
  );

  const folderIds = useMemo(
    () => entries.filter((entry) => isKnowledgeFolder(entry)).map((entry) => entry.id),
    [entries],
  );
  const expandAllDisabled =
    folderIds.length === 0 || folderIds.every((id) => expandedIds.includes(id));

  const handleExpandAll = useCallback(() => {
    setExpandedIds(folderIds);
  }, [folderIds, setExpandedIds]);

  const handleCollapseAll = useCallback(() => {
    setExpandedIds([]);
  }, [setExpandedIds]);

  /** Shift 范围选顺序：与当前可见扁平行一致。 */
  const orderedKeys = useMemo(() => flatRows.map((row) => row.node.entry.id), [flatRows]);

  const renderTree = () => {
    const virtualized = flatRows.length > KNOWLEDGE_TREE_VIRTUALIZE_THRESHOLD;
    const rowOpts = {
      expandedIds,
      selectedId: selectedEntryId,
      activeEntryId,
      vectorizedIds,
      getMirrorLabel,
      dropHint,
      onPreviewOpen: handlePreviewOpen,
      onActivate: handleActivate,
      onToggle: toggleExpanded,
      onContextMenu: handleRowContextMenu,
      onDragStart: handleDragStart,
      onDragOver: handleDragOver,
      onDrop: (id: string, e: DragEvent) => void handleDrop(id, e),
      onDragEnd: handleDragEnd,
    };
    return (
      <div
        className="knowledge-tree"
        ref={scrollRef}
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest(".sidebar-tree-node, .tree-node, .knowledge-tree-row")) return;
          e.preventDefault();
          setBlankCtx({ x: e.clientX, y: e.clientY });
        }}
      >
        {isLoading && entries.length === 0 ? (
          <SidebarTreeEmpty>{t("common.loading")}</SidebarTreeEmpty>
        ) : visibleTree.length === 0 ? (
          <SidebarTreeEmpty>
            {searchQuery.trim() ? t("knowledge.noResults") : t("knowledge.noEntries")}
          </SidebarTreeEmpty>
        ) : virtualized ? (
          <div
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = flatRows[virtualRow.index];
              if (!row) return null;
              return (
                <div
                  key={row.node.entry.id}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {renderTreeRow(row.node, row.depth, rowOpts)}
                </div>
              );
            })}
          </div>
        ) : (
          renderTreeNodes(visibleTree, rowOpts)
        )}
      </div>
    );
  };

  const renderSectionActions = () => (
    <>
      <div className="knowledge-sidebar-section-actions" ref={newMenuRef}>
        <WorkbenchActionButton
          icon
          title={t("knowledge.tree.new")}
          aria-label={t("knowledge.tree.new")}
          onClick={() => setShowNewMenu((current) => !current)}
        >
          {contextMenuIcons.plus}
        </WorkbenchActionButton>
        {showNewMenu && (
          <div className="knowledge-new-menu">
            <button
              type="button"
              onClick={() => {
                setShowNewMenu(false);
                void createFolder(parentForNew());
              }}
            >
              {t("knowledge.tree.newFolder")}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowNewMenu(false);
                void handleCreateDocument(parentForNew());
              }}
            >
              {t("knowledge.tree.newDocument")}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowNewMenu(false);
                void handleImportPdf(parentForNew());
              }}
            >
              {t("knowledge.tree.importPdf")}
            </button>
          </div>
        )}
      </div>
      <WorkbenchActionButton
        icon
        title={t("knowledge.ks.openButton")}
        aria-label={t("knowledge.ks.openButton")}
        onClick={() => setKsConsoleOpen(true)}
      >
        {contextMenuIcons.connect}
      </WorkbenchActionButton>
    </>
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
              <SidebarTreeSelectionProvider
                orderedKeys={orderedKeys}
                onSelectedIdsChange={handleSelectedIdsChange}
              >
                <div className="knowledge-sidebar-sections">
                  <ModuleSidebarSection
                    title={t("routes.knowledge")}
                    expanded={sections.library}
                    onToggle={() => toggleSection("library")}
                    count={entries.length}
                    toolbar={
                      <ModuleSidebarTreeToolbar
                        onExpandAll={handleExpandAll}
                        onCollapseAll={handleCollapseAll}
                        expandDisabled={expandAllDisabled}
                        collapseDisabled={expandedIds.length === 0}
                      />
                    }
                    actions={renderSectionActions()}
                  >
                    {renderTree()}
                  </ModuleSidebarSection>
                </div>
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
              items={[
                {
                  id: "blank-folder",
                  label: t("knowledge.tree.newFolder"),
                  icon: contextMenuIcons.folder,
                  onClick: () => void createFolder(parentForNew()),
                },
                {
                  id: "blank-doc",
                  label: t("knowledge.tree.newDocument"),
                  icon: contextMenuIcons.file,
                  onClick: () => void handleCreateDocument(parentForNew()),
                },
                {
                  id: "blank-import-pdf",
                  label: t("knowledge.tree.importPdf"),
                  icon: contextMenuIcons.import,
                  onClick: () => void handleImportPdf(parentForNew()),
                },
              ]}
              position={blankCtx}
              onClose={() => setBlankCtx(null)}
            />
          )}
          <KnowledgeSourceConsole
            open={ksConsoleOpen}
            onClose={() => setKsConsoleOpen(false)}
          />
        </div>
  );
}
