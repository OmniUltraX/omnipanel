import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { useI18n } from "../../../i18n";
import type { DbConnectionConfig } from "../api";
import { connectionHasTableSchemaChildren } from "../api";
import type { CachedTable } from "./schemaCacheMerge";
import {
  buildColumnTreeItem,
  buildFolderTreeItem,
  buildIndexTreeItem,
  buildTableTreeItem,
  type SchemaTreeItem,
} from "./schemaTreeItem";
import { makeTableNodeId, makeViewNodeId } from "./schemaTreeIds";

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
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshDisabled?: boolean;
  onDelete?: () => void;
  deleteDisabled?: boolean;
}) => ReactElement;

function tableColumnsFolderId(tableId: string) {
  return `${tableId}:cols`;
}

function tableIndexesFolderId(tableId: string) {
  return `${tableId}:idxs`;
}

export function SchemaTreeObjectDetails({
  TreeNode,
  conn,
  dbName,
  tbl,
  objectKind,
  depth,
  expandedNodeIds,
  activeTableKey,
  onToggle,
  onSelectTable,
  onContextSchemaNode,
  resolveNodeMeta,
  resolveNodeActions,
  tablePinned,
  onToggleTablePin,
}: {
  TreeNode: TreeNodeComponent;
  conn: { config: DbConnectionConfig };
  dbName: string;
  tbl: CachedTable;
  objectKind: "table" | "view";
  depth: number;
  expandedNodeIds: Set<string>;
  activeTableKey: string | null;
  onToggle: (id: string) => void;
  onSelectTable?: (selection: {
    connId: string;
    dbName: string;
    tableName: string;
    connection: DbConnectionConfig;
  }) => void;
  onContextSchemaNode?: (item: SchemaTreeItem, event: ReactMouseEvent) => void;
  resolveNodeMeta?: (nodeId: string, meta?: string) => string | undefined;
  resolveNodeActions?: (
    item: SchemaTreeItem,
  ) => Pick<
    Parameters<TreeNodeComponent>[0],
    "onRefresh" | "refreshing" | "refreshDisabled" | "onDelete" | "deleteDisabled"
  >;
  tablePinned?: boolean;
  onToggleTablePin?: () => void;
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
  const actionsFor = (item: SchemaTreeItem) => resolveNodeActions?.(item) ?? {};
  const colsFolderItem = buildFolderTreeItem(
    colsFolderId,
    t("database.sidebar.fields"),
    conn.config.id,
    dbName,
    tbl.name,
  );
  const idxFolderItem = buildFolderTreeItem(
    idxFolderId,
    t("database.sidebar.indexes"),
    conn.config.id,
    dbName,
    tbl.name,
  );

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
            item={colsFolderItem}
            depth={depth + 1}
            expanded={colsExpanded}
            onToggle={() => onToggle(colsFolderId)}
            meta={metaFor(colsFolderId, String(columns.length))}
            hasChildren={columns.length > 0}
            onContextMenu={openContextMenu ? (e) => openContextMenu(colsFolderItem, e) : undefined}
            {...actionsFor(colsFolderItem)}
          />
          {colsExpanded &&
            columns.map((col) => {
              const colItem = buildColumnTreeItem(
                conn.config.id,
                dbName,
                tbl.name,
                col.name,
                col.type,
                `${tableKey}:col:${col.name}`,
              );
              return (
              <TreeNode
                key={`${tableKey}:col:${col.name}`}
                item={colItem}
                depth={depth + 2}
                expanded={false}
                onToggle={() => {}}
                hasChildren={false}
                meta={metaFor(`${tableKey}:col:${col.name}`, col.type)}
                isPk={col.isPk}
                isFk={col.isFk}
                onContextMenu={openContextMenu ? (e) => openContextMenu(colItem, e) : undefined}
                {...actionsFor(colItem)}
              />
              );
            })}
          {objectKind === "table" && (
            <>
              <TreeNode
                item={idxFolderItem}
                depth={depth + 1}
                expanded={idxExpanded}
                onToggle={() => onToggle(idxFolderId)}
                meta={metaFor(idxFolderId, String(indexes.length))}
                hasChildren={indexes.length > 0}
                onContextMenu={openContextMenu ? (e) => openContextMenu(idxFolderItem, e) : undefined}
                {...actionsFor(idxFolderItem)}
              />
              {idxExpanded &&
                indexes.map((idx) => {
                  const idxItem = buildIndexTreeItem(
                    conn.config.id,
                    dbName,
                    tbl.name,
                    idx.name,
                    `${tableKey}:idx:${idx.name}`,
                  );
                  return (
                  <TreeNode
                    key={`${tableKey}:idx:${idx.name}`}
                    item={idxItem}
                    depth={depth + 2}
                    expanded={false}
                    onToggle={() => {}}
                    hasChildren={false}
                    meta={metaFor(`${tableKey}:idx:${idx.name}`, idx.columns.join(", "))}
                    onContextMenu={openContextMenu ? (e) => openContextMenu(idxItem, e) : undefined}
                    {...actionsFor(idxItem)}
                  />
                  );
                })}
            </>
          )}
        </>
      )}
    </div>
  );
}
