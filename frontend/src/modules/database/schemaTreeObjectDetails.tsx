import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { useI18n } from "../../i18n";
import type { DbConnectionConfig } from "./api";
import { connectionHasTableSchemaChildren } from "./api";
import { makeTableFilterKey } from "./DatabaseFilterDialog";
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
  onLabelDoubleClick?: () => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
  reorderScope?: string;
  reorderName?: string;
  labelComment?: string;
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
  activeTableKey,
  onToggle,
  onLoadMore,
  onSelectTable,
  onContextTable,
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
  activeTableKey: string | null;
  onToggle: (id: string) => void;
  onLoadMore: (parentNodeId: string) => void;
  onSelectTable?: (selection: {
    connId: string;
    dbName: string;
    tableName: string;
    connection: DbConnectionConfig;
  }) => void;
  onContextTable?: (
    selection: { connId: string; dbName: string; tableName: string; connection: DbConnectionConfig },
    event: ReactMouseEvent,
  ) => void;
}) {
  const { t } = useI18n();
  const tableKey =
    objectKind === "view"
      ? makeViewNodeId(conn.config.id, dbName, tbl.name)
      : makeTableNodeId(conn.config.id, dbName, tbl.name);
  const tableExpanded = expandedNodeIds.has(tableKey);
  const showTableSchemaChildren = connectionHasTableSchemaChildren(conn.config);
  const colsFolderId = tableColumnsFolderId(tableKey);
  const idxFolderId = tableIndexesFolderId(tableKey);
  const colsExpanded = expandedNodeIds.has(colsFolderId);
  const idxExpanded = expandedNodeIds.has(idxFolderId);
  const columns = tbl.columns ?? [];
  const indexes = tbl.indexes ?? [];
  const pagedColumns = paginateSchemaChildren(columns, colsFolderId, childVisibleLimits);
  const pagedIndexes = paginateSchemaChildren(indexes, idxFolderId, childVisibleLimits);
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

  return (
    <div key={tbl.name}>
      <TreeNode
        item={tableItem}
        depth={depth}
        expanded={tableExpanded}
        onToggle={() => onToggle(tableKey)}
        reorderScope={objectKind === "table" ? makeTableFilterKey(conn.config.id, dbName) : undefined}
        reorderName={objectKind === "table" ? tbl.name : undefined}
        hasChildren={showTableSchemaChildren}
        active={activeTableKey === tableKey}
        labelComment={tbl.comment?.trim() || undefined}
        onLabelDoubleClick={
          objectKind === "table" ? () => onSelectTable?.(selection) : undefined
        }
        onContextMenu={onContextTable ? (e) => onContextTable(selection, e) : undefined}
        meta={
          !showTableSchemaChildren
            ? undefined
            : tbl.detailsError
              ? t("database.sidebar.detailsFailed")
              : tbl.columns
                ? `${columns.length} ${t("database.sidebar.fields")} · ${objectKind === "table" ? `${indexes.length} ${t("database.sidebar.indexes")}` : ""}`.trim()
                : undefined
        }
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
            meta={String(columns.length)}
            hasChildren={columns.length > 0}
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
                meta={col.type}
                isPk={col.isPk}
                isFk={col.isFk}
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
                meta={String(indexes.length)}
                hasChildren={indexes.length > 0}
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
                    meta={idx.columns.join(", ")}
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
