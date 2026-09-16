import type { ContextMenuItem } from "../../../components/ui/ContextMenu";
import { contextMenuIcons } from "../../../components/ui/menu/contextMenuIcons";
import { GLOBAL_SHARE_MENU_ID } from "../../../components/ui/menu/withGlobalShareMenuItem";
import type { DbConnectionConfig } from "../api";
import { isConnectionEnabled } from "../api";
import type { SchemaTreeItem } from "./schemaTreeItem";
import type { SchemaTableSelection } from "./schemaBrowserTypes";
import { resolveLayoutFolderIdFromItem } from "./schemaBrowserHelpers";
import {
  isSchemaNodeDeletable,
  schemaNodeDeleteLabelKey,
} from "./schemaTreeNodeActions";
import { isSchemaNodeDropSupported } from "./schemaTreeDropSql";
import { resolveSidebarTreeDeleteTargets } from "@/components/ui/sidebar-tree";
import { buildDatabaseConnectionSharePayload } from "../../share/resourceShare";
import type { CachedConnection } from "./schemaCacheMerge";

export type SchemaCtxMenuState = {
  x: number;
  y: number;
  item: SchemaTreeItem | null;
  connection?: DbConnectionConfig;
  tableSelection?: SchemaTableSelection;
  layoutRoot?: boolean;
} | null;

export type BuildSchemaTreeContextMenuDeps = {
  t: (key: string, params?: Record<string, string | number>) => string;
  schemaCtxMenu: SchemaCtxMenuState;
  connectionsRef: { current: CachedConnection[] };
  selectedIdsRef: { current: ReadonlySet<string> };
  refreshingNodeIds: Record<string, boolean>;
  deletingNodeIds: Record<string, true>;
  buildSchemaContextMenuItems?: (
    item: SchemaTreeItem,
    context: {
      connection?: DbConnectionConfig;
      tableSelection?: SchemaTableSelection;
      selectedConnections?: DbConnectionConfig[];
    },
  ) => ContextMenuItem[];
  handleCreateLayoutFolder: (parentId: string | null) => void | Promise<void>;
  handleRenameLayoutFolder: (folderId: string, currentName: string) => void | Promise<void>;
  handleDeleteLayoutFolder: (folderId: string) => void | Promise<boolean | void>;
  handleRefreshSchemaNode: (connection: DbConnectionConfig, item: SchemaTreeItem) => void;
  handleDeleteSchemaNode: (
    connection: DbConnectionConfig,
    item: SchemaTreeItem,
  ) => void | Promise<boolean>;
  openShareDialog: (payload: ReturnType<typeof buildDatabaseConnectionSharePayload>) => void;
};

/** Schema 树右键菜单（纯函数，由 SchemaBrowser 注入 deps）。 */
export function buildSchemaTreeContextMenuItems(
  deps: BuildSchemaTreeContextMenuDeps,
): ContextMenuItem[] {
  const {
    t,
    schemaCtxMenu,
    connectionsRef,
    selectedIdsRef,
    refreshingNodeIds,
    deletingNodeIds,
    buildSchemaContextMenuItems,
    handleCreateLayoutFolder,
    handleRenameLayoutFolder,
    handleDeleteLayoutFolder,
    handleRefreshSchemaNode,
    handleDeleteSchemaNode,
    openShareDialog,
  } = deps;

  if (!schemaCtxMenu) {
    return [];
  }
  const { item, connection, layoutRoot } = schemaCtxMenu;

  if (layoutRoot) {
    return [
      {
        id: "layout-new-folder",
        label: t("database.sidebar.newFolder"),
        icon: contextMenuIcons.folder,
        onClick: () => void handleCreateLayoutFolder(null),
      },
    ];
  }

  if (item?.type === "connection-folder") {
    const folderId = resolveLayoutFolderIdFromItem(item);
    if (!folderId) {
      return [];
    }
    return [
      {
        id: "layout-new-folder",
        label: t("database.sidebar.newFolder"),
        icon: contextMenuIcons.folder,
        onClick: () => void handleCreateLayoutFolder(folderId),
      },
      {
        id: "layout-rename-folder",
        label: t("database.sidebar.renameFolder"),
        icon: contextMenuIcons.rename,
        onClick: () => void handleRenameLayoutFolder(folderId, item.label),
      },
      {
        id: "layout-delete-folder",
        label: t("database.sidebar.deleteFolder"),
        icon: contextMenuIcons.delete,
        danger: true,
        onClick: () => void handleDeleteLayoutFolder(folderId),
      },
    ];
  }

  if (!item) {
    return [];
  }

  const selectedConnectionIds = resolveSidebarTreeDeleteTargets(
    item.id,
    selectedIdsRef.current,
    {
      filter: (id) =>
        connectionsRef.current.some(
          (entry) => entry.config.id === id || `conn:${entry.config.id}` === id,
        ),
    },
  );
  const selectedConnections = selectedConnectionIds
    .map((id) => {
      const connId = id.startsWith("conn:") ? id.slice("conn:".length) : id;
      return connectionsRef.current.find((entry) => entry.config.id === connId)?.config;
    })
    .filter((entry): entry is DbConnectionConfig => Boolean(entry));

  const extra =
    buildSchemaContextMenuItems?.(item, {
      connection,
      tableSelection: schemaCtxMenu.tableSelection,
      selectedConnections:
        item.type === "connection" && selectedConnections.length > 0
          ? selectedConnections
          : connection
            ? [connection]
            : undefined,
    }) ?? [];
  const connRefreshing = connection ? Boolean(refreshingNodeIds[item.id]) : false;
  const canRefresh = Boolean(connection && isConnectionEnabled(connection));
  const refreshItem: ContextMenuItem = {
    id: "refresh-schema-node",
    label: t("common.refresh"),
    icon: contextMenuIcons.refresh,
    disabled: !canRefresh || connRefreshing,
    onClick: () => {
      if (connection) {
        handleRefreshSchemaNode(connection, item);
      }
    },
  };
  const deleteItem: ContextMenuItem | null =
    connection && isSchemaNodeDeletable(item.type)
      ? {
          id: "delete-schema-node",
          label: t(schemaNodeDeleteLabelKey(item.type)),
          icon: contextMenuIcons.delete,
          danger: true,
          disabled:
            Boolean(deletingNodeIds[item.id]) ||
            !isSchemaNodeDropSupported(connection.db_type, item.type),
          onClick: () => {
            void handleDeleteSchemaNode(connection, item);
          },
        }
      : null;
  const trailingItems: ContextMenuItem[] = deleteItem
    ? [deleteItem, { id: "sep-delete", label: "", separator: true }, refreshItem]
    : [refreshItem];
  const shareItems: ContextMenuItem[] =
    item.type === "connection" && connection
      ? [
          { id: "sep-share-db", label: "", separator: true },
          {
            id: GLOBAL_SHARE_MENU_ID,
            label: t("share.menu"),
            icon: contextMenuIcons.share,
            onClick: () =>
              openShareDialog(buildDatabaseConnectionSharePayload(connection)),
          },
        ]
      : [];
  if (extra.length === 0) {
    return [...trailingItems, ...shareItems];
  }
  return [
    ...extra,
    { id: "sep-refresh", label: "", separator: true },
    ...trailingItems,
    ...shareItems,
  ];
}
