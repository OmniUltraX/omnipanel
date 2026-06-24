import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { useI18n } from "../../i18n";
import type { DbConnectionConfig } from "./api";
import { connectionHasTableSchemaChildren } from "./api";
import type { CachedTable } from "./schemaCacheMerge";
import {
  buildColumnTreeItem,
  buildFolderTreeItem,
  buildIndexTreeItem,
  buildTableTreeItem,
  type SchemaTreeItem,
} from "./schemaTreeItem";
import { makeTableNodeId, makeViewNodeId } from "./schemaTreeIds";
import { paginateSchemaChildren } from "./schemaTreePagination";

type TreeNodeComponent = (props: {
  item: SchemaTreeItem;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  meta?: string;
  isPk?: boolean;
  isFk?: boolean;
  hasChildren: boolean;
  active?: boolean;
  onLabelClick?: () => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
  labelComment?: string;
  pinActive?: boolean;
  onPinToggle?: () => void;
}) => ReactElement;

type LoadMoreComponent = (props: {
  depth: number;
  remaining: number;
  label: string;
  onClick: () => void;
}) => ReactElement;

function tableColumnsFolderId(tableId: string) {
  return `${tableId}:cols`;
}

function tableIndexesFolderId(tableId: string) {
  return `${tableId}:idxs`;
}

export function SchemaTreeObjectDetails({
  TreeNode,
  LoadMoreButton,
  conn,
  dbName,
  tbl,
  objectKind,
  depth,
  expandedNodeIds,
  childVisibleLimits,
  searchActive = false,
  activeTableKey,
  onToggle,
  onLoadMore,
  onSelectTable,
  onContextSchemaNode,
  resolveNodeMeta,
  tablePinned,
  onToggleTablePin,
}: {
  TreeNode: TreeNodeComponent;
  LoadMoreButton: LoadMoreComponent;
  conn: { config: DbConnectionConfig };
  dbName: string;
  tbl: CachedTable;
  objectKind: "table" | "view";
  depth: number;
  expandedNodeIds: Set<string>;
  childVisibleLimits: Record<string, number>;
  searchActive?: boolean;
  activeTableKey: string | null;
  onToggle: (id: string) => void;
  onLoadMore: (parentNodeId: string) => void;
  onSelectTable?: (selection: {
    connId: string;
    dbName: string;
    tableName: string;
    connection: DbConnectionConfig;
  }) => void;
  onContextSchemaNode?: (item: SchemaTreeItem, event: ReactMouseEvent) => void;
  resolveNodeMeta?: (nodeId: string, meta?: string) => string | undefined;
  tablePinned?: boolean;
  onToggleTablePin?: () => void;
}) {
  const { t } = useI18n();
  const tableKey =
    objectKind === "view"
      ? makeViewNodeId(conn.config.id, dbName, tbl.name)
      : makeTableNodeId(conn.config.id, dbName, tbl.name);
  const tableExpanded = searchActive || expandedNodeIds.has(tableKey);
  const showTableSchemaChildren = connectionHasTableSchemaChildren(conn.config);
  const colsFolderId = tableColumnsFolderId(tableKey);
  const idxFolderId = tableIndexesFolderId(tableKey);
  const colsExpanded = searchActive || expandedNodeIds.has(colsFolderId);
  const idxExpanded = searchActive || expandedNodeIds.has(idxFolderId);
  const columns = tbl.columns ?? [];
  const indexes = tbl.indexes ?? [];
  const paginateOpts = searchActive ? { unpaginated: true as const } : undefined;
  const pagedColumns = paginateSchemaChildren(columns, colsFolderId, childVisibleLimits, paginateOpts);
  const pagedIndexes = paginateSchemaChildren(indexes, idxFolderId, childVisibleLimits, paginateOpts);
  const tableItem: SchemaTreeItem =
    objectKind === "view"
      ? {
          type: "view",
          id: tableKey,
          label: tbl.name,
          connId: conn.config.id,
          dbName,
          tableName: tbl.name,
        }
      : buildTableTreeItem(conn.config.id, dbName, tbl.name);
  const selection = {
    connId: conn.config.id,
    dbName,
    tableName: tbl.name,
    connection: conn.config,
  };
  const openContextMenu = onContextSchemaNode
    ? (item: SchemaTreeItem, event: ReactMouseEvent) => onContextSchemaNode(item, event)
    : undefined;
  const metaFor = (nodeId: string, meta?: string) => resolveNodeMeta?.(nodeId, meta) ?? meta;

  return (
    <div key={tbl.name}>
      <TreeNode
        item={tableItem}
        depth={depth}
        expanded={tableExpanded}
        onToggle={() => onToggle(tableKey)}
        hasChildren={showTableSchemaChildren}
        active={activeTableKey === tableKey}
        labelComment={tbl.comment?.trim() || undefined}
        meta={metaFor(tableKey, undefined)}
        onLabelClick={
          objectKind === "table" ? () => onSelectTable?.(selection) : undefined
        }
        onContextMenu={openContextMenu ? (e) => openContextMenu(tableItem, e) : undefined}
        pinActive={objectKind === "table" ? tablePinned : undefined}
        onPinToggle={objectKind === "table" ? onToggleTablePin : undefined}
      />
      {showTableSchemaChildren && tableExpanded && tbl.detailsError && (
        <div
          style={{
            padding: "4px 56px",
            fontSize: "11px",
            color: "var(--color-danger, #ff3b30)",
          }}
        >
          {tbl.detailsError}
        </div>
      )}
      {showTableSchemaChildren && tableExpanded && tbl.columns && (
        <>
          <TreeNode
            item={buildFolderTreeItem(
              colsFolderId,
              t("database.sidebar.fields"),
              conn.config.id,
              dbName,
              tbl.name,
            )}
            depth={depth + 1}
            expanded={colsExpanded}
            onToggle={() => onToggle(colsFolderId)}
            meta={metaFor(colsFolderId, String(columns.length))}
            hasChildren={columns.length > 0}
            onContextMenu={
              openContextMenu
                ? (e) =>
                    openContextMenu(
                      buildFolderTreeItem(
                        colsFolderId,
                        t("database.sidebar.fields"),
                        conn.config.id,
                        dbName,
                        tbl.name,
                      ),
                      e,
                    )
                : undefined
            }
          />
          {colsExpanded &&
            pagedColumns.visible.map((col) => (
              <TreeNode
                key={`${tableKey}:col:${col.name}`}
                item={buildColumnTreeItem(
                  conn.config.id,
                  dbName,
                  tbl.name,
                  col.name,
                  col.type,
                  `${tableKey}:col:${col.name}`,
                )}
                depth={depth + 2}
                expanded={false}
                onToggle={() => {}}
                hasChildren={false}
                meta={metaFor(`${tableKey}:col:${col.name}`, col.type)}
                isPk={col.isPk}
                isFk={col.isFk}
                onContextMenu={
                  openContextMenu
                    ? (e) =>
                        openContextMenu(
                          buildColumnTreeItem(
                            conn.config.id,
                            dbName,
                            tbl.name,
                            col.name,
                            col.type,
                            `${tableKey}:col:${col.name}`,
                          ),
                          e,
                        )
                    : undefined
                }
              />
            ))}
          {colsExpanded && pagedColumns.hasMore && (
            <LoadMoreButton
              depth={depth + 2}
              remaining={pagedColumns.remaining}
              label={t("database.sidebar.loadMore")}
              onClick={() => onLoadMore(colsFolderId)}
            />
          )}
          {objectKind === "table" && (
            <>
              <TreeNode
                item={buildFolderTreeItem(
                  idxFolderId,
                  t("database.sidebar.indexes"),
                  conn.config.id,
                  dbName,
                  tbl.name,
                )}
                depth={depth + 1}
                expanded={idxExpanded}
                onToggle={() => onToggle(idxFolderId)}
                meta={metaFor(idxFolderId, String(indexes.length))}
                hasChildren={indexes.length > 0}
                onContextMenu={
                  openContextMenu
                    ? (e) =>
                        openContextMenu(
                          buildFolderTreeItem(
                            idxFolderId,
                            t("database.sidebar.indexes"),
                            conn.config.id,
                            dbName,
                            tbl.name,
                          ),
                          e,
                        )
                    : undefined
                }
              />
              {idxExpanded &&
                pagedIndexes.visible.map((idx) => (
                  <TreeNode
                    key={`${tableKey}:idx:${idx.name}`}
                    item={buildIndexTreeItem(
                      conn.config.id,
                      dbName,
                      tbl.name,
                      idx.name,
                      `${tableKey}:idx:${idx.name}`,
                    )}
                    depth={depth + 2}
                    expanded={false}
                    onToggle={() => {}}
                    hasChildren={false}
                    meta={metaFor(`${tableKey}:idx:${idx.name}`, idx.columns.join(", "))}
                    onContextMenu={
                      openContextMenu
                        ? (e) =>
                            openContextMenu(
                              buildIndexTreeItem(
                                conn.config.id,
                                dbName,
                                tbl.name,
                                idx.name,
                                `${tableKey}:idx:${idx.name}`,
                              ),
                              e,
                            )
                        : undefined
                    }
                  />
                ))}
              {idxExpanded && pagedIndexes.hasMore && (
                <LoadMoreButton
                  depth={depth + 2}
                  remaining={pagedIndexes.remaining}
                  label={t("database.sidebar.loadMore")}
                  onClick={() => onLoadMore(idxFolderId)}
                />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
