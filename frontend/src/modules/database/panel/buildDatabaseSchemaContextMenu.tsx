import type { ContextMenuItem } from "../../../components/ui/menu";
import { contextMenuIcons } from "../../../components/ui/menu/contextMenuIcons";
import type { SchemaContextMenuContext, SchemaTableSelection } from "../schema/SchemaBrowser";
import type { SchemaTreeItem } from "../schema/schemaTreeItem";
import {
  isConnectionEnabled,
  isMysqlConnectionInfoCapable,
  type DbConnectionConfig,
} from "../api";
import { hostCapabilities } from "../hostCapabilities";
import { supportsTableDesign } from "../tableDesigner/resolveTableDesignerDriver";
import type { SlowLogAvailability } from "../mysqlSlowQueryLog";
import type { BinlogAvailability } from "../mysqlBinlog";
import { showToast } from "../../../stores/toastStore";

export type BuildDatabaseSchemaContextMenuDeps = {
  t: (key: string, vars?: Record<string, string | number>) => string;
  handleExportDatabase: (connection: DbConnectionConfig, dbName: string) => void | Promise<void>;
  handleOpenImportDatabase: (connection: DbConnectionConfig, dbName: string) => void;
  handleDesignTable: (selection: SchemaTableSelection) => void;
  copyNameForTable: (selection: SchemaTableSelection) => void;
  copyDdlForTable: (selection: SchemaTableSelection) => void | Promise<void>;
  ensureSlowLogAvailability: (connection: DbConnectionConfig) => Promise<SlowLogAvailability>;
  ensureBinlogAvailability: (connection: DbConnectionConfig) => Promise<BinlogAvailability>;
  resolveSlowLogDisabledReason: (availability: SlowLogAvailability) => string;
  resolveBinlogDisabledReason: (availability: BinlogAvailability) => string;
  openSlowQueryLogTab: (connection: DbConnectionConfig, availability: SlowLogAvailability) => void;
  openDialectSlowQueryTab: (connection: DbConnectionConfig) => void;
  openBinlogTab: (connection: DbConnectionConfig, availability: BinlogAvailability) => void;
  toggleConnectionEnabled: (connId: string, enabled: boolean) => void | Promise<void>;
  setEditingConnection: (connection: DbConnectionConfig | null) => void;
  setDialogOpen: (open: boolean) => void;
  setCreateDbDialog: (value: { connId: string } | null) => void;
  openProfile: (args: {
    resourceType: "database";
    resourceId: string;
    displayName: string;
  }) => void;
  handleDeleteConnection: (
    target: DbConnectionConfig | DbConnectionConfig[],
  ) => void | Promise<void> | Promise<boolean>;
};

const openIcon = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <path d="M3 6l5-4 5 4" />
    <path d="M8 2v12" />
  </svg>
);
const closeIcon = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <path d="M3 10l5 4 5-4" />
    <path d="M8 14V2" />
  </svg>
);
const slowLogIcon = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <path d="M3 2.5h10v11H3z" />
    <path d="M5 6h6M5 8.5h4M5 11h5" />
    <path d="M11 2.5V1.5H5v1" />
  </svg>
);
const LOG_OPEN_TIMEOUT_MS = 20_000;

function openMysqlLog(t: BuildDatabaseSchemaContextMenuDeps["t"], task: () => Promise<void>) {
  void (async () => {
    let finished = false;
    const timer = window.setTimeout(() => {
      if (finished) return;
      showToast(t("database.contextMenu.logOpenTimeout"));
    }, LOG_OPEN_TIMEOUT_MS);
    try {
      await task();
      finished = true;
    } catch (error) {
      finished = true;
      const message = error instanceof Error ? error.message : String(error);
      showToast(t("database.contextMenu.logOpenFailed", { error: message }));
    } finally {
      window.clearTimeout(timer);
    }
  })();
}

const binlogIcon = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <path d="M4 2h8v12H4z" />
    <path d="M6 5h4M6 8h4M6 11h2" />
    <path d="M2 5h2M2 8h2M2 11h2" />
  </svg>
);

/** Schema 树右键菜单（纯函数，由 DatabasePanel model 注入 deps）。 */
export function buildDatabaseSchemaContextMenuItems(
  deps: BuildDatabaseSchemaContextMenuDeps,
  item: SchemaTreeItem,
  context: SchemaContextMenuContext,
): ContextMenuItem[] {
  const {
    t,
    handleExportDatabase,
    handleOpenImportDatabase,
    handleDesignTable,
    copyNameForTable,
    copyDdlForTable,
    ensureSlowLogAvailability,
    ensureBinlogAvailability,
    resolveSlowLogDisabledReason,
    resolveBinlogDisabledReason,
    openSlowQueryLogTab,
    openDialectSlowQueryTab,
    openBinlogTab,
    toggleConnectionEnabled,
    setEditingConnection,
    setDialogOpen,
    setCreateDbDialog,
    openProfile,
    handleDeleteConnection,
  } = deps;

  if (item.type === "database" && item.dbName && context.connection) {
    const connection = context.connection;
    if (!isMysqlConnectionInfoCapable(connection)) {
      return [];
    }
    const enabled = isConnectionEnabled(connection);
    return [
      {
        id: "export-database",
        label: t("database.contextMenu.exportDatabase"),
        icon: contextMenuIcons.export,
        disabled: !enabled,
        onClick: () => {
          void handleExportDatabase(connection, item.dbName!);
        },
      },
      {
        id: "import-database",
        label: t("database.contextMenu.importDatabase"),
        icon: contextMenuIcons.import,
        disabled: !enabled,
        onClick: () => {
          handleOpenImportDatabase(connection, item.dbName!);
        },
      },
    ];
  }

  if (item.type === "table" && context.tableSelection) {
    const selection = context.tableSelection;
    const canDesign = supportsTableDesign(selection.connection);
    const items: ContextMenuItem[] = [];
    if (canDesign) {
      items.push({
        id: "design-table",
        label: t("database.contextMenu.designTable"),
        icon: contextMenuIcons.design,
        onClick: () => handleDesignTable(selection),
      });
    }
    items.push({
      id: "copy",
      label: t("database.contextMenu.copy"),
      icon: contextMenuIcons.copy,
      children: [
        {
          id: "copy-name",
          label: t("database.contextMenu.copyName"),
          onClick: () => copyNameForTable(selection),
        },
        {
          id: "copy-ddl",
          label: t("database.contextMenu.copyDdl"),
          onClick: () => copyDdlForTable(selection),
        },
        {
          id: "copy-data",
          label: t("database.contextMenu.copyData"),
          disabled: true,
        },
      ],
    });
    return items;
  }

  if (item.type === "connection" && context.connection) {
    const connection = context.connection;
    const connEnabled = isConnectionEnabled(connection);
    const slowLogItems: ContextMenuItem[] = [];
    if (isMysqlConnectionInfoCapable(connection)) {
      slowLogItems.push({
        id: "slow-query-log",
        label: t("database.contextMenu.slowQueryLog"),
        icon: slowLogIcon,
        disabled: !connEnabled,
        disabledReason: !connEnabled
          ? t("database.contextMenu.slowQueryLogDisabled.connectionDisabled")
          : undefined,
        onClick: () => {
          openMysqlLog(t, async () => {
            const latest = await ensureSlowLogAvailability(connection);
            if (!latest.enabled) {
              showToast(resolveSlowLogDisabledReason(latest));
              return;
            }
            openSlowQueryLogTab(connection, latest);
          });
        },
      });
      slowLogItems.push({
        id: "binlog",
        label: t("database.contextMenu.binlog"),
        icon: binlogIcon,
        disabled: !connEnabled,
        disabledReason: !connEnabled
          ? t("database.contextMenu.binlogDisabled.connectionDisabled")
          : undefined,
        onClick: () => {
          openMysqlLog(t, async () => {
            const latest = await ensureBinlogAvailability(connection);
            if (!latest.enabled) {
              showToast(resolveBinlogDisabledReason(latest));
              return;
            }
            openBinlogTab(connection, latest);
          });
        },
      });
    } else if (hostCapabilities(connection.db_type).slowQuery) {
      slowLogItems.push({
        id: "slow-query-dialect",
        label: t("database.workspace.tabAction.slowQuery"),
        icon: slowLogIcon,
        disabled: !connEnabled,
        disabledReason: !connEnabled
          ? t("database.contextMenu.slowQueryLogDisabled.connectionDisabled")
          : undefined,
        onClick: () => openDialectSlowQueryTab(connection),
      });
    }
    return [
      {
        id: connEnabled ? "disable-connection" : "enable-connection",
        label: connEnabled
          ? t("database.contextMenu.closeConnection")
          : t("database.contextMenu.openConnection"),
        icon: connEnabled ? closeIcon : openIcon,
        onClick: () => {
          void toggleConnectionEnabled(connection.id, !connEnabled);
        },
      },
      ...slowLogItems,
      {
        id: "edit-connection",
        label: t("database.contextMenu.editConnection"),
        icon: contextMenuIcons.edit,
        onClick: () => {
          setEditingConnection(connection);
          setDialogOpen(true);
        },
      },
      ...(hostCapabilities(connection.db_type).createDatabase
        ? [
            {
              id: "create-database",
              label: t("database.contextMenu.createDatabase"),
              icon: contextMenuIcons.plus,
              disabled: !connEnabled,
              onClick: () => setCreateDbDialog({ connId: connection.id }),
            } satisfies ContextMenuItem,
          ]
        : []),
      {
        id: "view-profile",
        label: t("resource.profile.viewProfile"),
        icon: contextMenuIcons.profile,
        onClick: () =>
          openProfile({
            resourceType: "database",
            resourceId: connection.name,
            displayName: connection.name,
          }),
      },
      { id: "sep-delete-connection", label: "", separator: true },
      {
        id: "delete-connection",
        label: t("database.contextMenu.deleteConnection"),
        icon: contextMenuIcons.delete,
        danger: true,
        onClick: () => {
          const targets =
            context.selectedConnections && context.selectedConnections.length > 0
              ? context.selectedConnections
              : [connection];
          void handleDeleteConnection(targets.length === 1 ? targets[0]! : targets);
        },
      },
    ];
  }

  return [];
}
