import type { ReactNode } from "react";
import { useDbSchemaTreeExpandedStore } from "../../../stores/dbSchemaTreeExpandedStore";
import {
  makeTableFilterKey,
  toggleTablePin,
} from "./DatabaseFilterDialog";
import type { SchemaFilterState } from "./DatabaseFilterDialog";
import type { SchemaFlatRow } from "./schemaTreeFlatRows";
import { SCHEMA_TREE_MESSAGE_ROW_HEIGHT } from "./schemaTreeFlatRows";
import type { SchemaTableSelection } from "./schemaBrowserTypes";
import type { SchemaDockOpenMode } from "../workspace/workspaceTabs";
import type { DbSqlFileNode } from "../../../stores/dbSqlFileStore";
import type { DbConnectionConfig } from "../api";
import type { CachedConnection } from "./schemaCacheMerge";
import type { SchemaTreeItem } from "./schemaTreeItem";
import { TreeNode, type TreeNodeProps } from "./SchemaTreeNode";
import { buildLayoutDragPayload } from "./schemaBrowserHelpers";
import type { SchemaLayoutDragPayload } from "./schemaLayoutPointerDnD";

export type RenderSchemaFlatRowDeps = {
  t: (key: string, params?: Record<string, string | number>) => string;
  connectionsRef: { current: CachedConnection[] };
  sqlFilesRef: { current: DbSqlFileNode[] };
  search: string;
  layoutDragOverNodeId: string | null;
  layoutDraggingSourceId: string | null;
  activeConnId: string | null;
  activeTableKey: string | null;
  activeDatabaseKey: string | null;
  openTabNodeIds?: Set<string>;
  loadMoreChildren: (parentNodeId: string) => void;
  toggle: (id: string) => void;
  updateExpanded: (updater: (prev: Set<string>) => Set<string>) => void;
  expandDatabaseOnActivate: (connId: string, dbName: string, dbNodeId: string) => void;
  expandObjectFolderOnActivate: (folderNodeId: string) => void;
  onSelectConnection?: (
    connId: string,
    mode?: SchemaDockOpenMode,
    options?: { expandTree?: boolean },
  ) => void;
  onSelectDatabase?: (
    selection: { connId: string; dbName: string; connection: DbConnectionConfig },
    mode?: SchemaDockOpenMode,
  ) => void;
  onSelectTable?: (selection: SchemaTableSelection, mode?: SchemaDockOpenMode) => void;
  onOpenSqlFile?: (file: DbSqlFileNode, mode?: "preview" | "permanent") => void;
  resolveSchemaNodeActions: (
    connection: DbConnectionConfig,
    item: SchemaTreeItem,
  ) => Pick<TreeNodeProps, "onRefresh" | "refreshing" | "refreshDisabled" | "onDelete" | "deleteDisabled">;
  handleContextSchemaNode: (item: SchemaTreeItem, e: React.MouseEvent) => void;
  setTableFilters: (
    updater: (prev: Record<string, SchemaFilterState>) => Record<string, SchemaFilterState>,
  ) => void;
  setFilterDialogConnId: (value: string | null) => void;
  setFilterDialogTable: (value: { connId: string; dbName: string } | null) => void;
  beginLayoutPointerDrag: (
    event: React.PointerEvent<HTMLElement>,
    payload: SchemaLayoutDragPayload,
    sourceNodeId: string,
  ) => void;
  updatePathForNodeId: (nodeId: string) => void;
  markTreeUserInteraction: () => void;
};

/** 扁平行渲染（闭包读 refs，勿改成读 state）。 */
export function createRenderSchemaFlatRow(deps: RenderSchemaFlatRowDeps) {
  const {
    t,
    connectionsRef,
    sqlFilesRef,
    search,
    layoutDragOverNodeId,
    layoutDraggingSourceId,
    activeConnId,
    activeTableKey,
    activeDatabaseKey,
    openTabNodeIds,
    loadMoreChildren,
    toggle,
    updateExpanded,
    expandDatabaseOnActivate,
    expandObjectFolderOnActivate,
    onSelectConnection,
    onSelectDatabase,
    onSelectTable,
    onOpenSqlFile,
    resolveSchemaNodeActions,
    handleContextSchemaNode,
    setTableFilters,
    setFilterDialogConnId,
    setFilterDialogTable,
    beginLayoutPointerDrag,
    updatePathForNodeId,
    markTreeUserInteraction,
  } = deps;

  return (row: SchemaFlatRow): ReactNode => {
    if (row.kind === "message") {
      const paddingLeft = row.depth * 16 + 24;
      return (
        <div
          className={`schema-tree-message schema-tree-message--${row.variant}`}
          style={{ paddingLeft, height: SCHEMA_TREE_MESSAGE_ROW_HEIGHT }}
          title={row.text}
        >
          <span className="schema-tree-message__text">{row.text}</span>
        </div>
      );
    }

    if (row.kind === "load-more") {
      const paddingLeft = row.depth * 16 + 24;
      return (
        <button
          type="button"
          className="schema-load-more-btn"
          style={{ paddingLeft }}
          onClick={() => loadMoreChildren(row.parentNodeId)}
        >
          {t("database.sidebar.loadMore")}
          {row.remaining > 0 ? ` (${row.remaining})` : ""}
        </button>
      );
    }

    if (row.kind !== "node") {
      return null;
    }

    const connection = row.item.connId
      ? connectionsRef.current.find((entry) => entry.config.id === row.item.connId)?.config
      : undefined;

    const onMetaClick =
      row.metaClick === "database-filter" && row.metaClickConnId
        ? () => setFilterDialogConnId(row.metaClickConnId!)
        : row.metaClick === "table-filter" && row.metaClickConnId && row.metaClickDbName
          ? () =>
              setFilterDialogTable({
                connId: row.metaClickConnId!,
                dbName: row.metaClickDbName!,
              })
          : undefined;

    // 单击 → 预览 Tab（斜体可替换）；双击 → 常驻 Tab（固定）
    let onPreviewOpen: (() => void) | undefined;
    let onActivate: (() => void) | undefined;
    if (row.labelClickKind === "connection" && row.labelClickConnId) {
      onPreviewOpen = () => onSelectConnection?.(row.labelClickConnId!, "preview");
      onActivate = () => {
        // preview 单击不展开；双击常驻才切换展开。Schema 仅无缓存时由 handleSelectConnection 加载。
        const nodeId = row.item.id;
        const wasExpanded = useDbSchemaTreeExpandedStore
          .getState()
          .expandedNodeIds.has(nodeId);
        if (wasExpanded) {
          onSelectConnection?.(row.labelClickConnId!, "permanent", { expandTree: false });
          updateExpanded((prev) => {
            if (!prev.has(nodeId)) {
              return prev;
            }
            const next = new Set(prev);
            next.delete(nodeId);
            return next;
          });
        } else {
          onSelectConnection?.(row.labelClickConnId!, "permanent");
        }
      };
    } else if (
      row.labelClickKind === "database" &&
      row.labelClickConnId &&
      row.labelClickDbName &&
      connection
    ) {
      onPreviewOpen = () => {
        onSelectDatabase?.(
          {
            connId: row.labelClickConnId!,
            dbName: row.labelClickDbName!,
            connection,
          },
          "preview",
        );
      };
      onActivate = () => {
        // 先开右侧库 Tab（同步），再双 rAF 后展开库；二层仅一个文件夹时再展开一层
        onSelectDatabase?.(
          {
            connId: row.labelClickConnId!,
            dbName: row.labelClickDbName!,
            connection,
          },
          "permanent",
        );
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            expandDatabaseOnActivate(
              row.labelClickConnId!,
              row.labelClickDbName!,
              row.item.id,
            );
          });
        });
      };
    } else if (
      row.labelClickKind === "table" &&
      row.labelClickConnId &&
      row.labelClickDbName &&
      row.labelClickTableName &&
      connection
    ) {
      const tableSelection: SchemaTableSelection = {
        connId: row.labelClickConnId!,
        dbName: row.labelClickDbName!,
        tableName: row.labelClickTableName!,
        connection,
      };
      onPreviewOpen = () => onSelectTable?.(tableSelection, "preview");
      onActivate = () => onSelectTable?.(tableSelection, "permanent");
    } else if (row.labelClickKind === "sql-query" && row.labelClickSqlFileId) {
      const openBoundSqlFile = (mode: "preview" | "permanent") => {
        const file = sqlFilesRef.current.find((entry) => entry.id === row.labelClickSqlFileId);
        if (file) {
          onOpenSqlFile?.(file, mode);
        }
      };
      onPreviewOpen = () => openBoundSqlFile("preview");
      onActivate = () => openBoundSqlFile("permanent");
    } else if (row.labelClickKind === "object-folder") {
      onActivate = () => expandObjectFolderOnActivate(row.item.id);
    }

    let onPinToggle: (() => void) | undefined;
    if (
      row.pinActive !== undefined &&
      row.labelClickConnId &&
      row.labelClickDbName &&
      row.labelClickTableName
    ) {
      onPinToggle = () => {
        const key = makeTableFilterKey(row.labelClickConnId!, row.labelClickDbName!);
        const conn = connectionsRef.current.find(
          (entry) => entry.config.id === row.labelClickConnId!,
        );
        const allTables =
          conn?.databases?.find((db) => db.name === row.labelClickDbName)?.tables ?? [];
        setTableFilters((prev) => ({
          ...prev,
          [key]: toggleTablePin(
            prev[key],
            row.labelClickTableName!,
            allTables.map((item) => item.name),
          ),
        }));
      };
    }

    const nodeActions =
      connection != null ? resolveSchemaNodeActions(connection, row.item) : {};

    const layoutDnDEnabled = !search.trim();
    const itemType = row.item.type;
    const isLayoutDraggable =
      layoutDnDEnabled && (itemType === "connection" || itemType === "connection-folder");
    const isLayoutDropTarget = layoutDnDEnabled && itemType === "connection-folder";

    const layoutPayload = buildLayoutDragPayload(row.item);

    // Compute active state without rebuilding flatRows on tab switch
    let isActive = false;
    if (row.labelClickKind === "connection" && row.labelClickConnId) {
      isActive = activeConnId === row.labelClickConnId;
    } else if (row.labelClickKind === "database") {
      isActive = activeDatabaseKey === row.item.id;
    } else if (row.labelClickKind === "table") {
      isActive = activeTableKey === row.item.id;
    }

    const isInTab = openTabNodeIds ? openTabNodeIds.has(row.item.id) : false;

    return (
      <TreeNode
        item={row.item}
        depth={row.depth}
        expanded={row.expanded}
        onToggle={() => {
          markTreeUserInteraction();
          toggle(row.item.id);
        }}
        hasChildren={row.hasChildren}
        active={isActive}
        inTab={isInTab}
        meta={row.meta}
        metaTitle={row.metaTitle}
        onMetaClick={onMetaClick}
        isPk={row.isPk}
        isFk={row.isFk}
        labelComment={row.labelComment}
        connectionEnabled={row.connectionEnabled}
        deploymentServerTag={row.deploymentServerTag}
        iconUrl={row.iconUrl}
        pinActive={row.pinActive}
        onPinToggle={onPinToggle}
        onActivate={
          onActivate
            ? () => {
                markTreeUserInteraction();
                onActivate();
              }
            : undefined
        }
        onPreviewOpen={
          onPreviewOpen
            ? () => {
                markTreeUserInteraction();
                onPreviewOpen();
              }
            : undefined
        }
        onContextMenu={(e) => handleContextSchemaNode(row.item, e)}
        onPathFocus={() => {
          markTreeUserInteraction();
          updatePathForNodeId(row.item.id);
        }}
        layoutDraggable={isLayoutDraggable}
        layoutDraggingSource={layoutDraggingSourceId === row.item.id}
        dragOver={isLayoutDropTarget && layoutDragOverNodeId === row.item.id}
        onLayoutPointerDown={
          isLayoutDraggable && layoutPayload
            ? (event) => beginLayoutPointerDrag(event, layoutPayload, row.item.id)
            : undefined
        }
        {...nodeActions}
      />
    );
  };
}
