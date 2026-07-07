import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useI18n } from "../../../i18n";
import { Button } from "../../../components/ui/primitives/Button";
import { ScopedSearch, type ScopedSearchHandle } from "../../../components/ui/search/ScopedSearch";
import { ContextMenu } from "../../../components/ui/menu/ContextMenu";
import { quickInput } from "../../../lib/quickInput";
import { textSearchMatches } from "../../../lib/textSearchMatch";
import { useDbSqlFileStore, type DbSqlFileNode } from "../../../stores/dbSqlFileStore";
import {
  useDbTreeChartFileStore,
  type DbTreeChartFileNode,
} from "../../../stores/dbTreeChartFileStore";
import type { SchemaSidebarSectionConfig } from "../schema/SchemaSidebarSection";
import { SchemaSidebarSection } from "../schema/SchemaSidebarSection";
import {
  countQueryTreeRootItems,
  getQueryTreeChildren,
  isTreeChartFileId,
} from "./queryTreeNodes";
import {
  SQL_QUERY_FILE_DND_DEBUG,
  describeSqlFileDragTarget,
  sqlFileDndLog,
} from "./sqlQueryFileDnDDebug";
import {
  SQL_QUERY_FILE_POINTER_DRAG_THRESHOLD_PX,
  isSqlQueryFilePointerDragExcluded,
  resolveSqlQueryFileDropFromPointer,
  type SqlQueryFilePointerDropTarget,
} from "./sqlQueryFilePointerDnD";

interface SqlQueryFilePanelProps {
  onOpenFile: (file: DbSqlFileNode) => void;
  onNewTreeChart?: () => void;
  onOpenTreeChartFile?: (file: DbTreeChartFileNode) => void;
  activeTreeChartFileId?: string | null;
  section?: SchemaSidebarSectionConfig;
}

function dropTargetIdFromPointerHit(
  sourceId: string,
  hit: SqlQueryFilePointerDropTarget | null,
  canMove: (id: string, parentId: string | null) => boolean,
): string | null {
  if (!hit) {
    return null;
  }
  if (hit.kind === "folder") {
    return canMove(sourceId, hit.folderId) ? hit.folderId : null;
  }
  return canMove(sourceId, null) ? "__root__" : null;
}

function FolderTree({
  sqlNodes,
  treeChartNodes,
  parentId,
  depth,
  search,
  expandedIds,
  onToggleFolder,
  onOpenFile,
  onOpenTreeChartFile,
  onContextMenuSql,
  onContextMenuTreeChart,
  activeFileId,
  activeTreeChartFileId,
  draggingId,
  dropTargetId,
  canDropOnFolder,
  onNodePointerDown,
}: {
  sqlNodes: DbSqlFileNode[];
  treeChartNodes: DbTreeChartFileNode[];
  parentId: string | null;
  depth: number;
  search: string;
  expandedIds: Set<string>;
  onToggleFolder: (id: string) => void;
  onOpenFile: (file: DbSqlFileNode) => void;
  onOpenTreeChartFile: (file: DbTreeChartFileNode) => void;
  onContextMenuSql: (node: DbSqlFileNode, event: ReactMouseEvent) => void;
  onContextMenuTreeChart: (node: DbTreeChartFileNode, event: ReactMouseEvent) => void;
  activeFileId?: string | null;
  activeTreeChartFileId?: string | null;
  draggingId: string | null;
  dropTargetId: string | null;
  canDropOnFolder: (folderId: string) => boolean;
  onNodePointerDown: (nodeId: string, event: ReactPointerEvent) => void;
}) {
  const items = useMemo(
    () => getQueryTreeChildren(sqlNodes, treeChartNodes, parentId),
    [sqlNodes, treeChartNodes, parentId],
  );
  const q = search.trim();

  const visibleItems = useMemo(() => {
    if (!q) {
      return items;
    }
    return items.filter((item) => {
      const name = item.kind === "tree-chart-file" ? item.node.name : item.node.name;
      return textSearchMatches(q, name);
    });
  }, [items, q]);

  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <>
      {visibleItems.map((item) => {
        const indent = depth * 16 + 8;
        if (item.kind === "sql-folder") {
          const node = item.node;
          const expanded = expandedIds.has(node.id);
          const isDropTarget = dropTargetId === node.id && canDropOnFolder(node.id);
          const nodeStyle: CSSProperties = {
            paddingLeft: indent,
            ["--tree-depth" as string]: depth,
          };
          return (
            <div key={node.id}>
              <div
                className={`sql-file-tree-node sql-file-tree-node--folder${expanded ? " sql-file-tree-node--sticky" : ""}${draggingId === node.id ? " sql-file-tree-node--dragging" : ""}${isDropTarget ? " sql-file-tree-node--drop-target" : ""}`}
                style={nodeStyle}
                data-sql-file-node-id={node.id}
                data-sql-file-node-type="folder"
                onPointerDown={(event) => onNodePointerDown(node.id, event)}
                onContextMenu={(event) => onContextMenuSql(node, event)}
              >
                <span
                  className={`tree-arrow${expanded ? " tree-arrow--open" : ""}`}
                  draggable={false}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleFolder(node.id);
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </span>
                <span className="tree-icon" draggable={false}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13">
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                  </svg>
                </span>
                <span
                  className="tree-label"
                  draggable={false}
                  onClick={() => onToggleFolder(node.id)}
                >
                  {node.name}
                </span>
              </div>
              {expanded && (
                <FolderTree
                  sqlNodes={sqlNodes}
                  treeChartNodes={treeChartNodes}
                  parentId={node.id}
                  depth={depth + 1}
                  search={search}
                  expandedIds={expandedIds}
                  onToggleFolder={onToggleFolder}
                  onOpenFile={onOpenFile}
                  onOpenTreeChartFile={onOpenTreeChartFile}
                  onContextMenuSql={onContextMenuSql}
                  onContextMenuTreeChart={onContextMenuTreeChart}
                  activeFileId={activeFileId}
                  activeTreeChartFileId={activeTreeChartFileId}
                  draggingId={draggingId}
                  dropTargetId={dropTargetId}
                  canDropOnFolder={canDropOnFolder}
                  onNodePointerDown={onNodePointerDown}
                />
              )}
            </div>
          );
        }

        if (item.kind === "tree-chart-file") {
          const node = item.node;
          const isActive = activeTreeChartFileId === node.id;
          return (
            <div
              key={node.id}
              className={`sql-file-tree-node sql-file-tree-node--file sql-file-tree-node--tree-chart${isActive ? " sql-file-tree-node--active" : ""}${draggingId === node.id ? " sql-file-tree-node--dragging" : ""}`}
              style={{ paddingLeft: indent }}
              data-sql-file-node-id={node.id}
              data-sql-file-node-type="tree-chart"
              onPointerDown={(event) => onNodePointerDown(node.id, event)}
              onClick={() => onOpenTreeChartFile(node)}
              onContextMenu={(event) => onContextMenuTreeChart(node, event)}
            >
              <span className="tree-arrow tree-leaf" draggable={false}>
                <span className="tree-dot" />
              </span>
              <span className="tree-icon" draggable={false}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13" aria-hidden>
                  <rect x="3" y="3" width="7" height="18" rx="1.5" />
                  <rect x="14" y="3" width="7" height="10" rx="1.5" />
                  <rect x="14" y="16" width="7" height="5" rx="1.5" />
                </svg>
              </span>
              <span className="tree-label" draggable={false}>{node.name}</span>
            </div>
          );
        }

        const node = item.node;
        const isActive = activeFileId === node.id;

        return (
          <div
            key={node.id}
            className={`sql-file-tree-node sql-file-tree-node--file${isActive ? " sql-file-tree-node--active" : ""}${draggingId === node.id ? " sql-file-tree-node--dragging" : ""}`}
            style={{ paddingLeft: indent }}
            data-sql-file-node-id={node.id}
            data-sql-file-node-type="file"
            onPointerDown={(event) => onNodePointerDown(node.id, event)}
            onClick={() => onOpenFile(node)}
            onContextMenu={(event) => onContextMenuSql(node, event)}
          >
            <span className="tree-arrow tree-leaf" draggable={false}>
              <span className="tree-dot" />
            </span>
            <span className="tree-icon" draggable={false}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <path d="M14 2v6h6" />
                <path d="M8 13h8M8 17h5" />
              </svg>
            </span>
            <span className="tree-label" draggable={false}>{node.name}</span>
          </div>
        );
      })}
    </>
  );
}

export function SqlQueryFilePanel({
  onOpenFile,
  onNewTreeChart,
  onOpenTreeChartFile,
  activeTreeChartFileId,
  section,
}: SqlQueryFilePanelProps) {
  const { t } = useI18n();
  const nodes = useDbSqlFileStore((s) => s.nodes);
  const treeChartNodes = useDbTreeChartFileStore((s) => s.nodes);
  const addFolder = useDbSqlFileStore((s) => s.addFolder);
  const addFile = useDbSqlFileStore((s) => s.addFile);
  const renameNode = useDbSqlFileStore((s) => s.renameNode);
  const moveNode = useDbSqlFileStore((s) => s.moveNode);
  const canMoveNodeToParent = useDbSqlFileStore((s) => s.canMoveNodeToParent);
  const deleteNode = useDbSqlFileStore((s) => s.deleteNode);
  const renameTreeChartNode = useDbTreeChartFileStore((s) => s.renameNode);
  const moveTreeChartNode = useDbTreeChartFileStore((s) => s.moveNode);
  const canMoveTreeChartNodeToParent = useDbTreeChartFileStore((s) => s.canMoveNodeToParent);
  const detachTreeChartFromFolder = useDbTreeChartFileStore((s) => s.detachFromFolder);
  const deleteTreeChartNode = useDbTreeChartFileStore((s) => s.deleteNode);
  const flushTreeChartFiles = useDbTreeChartFileStore((s) => s.flushToDisk);
  const [search, setSearch] = useState("");
  const stickyAncestors = useMemo(() => !search.trim(), [search]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    node: DbSqlFileNode | DbTreeChartFileNode | null;
    kind: "sql" | "tree-chart" | "background";
  } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const skipClickAfterDropRef = useRef(false);
  const draggingIdRef = useRef<string | null>(null);
  const treeRootRef = useRef<HTMLDivElement>(null);
  const pointerDragRef = useRef<{
    sourceId: string;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const scopedSearchRef = useRef<ScopedSearchHandle>(null);

  useEffect(() => {
    if (!SQL_QUERY_FILE_DND_DEBUG) return;
    sqlFileDndLog("debug-ready", {
      nodeCount: nodes.length,
      hint: "localStorage.setItem('omnipanel-sql-query-file-dnd-debug','1') 可在生产环境强制开启",
    });
  }, [nodes.length]);

  const handleTreeKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    if (e.key.length !== 1) {
      return;
    }
    e.preventDefault();
    scopedSearchRef.current?.open(e.key);
  }, []);

  const toggleFolder = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleOpenFile = useCallback(
    (file: DbSqlFileNode) => {
      if (skipClickAfterDropRef.current) {
        skipClickAfterDropRef.current = false;
        return;
      }
      setActiveFileId(file.id);
      onOpenFile(file);
    },
    [onOpenFile],
  );

  const canMoveQueryNodeToParent = useCallback(
    (nodeId: string, parentId: string | null) => {
      if (isTreeChartFileId(nodeId)) {
        return canMoveTreeChartNodeToParent(nodeId, parentId);
      }
      return canMoveNodeToParent(nodeId, parentId);
    },
    [canMoveNodeToParent, canMoveTreeChartNodeToParent],
  );

  const moveQueryNode = useCallback(
    (nodeId: string, parentId: string | null) => {
      if (isTreeChartFileId(nodeId)) {
        const moved = moveTreeChartNode(nodeId, parentId);
        if (moved) {
          void flushTreeChartFiles();
        }
        return moved;
      }
      return moveNode(nodeId, parentId);
    },
    [flushTreeChartFiles, moveNode, moveTreeChartNode],
  );

  const canDropOnFolder = useCallback(
    (folderId: string) => {
      const sourceId = draggingIdRef.current;
      if (!sourceId) {
        return false;
      }
      return canMoveQueryNodeToParent(sourceId, folderId);
    },
    [canMoveQueryNodeToParent],
  );

  const cleanupPointerDrag = useCallback((reason: string) => {
    sqlFileDndLog("pointer-drag:end", {
      reason,
      sourceId: draggingIdRef.current,
    });
    pointerDragRef.current = null;
    draggingIdRef.current = null;
    setDraggingId(null);
    setDropTargetId(null);
    document.body.classList.remove("sql-query-file-tree--pointer-dragging");
    document.body.style.cursor = "";
  }, []);

  const applyPointerDrop = useCallback(
    (sourceId: string, hit: SqlQueryFilePointerDropTarget) => {
      if (hit.kind === "folder") {
        if (!canMoveQueryNodeToParent(sourceId, hit.folderId)) {
          sqlFileDndLog("pointer-drop:reject", {
            sourceId,
            folderId: hit.folderId,
            reason: "cannot-move-to-folder",
          });
          return;
        }
        const moved = moveQueryNode(sourceId, hit.folderId);
        sqlFileDndLog("pointer-drop:folder", { sourceId, folderId: hit.folderId, moved });
        if (moved) {
          skipClickAfterDropRef.current = true;
          setExpandedIds((prev) => new Set(prev).add(hit.folderId));
        }
        return;
      }

      if (!canMoveQueryNodeToParent(sourceId, null)) {
        sqlFileDndLog("pointer-drop:reject", {
          sourceId,
          reason: "cannot-move-to-root",
        });
        return;
      }
      const moved = moveQueryNode(sourceId, null);
      sqlFileDndLog("pointer-drop:root", { sourceId, moved });
      if (moved) {
        skipClickAfterDropRef.current = true;
      }
    },
    [canMoveQueryNodeToParent, moveQueryNode],
  );

  const onNodePointerDown = useCallback((nodeId: string, event: ReactPointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    if (isSqlQueryFilePointerDragExcluded(event.target)) {
      return;
    }
    pointerDragRef.current = {
      sourceId: nodeId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    sqlFileDndLog("pointer-down", {
      nodeId,
      target: describeSqlFileDragTarget(event.target),
    });
  }, []);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const session = pointerDragRef.current;
      if (!session || event.pointerId !== session.pointerId) {
        return;
      }

      const dx = event.clientX - session.startX;
      const dy = event.clientY - session.startY;
      if (!session.active) {
        if (Math.hypot(dx, dy) < SQL_QUERY_FILE_POINTER_DRAG_THRESHOLD_PX) {
          return;
        }
        session.active = true;
        draggingIdRef.current = session.sourceId;
        setDraggingId(session.sourceId);
        document.body.classList.add("sql-query-file-tree--pointer-dragging");
        document.body.style.cursor = "grabbing";
        sqlFileDndLog("pointer-drag:start", { sourceId: session.sourceId });
      }

      event.preventDefault();
      const hit = resolveSqlQueryFileDropFromPointer(
        event.clientX,
        event.clientY,
        treeRootRef.current,
      );
      const nextTarget = dropTargetIdFromPointerHit(
        session.sourceId,
        hit,
        canMoveQueryNodeToParent,
      );
      setDropTargetId(nextTarget);
      sqlFileDndLog(
        "pointer-drag:hover",
        { sourceId: session.sourceId, hit, nextTarget },
        nextTarget ? `hover:${nextTarget}` : "hover:none",
      );
    };

    const finishPointerDrag = (event: PointerEvent) => {
      const session = pointerDragRef.current;
      if (!session || event.pointerId !== session.pointerId) {
        return;
      }

      if (session.active) {
        const hit = resolveSqlQueryFileDropFromPointer(
          event.clientX,
          event.clientY,
          treeRootRef.current,
        );
        sqlFileDndLog("pointer-drag:finish", { sourceId: session.sourceId, hit });
        if (hit) {
          skipClickAfterDropRef.current = true;
          applyPointerDrop(session.sourceId, hit);
        }
        cleanupPointerDrag("pointer-up");
        return;
      }

      cleanupPointerDrag("pointer-up-without-drag");
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishPointerDrag);
    window.addEventListener("pointercancel", finishPointerDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishPointerDrag);
      window.removeEventListener("pointercancel", finishPointerDrag);
      cleanupPointerDrag("effect-cleanup");
    };
  }, [applyPointerDrop, canMoveQueryNodeToParent, cleanupPointerDrag]);

  const handleOpenTreeChartFile = useCallback(
    (file: DbTreeChartFileNode) => {
      if (skipClickAfterDropRef.current) {
        skipClickAfterDropRef.current = false;
        return;
      }
      onOpenTreeChartFile?.(file);
    },
    [onOpenTreeChartFile],
  );

  const handleRenameTreeChart = useCallback(
    async (node: DbTreeChartFileNode) => {
      const defaultValue = node.name.replace(/\.ctr$/i, "");
      const name = await quickInput({
        title: t("database.treeChart.renameTitle"),
        defaultValue,
        validate: (value) => (value.trim() ? null : t("database.treeChart.nameRequired")),
      });
      if (!name) {
        return;
      }
      renameTreeChartNode(node.id, name.trim());
      await flushTreeChartFiles();
    },
    [flushTreeChartFiles, renameTreeChartNode, t],
  );

  const handleCreateFolder = useCallback(async (parentId: string | null = null) => {
    const name = await quickInput({
      title: t("database.queryFiles.newFolderTitle"),
      placeholder: t("database.queryFiles.folderNamePlaceholder"),
      defaultValue: t("database.queryFiles.defaultFolderName"),
      validate: (value) => (value.trim() ? null : t("database.queryFiles.nameRequired")),
    });
    if (!name) {
      return;
    }
    const folder = addFolder(parentId, name.trim());
    setExpandedIds((prev) => new Set(prev).add(folder.id));
  }, [addFolder, t]);

  const handleCreateFile = useCallback(async (parentId: string | null = null) => {
    const name = await quickInput({
      title: t("database.queryFiles.newFileTitle"),
      placeholder: t("database.queryFiles.fileNamePlaceholder"),
      defaultValue: t("database.queryFiles.defaultFileName"),
      validate: (value) => (value.trim() ? null : t("database.queryFiles.nameRequired")),
    });
    if (!name) {
      return;
    }
    const file = addFile(parentId, name.trim());
    handleOpenFile(file);
  }, [addFile, handleOpenFile, t]);

  const handleRename = useCallback(
    async (node: DbSqlFileNode) => {
      const defaultValue = node.name.replace(/\.sql$/i, "");
      const name = await quickInput({
        title: t("database.queryFiles.renameTitle"),
        defaultValue,
        validate: (value) => (value.trim() ? null : t("database.queryFiles.nameRequired")),
      });
      if (!name) {
        return;
      }
      renameNode(node.id, name.trim());
    },
    [renameNode, t],
  );

  const openTreeBackgroundMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest(".sql-file-tree-node")) {
      return;
    }
    event.preventDefault();
    setCtxMenu({ x: event.clientX, y: event.clientY, node: null, kind: "background" });
  }, []);

  const rootCount = useMemo(
    () => countQueryTreeRootItems(nodes, treeChartNodes),
    [nodes, treeChartNodes],
  );

  const toolbar = (
    <div className="schema-toolbar schema-toolbar--inline">
      <Button variant="icon" title={t("database.queryFiles.newFile")} onClick={() => void handleCreateFile()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6M12 11v6M9 14h6" />
        </svg>
      </Button>
      {onNewTreeChart ? (
        <Button variant="icon" title={t("database.treeChart.new")} onClick={onNewTreeChart}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden>
            <rect x="3" y="3" width="7" height="18" rx="1.5" />
            <rect x="14" y="3" width="7" height="10" rx="1.5" />
            <rect x="14" y="16" width="7" height="5" rx="1.5" />
            <path d="M6.5 8h0M6.5 12h0M6.5 16h0" strokeLinecap="round" />
            <path d="M17.5 7h0M17.5 11h0" strokeLinecap="round" />
          </svg>
        </Button>
      ) : null}
    </div>
  );

  const panelBody = (
    <div className="sql-query-file-panel">
      {!section && toolbar}
      <ScopedSearch
        ref={scopedSearchRef}
        className="sql-query-file-search"
        value={search}
        onChange={setSearch}
        placeholder={t("database.queryFiles.search")}
      >
        <div
          ref={treeRootRef}
          className={`sql-query-file-tree${stickyAncestors ? " sql-query-file-tree--sticky-ancestors" : ""}${dropTargetId === "__root__" ? " sql-query-file-tree--root-drop" : ""}`}
          tabIndex={-1}
          onKeyDown={handleTreeKeyDown}
          onContextMenu={openTreeBackgroundMenu}
        >
          {rootCount === 0 ? (
            <div className="sql-query-file-empty">{t("database.queryFiles.empty")}</div>
          ) : (
            <FolderTree
              sqlNodes={nodes}
              treeChartNodes={treeChartNodes}
              parentId={null}
              depth={0}
              search={search}
              expandedIds={expandedIds}
              onToggleFolder={toggleFolder}
              onOpenFile={handleOpenFile}
              onOpenTreeChartFile={handleOpenTreeChartFile}
              onContextMenuSql={(node, event) => {
                event.preventDefault();
                setCtxMenu({ x: event.clientX, y: event.clientY, node, kind: "sql" });
              }}
              onContextMenuTreeChart={(node, event) => {
                event.preventDefault();
                setCtxMenu({ x: event.clientX, y: event.clientY, node, kind: "tree-chart" });
              }}
              activeFileId={activeFileId}
              activeTreeChartFileId={activeTreeChartFileId}
              draggingId={draggingId}
              dropTargetId={dropTargetId}
              canDropOnFolder={canDropOnFolder}
              onNodePointerDown={onNodePointerDown}
            />
          )}
        </div>
      </ScopedSearch>
      {ctxMenu && (
        <ContextMenu
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          items={
            ctxMenu.kind === "background"
              ? [
                  {
                    id: "new-folder-root",
                    label: t("database.queryFiles.newFolder"),
                    onClick: () => void handleCreateFolder(),
                  },
                ]
              : ctxMenu.kind === "tree-chart" && ctxMenu.node
                ? [
                    {
                      id: "rename-tree-chart",
                      label: t("database.treeChart.rename"),
                      onClick: () => void handleRenameTreeChart(ctxMenu.node as DbTreeChartFileNode),
                    },
                    {
                      id: "delete-tree-chart",
                      label: t("database.treeChart.delete"),
                      danger: true,
                      onClick: () => {
                        deleteTreeChartNode(ctxMenu.node!.id);
                        void flushTreeChartFiles();
                      },
                    },
                  ]
                : ctxMenu.node && (ctxMenu.node as DbSqlFileNode).type === "folder"
                  ? [
                      {
                        id: "new-file",
                        label: t("database.queryFiles.newFile"),
                        onClick: () => void handleCreateFile(ctxMenu.node!.id),
                      },
                      {
                        id: "new-folder",
                        label: t("database.queryFiles.newFolder"),
                        onClick: () => void handleCreateFolder(ctxMenu.node!.id),
                      },
                      {
                        id: "rename",
                        label: t("database.queryFiles.rename"),
                        onClick: () => void handleRename(ctxMenu.node as DbSqlFileNode),
                      },
                      {
                        id: "delete",
                        label: t("database.queryFiles.delete"),
                        danger: true,
                        onClick: () => {
                          const folderId = ctxMenu.node!.id;
                          deleteNode(folderId);
                          detachTreeChartFromFolder(folderId);
                        },
                      },
                    ]
                  : ctxMenu.node
                    ? [
                        {
                          id: "rename",
                          label: t("database.queryFiles.rename"),
                          onClick: () => void handleRename(ctxMenu.node as DbSqlFileNode),
                        },
                        {
                          id: "delete",
                          label: t("database.queryFiles.delete"),
                          danger: true,
                          onClick: () => deleteNode(ctxMenu.node!.id),
                        },
                      ]
                    : []
          }
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );

  if (section) {
    return (
      <SchemaSidebarSection {...section} actions={toolbar}>
        {panelBody}
      </SchemaSidebarSection>
    );
  }

  return panelBody;
}
