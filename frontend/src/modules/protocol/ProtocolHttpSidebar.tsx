import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/menu/ContextMenu";
import {
  VerticalSplitSidebar,
  VerticalSplitSidebarSection,
  usePersistedVerticalSplitSections,
} from "../../components/ui/sidebar/VerticalSplitSidebar";
import { quickInput } from "../../lib/quickInput";
import { appConfirm } from "../../lib/appConfirm";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { IconFolder } from "../../components/ui/icons/Icons";
import { ProtocolSidebarNewButton } from "./ProtocolSidebarNewButton";
import {
  useProtocolHttpLayoutStore,
  type ProtocolDropTarget,
  type ProtocolTreeNodeKey,
} from "../../stores/protocolHttpLayoutStore";
import {
  beforeKeyForAfterPosition,
  filterHistoryForRequest,
  formatMethodBadge,
  formatProtocolBadge,
  listProtocolTreeChildren,
  listSiblingKeys,
  methodColor,
  protocolColor,
  resolveEntryParent,
  resolveTreeEntryByKey,
  type ProtocolTreeEntry,
} from "./protocolLayoutTree";
import { ProtocolTreeNode } from "./ProtocolTreeNode";
import { SidebarTreeSelectionProvider } from "@/components/ui/sidebar-tree";
import { useProtocolHttpOptional } from "./ProtocolHttpContext";
import {
  formatHistoryEntryDate,
  historyEntryDisplayLabel,
  resolveHistoryEnvironmentName,
} from "./httpResponseState";
import { formatHttpBodySize } from "./httpJsonBody";
import { useProtocolTopbarStore } from "../../stores/protocolTopbarStore";
import { useProtocolWorkspaceStore } from "../../stores/protocolWorkspaceStore";
import { useProtocolLabEntryStore } from "../../stores/protocolLabEntryStore";
import {
  PROTO_TREE_POINTER_DRAG_THRESHOLD_PX,
  isProtocolTreePointerDragExcluded,
  resolveProtocolTreeDropFromPointer,
  type ProtocolTreePointerDropTarget,
} from "./protocolTreePointerDnD";
import { PROTO_TREE_DND_DEBUG, dndLog } from "./protocolTreeDnDDebug";

const SECTION_STORAGE_KEY = "omnipanel-protocol-http-sidebar-sections.v2";

type ContextTarget =
  | { kind: "root" }
  | { kind: "folder"; folderId: string }
  | { kind: "request"; requestId: string }
  | { kind: "entry"; entryId: string }
  | { kind: "history"; historyId: string; requestId: string | null }
  | { kind: "history-section"; requestId: string };

type DropHint = {
  targetKey: ProtocolTreeNodeKey;
  position: "before" | "after" | "inside";
};

function resolveFolderParent(target: ContextTarget): string | null {
  if (target.kind === "folder") return target.folderId;
  return null;
}

function dropHintClass(entryKey: ProtocolTreeNodeKey, dropHint: DropHint | null): string {
  if (!dropHint || dropHint.targetKey !== entryKey) return "";
  if (dropHint.position === "before") return " tree-node--drop-before";
  if (dropHint.position === "after") return " tree-node--drop-after";
  return " tree-node--drop-inside";
}

export function ProtocolHttpSidebar() {
  const { t } = useI18n();
  const http = useProtocolHttpOptional();
  const openSessionTab = useProtocolWorkspaceStore((s) => s.openSessionTab);
  const activeWorkspaceTabId = useProtocolWorkspaceStore((s) => s.activeTabId);
  const labEntries = useProtocolLabEntryStore((s) => s.entries);
  const renameLabEntry = useProtocolLabEntryStore((s) => s.renameEntry);
  const deleteLabEntry = useProtocolLabEntryStore((s) => s.deleteEntry);
  const closeWorkspaceTab = useProtocolWorkspaceStore((s) => s.closeTab);
  const workspaceTabsForClose = useProtocolWorkspaceStore((s) => s.tabs);
  const requestNewRequestPicker = useProtocolTopbarStore((s) => s.requestNewRequestPicker);
  const { sections, toggleSection, setSectionExpanded } = usePersistedVerticalSplitSections(
    SECTION_STORAGE_KEY,
    { apis: true, history: true },
  );

  const folders = useProtocolHttpLayoutStore((s) => s.folders);
  const collectionParents = useProtocolHttpLayoutStore((s) => s.collectionParents);
  const requestParents = useProtocolHttpLayoutStore((s) => s.requestParents);
  const entryParents = useProtocolHttpLayoutStore((s) => s.entryParents);
  const siblingOrder = useProtocolHttpLayoutStore((s) => s.siblingOrder);
  const addFolder = useProtocolHttpLayoutStore((s) => s.addFolder);
  const renameFolder = useProtocolHttpLayoutStore((s) => s.renameFolder);
  const deleteFolder = useProtocolHttpLayoutStore((s) => s.deleteFolder);
  const placeNode = useProtocolHttpLayoutStore((s) => s.placeNode);
  const toggleFolderExpanded = useProtocolHttpLayoutStore((s) => s.toggleFolderExpanded);
  const ensureFolderExpanded = useProtocolHttpLayoutStore((s) => s.ensureFolderExpanded);
  const expandedFolderIds = useProtocolHttpLayoutStore((s) => s.expandedFolderIds);

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; target: ContextTarget } | null>(
    null,
  );
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const [draggingKey, setDraggingKey] = useState<ProtocolTreeNodeKey | null>(null);
  const [isPointerDragging, setIsPointerDragging] = useState(false);
  const treeRootRef = useRef<HTMLDivElement>(null);
  const pointerDragRef = useRef<{
    sourceKey: ProtocolTreeNodeKey;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const skipNextClickRef = useRef(false);

  useEffect(() => {
    dndLog("debug-ready", {
      enabled: PROTO_TREE_DND_DEBUG,
      mode: "pointer",
      hint: "Tauri WebView2 不触发 HTML5 dragover，已改用 Pointer 拖拽；Console 过滤 protocol-tree-dnd",
    });
  }, []);

  const workspaceTabs = workspaceTabsForClose;

  const collections = http?.collections ?? [];
  const savedRequests = http?.savedRequests ?? [];
  const history = http?.history ?? [];
  const environments = http?.environments ?? [];
  const activeWorkspaceTab = useMemo(
    () => workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? null,
    [activeWorkspaceTabId, workspaceTabs],
  );

  const selectedResourceId = activeWorkspaceTab?.resourceId ?? null;

  const selectedRequestId = useMemo(() => {
    if (activeWorkspaceTab?.protocol === "http" && activeWorkspaceTab.resourceId) {
      return activeWorkspaceTab.resourceId;
    }
    return null;
  }, [activeWorkspaceTab]);

  const selectedRequest = useMemo(
    () => savedRequests.find((req) => req.id === selectedRequestId) ?? null,
    [savedRequests, selectedRequestId],
  );

  const requestHistory = useMemo(
    () => filterHistoryForRequest(history, selectedRequest),
    [history, selectedRequest],
  );

  const treeContext = useMemo(
    () => ({
      folders,
      collections,
      savedRequests,
      labEntries,
      collectionParents,
      requestParents,
      entryParents,
      siblingOrder,
    }),
    [
      folders,
      collections,
      savedRequests,
      labEntries,
      collectionParents,
      requestParents,
      entryParents,
      siblingOrder,
    ],
  );

  const rootChildren = useMemo(
    () =>
      listProtocolTreeChildren(
        null,
        folders,
        collections,
        savedRequests,
        collectionParents,
        requestParents,
        entryParents,
        labEntries,
        siblingOrder,
      ),
    [
      folders,
      collections,
      savedRequests,
      collectionParents,
      requestParents,
      entryParents,
      labEntries,
      siblingOrder,
    ],
  );

  const handleCreateFolder = useCallback(
    async (parentId: string | null) => {
      const name = await quickInput({
        title: t("protocol.sidebar.newFolderTitle"),
        placeholder: t("protocol.sidebar.folderNamePlaceholder"),
        defaultValue: t("protocol.sidebar.defaultFolderName"),
        validate: (value) => (value.trim() ? null : t("protocol.sidebar.folderNameRequired")),
      });
      if (!name) return;
      addFolder(parentId, name.trim());
    },
    [addFolder, t],
  );

  const handleCreateRequest = useCallback(
    (parentFolderId: string | null) => {
      requestNewRequestPicker(parentFolderId);
    },
    [requestNewRequestPicker],
  );

  void useCallback(() => {
    requestNewRequestPicker(null);
  }, [requestNewRequestPicker]);

  const handleSelectEntry = useCallback(
    (entry: (typeof labEntries)[number]) => {
      openSessionTab({
        protocol: entry.protocol,
        resourceId: entry.id,
        label: entry.name,
      });
      if (entry.protocol === "http") {
        setSectionExpanded("history", true);
      }
    },
    [openSessionTab, setSectionExpanded],
  );

  const handleSelectRequest = useCallback(
    (req: (typeof savedRequests)[number]) => {
      openSessionTab({
        protocol: "http",
        resourceId: req.id,
        label: req.name,
      });
      setSectionExpanded("history", true);
    },
    [openSessionTab, setSectionExpanded],
  );

  const applyMove = useCallback(
    async (
      sourceKey: ProtocolTreeNodeKey,
      target: ProtocolDropTarget,
      beforeKey: ProtocolTreeNodeKey | null,
    ) => {
      if (sourceKey.startsWith("request:")) {
        const requestId = sourceKey.slice("request:".length);
        if (target.kind === "collection") {
          await http?.updateRequestCollection(requestId, target.collectionId);
        } else {
          await http?.updateRequestCollection(requestId, null);
        }
      }
      placeNode(sourceKey, target, beforeKey);
    },
    [http, placeNode],
  );

  const handleTreeDrop = useCallback(
    async (
      sourceKey: ProtocolTreeNodeKey,
      targetEntry: ProtocolTreeEntry,
      position: "before" | "after" | "inside",
    ) => {
      if (sourceKey === targetEntry.key) return;

      if (position === "inside") {
        if (targetEntry.kind === "folder") {
          ensureFolderExpanded(targetEntry.folder.id);
          await applyMove(sourceKey, { kind: "folder", folderId: targetEntry.folder.id }, null);
        }
        return;
      }

      const parent = resolveEntryParent(
        targetEntry,
        requestParents,
        collectionParents,
        entryParents,
      );
      const siblingKeys = listSiblingKeys(
        parent,
        folders,
        collections,
        savedRequests,
        collectionParents,
        requestParents,
        entryParents,
        labEntries,
        siblingOrder,
      );
      const beforeKey =
        position === "before"
          ? targetEntry.key
          : beforeKeyForAfterPosition(targetEntry.key, siblingKeys);
      await applyMove(sourceKey, parent, beforeKey);
    },
    [
      applyMove,
      collectionParents,
      collections,
      entryParents,
      folders,
      labEntries,
      requestParents,
      savedRequests,
      siblingOrder,
      ensureFolderExpanded,
    ],
  );

  const consumeSkipClick = useCallback(() => {
    if (skipNextClickRef.current) {
      skipNextClickRef.current = false;
      return true;
    }
    return false;
  }, []);

  const applyPointerDrop = useCallback(
    async (sourceKey: ProtocolTreeNodeKey, target: ProtocolTreePointerDropTarget) => {
      if (target.kind === "root") {
        await applyMove(sourceKey, { kind: "root" }, null);
        return;
      }
      if (sourceKey === target.targetKey) return;
      const entry = resolveTreeEntryByKey(
        target.targetKey,
        folders,
        savedRequests,
        labEntries,
      );
      if (!entry) {
        dndLog("pointer-drop:reject", { reason: "entry-not-found", targetKey: target.targetKey });
        return;
      }
      await handleTreeDrop(sourceKey, entry, target.position);
    },
    [applyMove, collections, folders, handleTreeDrop, savedRequests],
  );

  const cleanupPointerDrag = useCallback(() => {
    pointerDragRef.current = null;
    setDraggingKey(null);
    setIsPointerDragging(false);
    setDropHint(null);
    document.body.classList.remove("proto-tree--pointer-dragging");
    document.body.style.cursor = "";
  }, []);

  const onNodePointerDown = useCallback((event: ReactPointerEvent, key: ProtocolTreeNodeKey) => {
    if (event.button !== 0) return;
    if (isProtocolTreePointerDragExcluded(event.target)) return;
    pointerDragRef.current = {
      sourceKey: key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
  }, []);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const session = pointerDragRef.current;
      if (!session || event.pointerId !== session.pointerId) return;

      const dx = event.clientX - session.startX;
      const dy = event.clientY - session.startY;
      if (!session.active) {
        if (Math.hypot(dx, dy) < PROTO_TREE_POINTER_DRAG_THRESHOLD_PX) return;
        session.active = true;
        setDraggingKey(session.sourceKey);
        setIsPointerDragging(true);
        document.body.classList.add("proto-tree--pointer-dragging");
        document.body.style.cursor = "grabbing";
        dndLog("pointer-drag:start", { sourceKey: session.sourceKey });
      }

      event.preventDefault();
      const hit = resolveProtocolTreeDropFromPointer(
        event.clientX,
        event.clientY,
        treeRootRef.current,
      );
      if (!hit || hit.kind === "root") {
        setDropHint(null);
        if (hit?.kind === "root") {
          dndLog("pointer-drag:hover", { target: "root" }, "hover:root");
        }
        return;
      }
      setDropHint({ targetKey: hit.targetKey, position: hit.position });
      dndLog(
        "pointer-drag:hover",
        { targetKey: hit.targetKey, position: hit.position },
        `hover:${hit.targetKey}`,
      );
    };

    const finishPointerDrag = (event: PointerEvent) => {
      const session = pointerDragRef.current;
      if (!session || event.pointerId !== session.pointerId) return;

      if (session.active) {
        const hit = resolveProtocolTreeDropFromPointer(
          event.clientX,
          event.clientY,
          treeRootRef.current,
        );
        dndLog("pointer-drag:finish", { sourceKey: session.sourceKey, hit });
        if (hit) {
          skipNextClickRef.current = true;
          void applyPointerDrop(session.sourceKey, hit);
        }
      }

      cleanupPointerDrag();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishPointerDrag);
    window.addEventListener("pointercancel", finishPointerDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishPointerDrag);
      window.removeEventListener("pointercancel", finishPointerDrag);
      cleanupPointerDrag();
    };
  }, [applyPointerDrop, cleanupPointerDrag]);

  const openContextMenu = useCallback((event: MouseEvent, target: ContextTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setCtxMenu({ x: event.clientX, y: event.clientY, target });
  }, []);

  const ctxItems = useMemo((): ContextMenuItem[] => {
    if (!ctxMenu) return [];
    const target = ctxMenu.target;
    const parentFolderId = resolveFolderParent(target);
    const items: ContextMenuItem[] = [];

    if (target.kind === "root" || target.kind === "folder") {
      items.push(
        {
          id: "new-folder",
          label: t("protocol.sidebar.newFolder"),
          onClick: () => void handleCreateFolder(parentFolderId),
        },
        {
          id: "new-request",
          label: t("protocol.sidebar.newRequest"),
          onClick: () => handleCreateRequest(parentFolderId),
        },
      );
    }

    if (target.kind === "folder") {
      items.push({
        id: "rename-folder",
        label: t("protocol.sidebar.renameFolder"),
        onClick: () => {
          const folder = folders.find((f) => f.id === target.folderId);
          if (!folder) return;
          void quickInput({
            title: t("protocol.sidebar.renameFolderTitle"),
            defaultValue: folder.name,
            validate: (value) => (value.trim() ? null : t("protocol.sidebar.folderNameRequired")),
          }).then((name) => {
            if (!name) return;
            renameFolder(target.folderId, name.trim());
          });
        },
      });
      items.push({
        id: "delete-folder",
        label: t("protocol.sidebar.deleteFolder"),
        danger: true,
        onClick: () => {
          void appConfirm(
            t("protocol.sidebar.deleteFolderConfirm"),
            t("protocol.sidebar.deleteFolderTitle"),
          ).then((ok) => {
            if (ok) deleteFolder(target.folderId);
          });
        },
      });
    }

    if (target.kind === "request" && http) {
      items.push({
        id: "rename-request",
        label: t("protocol.sidebar.renameRequest"),
        onClick: () => {
          const req = savedRequests.find((entry) => entry.id === target.requestId);
          if (!req) return;
          void quickInput({
            title: t("protocol.sidebar.renameRequestTitle"),
            defaultValue: req.name,
            validate: (value) => (value.trim() ? null : t("protocol.sidebar.folderNameRequired")),
          }).then((name) => {
            if (!name) return;
            void http.renameSavedRequest(target.requestId, name.trim());
          });
        },
      });
      items.push({
        id: "delete-request",
        label: t("protocol.sidebar.deleteRequest"),
        danger: true,
        onClick: () => {
          void appConfirm(
            t("protocol.sidebar.deleteRequestConfirm"),
            t("protocol.sidebar.deleteRequestTitle"),
          ).then((ok) => {
            if (ok) void http.deleteSavedRequest(target.requestId);
          });
        },
      });
    }

    if (target.kind === "entry") {
      items.push({
        id: "rename-entry",
        label: t("protocol.sidebar.renameRequest"),
        onClick: () => {
          const labEntry = labEntries.find((item) => item.id === target.entryId);
          if (!labEntry) return;
          void quickInput({
            title: t("protocol.sidebar.renameRequestTitle"),
            defaultValue: labEntry.name,
            validate: (value) => (value.trim() ? null : t("protocol.sidebar.folderNameRequired")),
          }).then((name) => {
            if (!name) return;
            renameLabEntry(target.entryId, name.trim());
            const tab = workspaceTabsForClose.find(
              (item) => item.resourceId === target.entryId && item.protocol === labEntry.protocol,
            );
            if (tab) {
              useProtocolWorkspaceStore.getState().updateTabLabel(tab.id, name.trim());
            }
          });
        },
      });
      items.push({
        id: "delete-entry",
        label: t("protocol.sidebar.deleteRequest"),
        danger: true,
        onClick: () => {
          void appConfirm(
            t("protocol.sidebar.deleteRequestConfirm"),
            t("protocol.sidebar.deleteRequestTitle"),
          ).then((ok) => {
            if (!ok) return;
            deleteLabEntry(target.entryId);
            for (const tab of workspaceTabsForClose) {
              if (tab.resourceId === target.entryId) {
                closeWorkspaceTab(tab.id);
              }
            }
          });
        },
      });
    }

    if (target.kind === "history" && http) {
      const historyEntry = requestHistory.find((entry) => entry.id === target.historyId);
      items.push({
        id: "rename-history",
        label: t("protocol.sidebar.renameHistory"),
        onClick: () => {
          if (!historyEntry) return;
          void quickInput({
            title: t("protocol.sidebar.renameHistoryTitle"),
            defaultValue: historyEntry.label?.trim() || historyEntryDisplayLabel(historyEntry, environments),
          }).then((name) => {
            if (name == null) return;
            void http.renameHistoryEntry(target.historyId, name.trim());
          });
        },
      });
      items.push({
        id: "delete-history",
        label: t("protocol.sidebar.deleteHistory"),
        danger: true,
        onClick: () => void http.deleteHistoryEntry(target.historyId),
      });
    }

    if (target.kind === "history-section" && http) {
      items.push({
        id: "clear-request-history",
        label: t("protocol.sidebar.clearRequestHistory"),
        danger: true,
        onClick: () => {
          void appConfirm(
            t("protocol.sidebar.clearRequestHistoryConfirm"),
            t("protocol.sidebar.clearRequestHistoryTitle"),
          ).then((ok) => {
            if (ok) void http.clearRequestHistory(target.requestId);
          });
        },
      });
    }

    return items;
  }, [
    ctxMenu,
    t,
    handleCreateFolder,
    handleCreateRequest,
    folders,
    renameFolder,
    deleteFolder,
    http,
    savedRequests,
    labEntries,
    requestHistory,
    environments,
    renameLabEntry,
    deleteLabEntry,
    closeWorkspaceTab,
    workspaceTabsForClose,
  ]);

  const renderTree = useCallback(
    (entries: ProtocolTreeEntry[], depth: number) => {
      return entries.map((entry) => {
        const hintClass = dropHintClass(entry.key, dropHint);
        const draggingClass =
          draggingKey === entry.key ? " tree-node--layout-source-dragging" : "";

        if (entry.kind === "folder") {
          const folderId = entry.folder.id;
          const expanded = expandedFolderIds.includes(folderId);
          const childEntries = listProtocolTreeChildren(
            folderId,
            treeContext.folders,
            treeContext.collections,
            treeContext.savedRequests,
            treeContext.collectionParents,
            treeContext.requestParents,
            treeContext.entryParents,
            treeContext.labEntries,
            treeContext.siblingOrder,
          );
          const hasChildren = childEntries.length > 0;
          return (
            <div key={entry.key}>
              <ProtocolTreeNode
                depth={depth}
                kind="folder"
                expanded={expanded}
                hasChildren={hasChildren}
                label={entry.folder.name}
                icon={<IconFolder size={14} />}
                dataTreeKey={entry.key}
                className={`${hintClass}${draggingClass}`}
                onToggle={() => {
                  if (consumeSkipClick()) return;
                  toggleFolderExpanded(folderId);
                }}
                onPointerDown={(e) => onNodePointerDown(e, entry.key)}
                onContextMenu={(e) => openContextMenu(e, { kind: "folder", folderId })}
              />
              {expanded && hasChildren ? renderTree(childEntries, depth + 1) : null}
            </div>
          );
        }

        if (entry.kind === "request") {
          const req = entry.request;
          const selected = selectedResourceId === req.id;
          return (
            <ProtocolTreeNode
              key={entry.key}
              depth={depth}
              kind="request"
              expanded={false}
              hasChildren={false}
              active={selected}
              label={req.name}
              prefix={
                <span className="h-method" style={{ color: methodColor(req.method) }}>
                  {formatMethodBadge(req.method)}
                </span>
              }
              dataTreeKey={entry.key}
              className={`${hintClass}${draggingClass}`}
              onToggle={() => {}}
              onActivate={() => {
                if (consumeSkipClick()) return;
                handleSelectRequest(req);
              }}
              onPointerDown={(e) => onNodePointerDown(e, entry.key)}
              onContextMenu={(e) => openContextMenu(e, { kind: "request", requestId: req.id })}
            />
          );
        }

        const labEntry = entry.entry;
        const selected = selectedResourceId === labEntry.id;
        return (
          <ProtocolTreeNode
            key={entry.key}
            depth={depth}
            kind="entry"
            expanded={false}
            hasChildren={false}
            active={selected}
            label={labEntry.name}
            prefix={
              <span className="h-method" style={{ color: protocolColor(labEntry.protocol) }}>
                {formatProtocolBadge(labEntry.protocol)}
              </span>
            }
            dataTreeKey={entry.key}
            className={`${hintClass}${draggingClass}`}
            onToggle={() => {}}
            onActivate={() => {
              if (consumeSkipClick()) return;
              handleSelectEntry(labEntry);
            }}
            onPointerDown={(e) => onNodePointerDown(e, entry.key)}
            onContextMenu={(e) => openContextMenu(e, { kind: "entry", entryId: labEntry.id })}
          />
        );
      });
    },
    [
      treeContext,
      dropHint,
      draggingKey,
      selectedResourceId,
      expandedFolderIds,
      onNodePointerDown,
      openContextMenu,
      consumeSkipClick,
      toggleFolderExpanded,
      handleSelectRequest,
      handleSelectEntry,
    ],
  );

  return (
    <aside
      className="proto-sidebar proto-sidebar--tree"
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest(".tree-node, .history-item, .vsplit-sidebar-section__header")) {
          return;
        }
        openContextMenu(e, { kind: "root" });
      }}
    >
      <VerticalSplitSidebar className="proto-sidebar-sections">
        <VerticalSplitSidebarSection
          title={t("protocol.sidebar.protocolList")}
          expanded={sections.apis}
          onToggle={() => toggleSection("apis")}
          actions={<ProtocolSidebarNewButton />}
        >
          <SidebarTreeSelectionProvider>
          <div
            ref={treeRootRef}
            className={`proto-tree-root${isPointerDragging && dropHint === null ? " proto-tree-root--drag-active" : ""}`}
            onContextMenu={(e) => openContextMenu(e, { kind: "root" })}
          >
            {rootChildren.length === 0 ? (
              <div className="proto-empty">{t("protocol.sidebar.protocolListEmpty")}</div>
            ) : (
              renderTree(rootChildren, 0)
            )}
          </div>
          </SidebarTreeSelectionProvider>
        </VerticalSplitSidebarSection>

        <VerticalSplitSidebarSection
          title={t("protocol.sidebar.history")}
          expanded={sections.history}
          onToggle={() => toggleSection("history")}
          actions={
            <div className="schema-toolbar schema-toolbar--inline">
              <button
                type="button"
                className="proto-sidebar-new"
                title={t("protocol.sidebar.clearRequestHistory")}
                aria-label={t("protocol.sidebar.clearRequestHistory")}
                disabled={!selectedRequest || requestHistory.length === 0 || !http}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!selectedRequest || !http) return;
                  void appConfirm(
                    t("protocol.sidebar.clearRequestHistoryConfirm"),
                    t("protocol.sidebar.clearRequestHistoryTitle"),
                  ).then((ok) => {
                    if (ok) void http.clearRequestHistory(selectedRequest.id);
                  });
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M3 6h18" />
                  <path d="M8 6V4h8v2" />
                  <path d="M19 6l-1 14H6L5 6" />
                  <path d="M10 11v6M14 11v6" />
                </svg>
              </button>
            </div>
          }
        >
          <div
            className="proto-sidebar-history-wrap"
            onContextMenu={(e) => {
              if (!selectedRequest) return;
              if ((e.target as HTMLElement).closest(".history-item")) return;
              openContextMenu(e, { kind: "history-section", requestId: selectedRequest.id });
            }}
          >
          {!selectedRequest ? (
            <div className="proto-empty">{t("protocol.sidebar.selectRequestForHistory")}</div>
          ) : requestHistory.length === 0 ? (
            <div className="proto-empty">{t("protocol.sidebar.noRequestHistory")}</div>
          ) : (
            <div className="proto-sidebar-history">
              {requestHistory.map((entry) => {
                const displayName = historyEntryDisplayLabel(entry, environments);
                const environmentName = resolveHistoryEnvironmentName(entry, environments);
                const requestDate = formatHistoryEntryDate(entry.createdAt);
                return (
                <div
                  key={entry.id}
                  className="history-item"
                  onClick={() => http?.applyHistoryEntry(entry)}
                  onContextMenu={(e) => {
                    openContextMenu(e, {
                      kind: "history",
                      historyId: entry.id,
                      requestId: entry.requestId,
                    });
                  }}
                >
                  <div className="history-item-head">
                    <div className="history-item-name" title={displayName}>
                      {displayName}
                    </div>
                    <span
                      className="history-item-env"
                      title={environmentName ?? t("protocol.sidebar.historyNoEnvironment")}
                    >
                      {environmentName ?? t("protocol.sidebar.historyNoEnvironment")}
                    </span>
                  </div>
                  <div className="history-item-details">
                    <span className="history-item-detail history-item-date" title={requestDate}>
                      {requestDate}
                    </span>
                    <span className="history-item-detail history-item-time">
                      {entry.responseTimeMs != null ? `${entry.responseTimeMs}ms` : "—"}
                    </span>
                    <span className="history-item-detail history-item-size">
                      {entry.responseSize != null ? formatHttpBodySize(entry.responseSize) : "—"}
                    </span>
                    <span
                      className={cn(
                        "history-item-detail history-item-status",
                        entry.statusCode != null &&
                          (entry.statusCode < 400 ? "history-item-status--ok" : "history-item-status--err"),
                      )}
                    >
                      {entry.statusCode != null ? entry.statusCode : "—"}
                    </span>
                  </div>
                </div>
                );
              })}
            </div>
          )}
          </div>
        </VerticalSplitSidebarSection>
      </VerticalSplitSidebar>

      {ctxMenu ? (
        <ContextMenu
          items={ctxItems}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}
    </aside>
  );
}
