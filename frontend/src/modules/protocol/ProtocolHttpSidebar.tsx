import {
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
} from "react";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/ContextMenu";
import {
  VerticalSplitSidebar,
  VerticalSplitSidebarSection,
  usePersistedVerticalSplitSections,
} from "../../components/ui/VerticalSplitSidebar";
import { quickInput } from "../../lib/quickInput";
import { appConfirm } from "../../lib/appConfirm";
import { useI18n } from "../../i18n";
import { IconFolder } from "../../components/ui/Icons";
import {
  useProtocolHttpLayoutStore,
  type ProtocolDropTarget,
  type ProtocolTreeNodeKey,
} from "../../stores/protocolHttpLayoutStore";
import {
  filterHistoryForRequest,
  listProtocolTreeChildren,
  methodColor,
  type ProtocolTreeEntry,
} from "./protocolLayoutTree";
import { useProtocolHttpOptional } from "./ProtocolHttpContext";

const SECTION_STORAGE_KEY = "omnipanel-protocol-http-sidebar-sections.v2";

type ContextTarget =
  | { kind: "root" }
  | { kind: "folder"; folderId: string }
  | { kind: "request"; requestId: string };

function parseDragKey(data: string): ProtocolTreeNodeKey | null {
  if (data.startsWith("folder:") || data.startsWith("collection:") || data.startsWith("request:")) {
    return data as ProtocolTreeNodeKey;
  }
  return null;
}

function resolveFolderParent(target: ContextTarget): string | null {
  if (target.kind === "folder") return target.folderId;
  return null;
}

export function ProtocolHttpSidebar() {
  const { t } = useI18n();
  const http = useProtocolHttpOptional();
  const { sections, toggleSection, setSectionExpanded } = usePersistedVerticalSplitSections(
    SECTION_STORAGE_KEY,
    { apis: true, history: true },
  );

  const folders = useProtocolHttpLayoutStore((s) => s.folders);
  const collectionParents = useProtocolHttpLayoutStore((s) => s.collectionParents);
  const requestParents = useProtocolHttpLayoutStore((s) => s.requestParents);
  const siblingOrder = useProtocolHttpLayoutStore((s) => s.siblingOrder);
  const addFolder = useProtocolHttpLayoutStore((s) => s.addFolder);
  const renameFolder = useProtocolHttpLayoutStore((s) => s.renameFolder);
  const deleteFolder = useProtocolHttpLayoutStore((s) => s.deleteFolder);
  const moveNode = useProtocolHttpLayoutStore((s) => s.moveNode);
  const toggleFolderExpanded = useProtocolHttpLayoutStore((s) => s.toggleFolderExpanded);
  const isFolderExpanded = useProtocolHttpLayoutStore((s) => s.isFolderExpanded);

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; target: ContextTarget } | null>(
    null,
  );
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [draggingKey, setDraggingKey] = useState<ProtocolTreeNodeKey | null>(null);

  const collections = http?.collections ?? [];
  const savedRequests = http?.savedRequests ?? [];
  const history = http?.history ?? [];
  const selectedRequestId = http?.selectedRequestId ?? null;

  const selectedRequest = useMemo(
    () => savedRequests.find((req) => req.id === selectedRequestId) ?? null,
    [savedRequests, selectedRequestId],
  );

  const requestHistory = useMemo(
    () => filterHistoryForRequest(history, selectedRequest),
    [history, selectedRequest],
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
        siblingOrder,
      ),
    [folders, collections, savedRequests, collectionParents, requestParents, siblingOrder],
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
    async (parentFolderId: string | null) => {
      if (!http) return;
      const name = await quickInput({
        title: t("protocol.sidebar.newRequestTitle"),
        placeholder: t("protocol.http.requestName"),
        defaultValue: t("protocol.sidebar.defaultRequestName"),
        validate: (value) => (value.trim() ? null : t("protocol.sidebar.folderNameRequired")),
      });
      if (!name) return;
      await http.createRequest(name.trim(), parentFolderId);
      setSectionExpanded("history", true);
    },
    [http, setSectionExpanded, t],
  );

  const handleSelectRequest = useCallback(
    (req: (typeof savedRequests)[number]) => {
      http?.selectRequest(req);
      setSectionExpanded("history", true);
    },
    [http, setSectionExpanded],
  );

  const handleDrop = useCallback(
    async (sourceKey: ProtocolTreeNodeKey, target: ProtocolDropTarget) => {
      if (sourceKey.startsWith("request:")) {
        const requestId = sourceKey.slice("request:".length);
        if (target.kind === "collection") {
          await http?.updateRequestCollection(requestId, target.collectionId);
        } else {
          await http?.updateRequestCollection(requestId, null);
        }
      }
      moveNode(sourceKey, target);
    },
    [http, moveNode],
  );

  const onDragStart = useCallback((event: DragEvent, key: ProtocolTreeNodeKey) => {
    event.dataTransfer.setData("text/plain", key);
    event.dataTransfer.effectAllowed = "move";
    setDraggingKey(key);
  }, []);

  const onDragEnd = useCallback(() => {
    setDraggingKey(null);
    setDragOverTarget(null);
  }, []);

  const onDragOverTarget = useCallback((event: DragEvent, targetId: string) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverTarget(targetId);
  }, []);

  const onDropOnTarget = useCallback(
    (event: DragEvent, target: ProtocolDropTarget) => {
      event.preventDefault();
      event.stopPropagation();
      const sourceKey = parseDragKey(event.dataTransfer.getData("text/plain"));
      setDragOverTarget(null);
      setDraggingKey(null);
      if (!sourceKey) return;
      void handleDrop(sourceKey, target);
    },
    [handleDrop],
  );

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
          onClick: () => void handleCreateRequest(parentFolderId),
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
        id: "delete-request",
        label: t("protocol.sidebar.deleteRequest"),
        danger: true,
        onClick: () => void http.deleteSavedRequest(target.requestId),
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
  ]);

  const renderTree = useCallback(
    (entries: ProtocolTreeEntry[], depth: number) => {
      return entries.map((entry) => {
        const indent = depth * 14 + 8;
        const nodeStyle: CSSProperties = { paddingLeft: indent };

        if (entry.kind === "folder") {
          const folderId = entry.folder.id;
          const expanded = isFolderExpanded(folderId);
          const dropId = `folder:${folderId}`;
          const childEntries = listProtocolTreeChildren(
            folderId,
            folders,
            collections,
            savedRequests,
            collectionParents,
            requestParents,
            siblingOrder,
          );
          return (
            <div key={entry.key}>
              <div
                className={`proto-tree-node proto-tree-node--folder${dragOverTarget === dropId ? " proto-tree-node--drag-over" : ""}${draggingKey === entry.key ? " proto-tree-node--dragging" : ""}`}
                style={nodeStyle}
                draggable
                onDragStart={(e) => onDragStart(e, entry.key)}
                onDragEnd={onDragEnd}
                onDragOver={(e) => onDragOverTarget(e, dropId)}
                onDrop={(e) => onDropOnTarget(e, { kind: "folder", folderId })}
                onContextMenu={(e) => openContextMenu(e, { kind: "folder", folderId })}
              >
                <span
                  className={`tree-arrow${expanded ? " tree-arrow--open" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFolderExpanded(folderId);
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </span>
                <IconFolder size={14} className="proto-tree-node__icon" />
                <span
                  className="proto-tree-node__label"
                  onClick={() => toggleFolderExpanded(folderId)}
                >
                  {entry.folder.name}
                </span>
              </div>
              {expanded ? renderTree(childEntries, depth + 1) : null}
            </div>
          );
        }

        if (entry.kind === "collection") {
          return null;
        }

        const req = entry.request;
        const selected = selectedRequestId === req.id;
        return (
          <div
            key={entry.key}
            className={`proto-tree-node proto-tree-node--request${selected ? " proto-tree-node--selected" : ""}${draggingKey === entry.key ? " proto-tree-node--dragging" : ""}`}
            style={nodeStyle}
            draggable
            onDragStart={(e) => onDragStart(e, entry.key)}
            onDragEnd={onDragEnd}
            onClick={() => handleSelectRequest(req)}
            onContextMenu={(e) => openContextMenu(e, { kind: "request", requestId: req.id })}
          >
            <span className="tree-arrow tree-leaf">
              <span className="tree-dot" />
            </span>
            <span className="h-method" style={{ color: methodColor(req.method) }}>
              {req.method === "DELETE" ? "DEL" : req.method}
            </span>
            <span className="proto-tree-node__label">{req.name}</span>
          </div>
        );
      });
    },
    [
      folders,
      collections,
      savedRequests,
      collectionParents,
      requestParents,
      siblingOrder,
      dragOverTarget,
      draggingKey,
      selectedRequestId,
      isFolderExpanded,
      onDragStart,
      onDragEnd,
      onDragOverTarget,
      onDropOnTarget,
      openContextMenu,
      toggleFolderExpanded,
      handleSelectRequest,
    ],
  );

  return (
    <aside
      className="proto-sidebar proto-sidebar--tree"
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest(".proto-tree-node, .history-item, .vsplit-sidebar-section__header")) {
          return;
        }
        openContextMenu(e, { kind: "root" });
      }}
    >
      <VerticalSplitSidebar className="proto-sidebar-sections">
        <VerticalSplitSidebarSection
          title={t("protocol.sidebar.apiList")}
          expanded={sections.apis}
          onToggle={() => toggleSection("apis")}
        >
          <div
            className={`proto-tree-root${dragOverTarget === "root" ? " proto-tree-node--drag-over" : ""}`}
            onContextMenu={(e) => openContextMenu(e, { kind: "root" })}
            onDragOver={(e) => onDragOverTarget(e, "root")}
            onDrop={(e) => onDropOnTarget(e, { kind: "root" })}
          >
            {rootChildren.length === 0 ? (
              <div className="proto-empty">{t("protocol.sidebar.apiListEmpty")}</div>
            ) : (
              renderTree(rootChildren, 0)
            )}
          </div>
        </VerticalSplitSidebarSection>

        <VerticalSplitSidebarSection
          title={t("protocol.sidebar.history")}
          expanded={sections.history}
          onToggle={() => toggleSection("history")}
        >
          {!selectedRequest ? (
            <div className="proto-empty">{t("protocol.sidebar.selectRequestForHistory")}</div>
          ) : requestHistory.length === 0 ? (
            <div className="proto-empty">{t("protocol.sidebar.noRequestHistory")}</div>
          ) : (
            <div className="proto-sidebar-history">
              {requestHistory.map((entry) => (
                <div
                  key={entry.id}
                  className="history-item"
                  onClick={() => http?.applyHistoryEntry(entry)}
                >
                  <div className="history-item-main">
                    <span className="h-method" style={{ color: methodColor(entry.method) }}>
                      {entry.method}
                    </span>
                    <span className="h-url">{entry.url}</span>
                  </div>
                  <div className="history-item-meta">
                    {entry.statusCode != null && (
                      <span
                        className={`h-status ${entry.statusCode < 400 ? "h-status-ok" : "h-status-err"}`}
                      >
                        {entry.statusCode}
                      </span>
                    )}
                    {entry.responseTimeMs != null && (
                      <span className="h-time">{entry.responseTimeMs}ms</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
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
