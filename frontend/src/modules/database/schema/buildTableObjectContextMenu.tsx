import type { ContextMenuItem } from "../../../components/ui/menu";
import { contextMenuIcons } from "../../../components/ui/menu/contextMenuIcons";
import { catalogFamily, isSqlCatalogFamily } from "../hostCapabilities";
import { isMysqlConnectionInfoCapable } from "../api";
import { supportsTableDesign } from "../tableDesigner/resolveTableDesignerDriver";
import { insertSqlAtActiveCursor, prefetchTableSqlHistory, readTableSqlHistory } from "../sql/sqlExecLog";
import { isCloneTableSqlSupported } from "./tableCloneSql";
import { isSchemaDropSqlSupported } from "./schemaTreeDropSql";
import { buildClearTableDataSql, buildTruncateTableSql } from "./tableObjectSql";
import type { SchemaTableSelection } from "./schemaBrowserTypes";
import {
  addTableToAi,
  clearTableData,
  cloneTables,
  copyTableName,
  copyTablesWithData,
  copyTableStructure,
  exportTableCsv,
  exportTableInsertSql,
  exportSelectionDatabase,
  exportTableStructure,
  openGeneratedTableSql,
  openTableSqlDraft,
  readTablePinned,
  renameTable,
  setTableAutoIncrement,
  togglePinnedTable,
  truncateTable,
  viewTableDdlInSql,
} from "./tableObjectActions";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export type BuildTableObjectContextMenuDeps = {
  t: Translate;
  selection: SchemaTableSelection;
  /** 表列表多选；连接树传当前表。 */
  tableNames: string[];
  /** 克隆/复制时用来避开重名。 */
  existingNames: Iterable<string>;
  /** 表列表自己有删除和刷新；连接树由外层菜单补上。 */
  includeDelete: boolean;
  includeRefresh: boolean;
  onViewData: (selection: SchemaTableSelection) => void;
  onViewDataNewTab: (selection: SchemaTableSelection) => void;
  onNewQuery: (selection: SchemaTableSelection) => void;
  onDesign: (selection: SchemaTableSelection) => void;
  /** 表列表走 DDL 抽屉；缺省时在 SQL 标签页打开。 */
  onViewDdl?: (selection: SchemaTableSelection) => void;
  onExportDatabase?: (selection: SchemaTableSelection) => void;
  onDelete?: (names: string[]) => void;
  onRefresh?: () => void;
  /** 表列表记住已复制的表名，供粘贴克隆。 */
  onCopiedNames?: (names: string[]) => void;
  /** 结构变化后刷新表列表详情（schema 缓存由动作自己刷新）。 */
  onMutated?: () => void;
};

function historyLabel(sql: string): string {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  return oneLine.length > 72 ? `${oneLine.slice(0, 72)}…` : oneLine;
}

export function buildTableObjectContextMenu(
  deps: BuildTableObjectContextMenuDeps,
): ContextMenuItem[] {
  const {
    t,
    selection,
    tableNames,
    existingNames,
    includeDelete,
    includeRefresh,
    onViewData,
    onViewDataNewTab,
    onNewQuery,
    onDesign,
    onViewDdl,
    onExportDatabase,
    onDelete,
    onRefresh,
    onCopiedNames,
    onMutated,
  } = deps;

  const names = tableNames.length > 0 ? tableNames : [selection.tableName];
  const single = names.length === 1;
  const dbType = selection.connection.db_type;
  const sqlCapable = isSqlCatalogFamily(dbType);
  const canDesign = supportsTableDesign(selection.connection);
  const canClone = isCloneTableSqlSupported(dbType);
  const canTruncate = Boolean(buildTruncateTableSql(dbType, selection.dbName, selection.tableName));
  const canClear = Boolean(buildClearTableDataSql(dbType, selection.dbName, selection.tableName));
  const canAutoIncrement = catalogFamily(dbType) === "mysqlLike";
  const canExportDatabase = isMysqlConnectionInfoCapable(selection.connection);
  const pinned = single && readTablePinned(selection);
  const afterMutation = () => onMutated?.();

  const items: ContextMenuItem[] = [];

  if (single) {
    items.push({
      id: "pin-table",
      label: pinned ? t("database.sidebar.unpinTable") : t("database.sidebar.pinTable"),
      icon: pinned ? contextMenuIcons.unpin : contextMenuIcons.pin,
      onClick: () => togglePinnedTable(selection),
    });
  }

  items.push({
    id: "copy-name",
    label:
      names.length > 1
        ? t("database.tablesPanel.copyNames", { count: names.length })
        : t("database.tableMenu.copyName"),
    icon: contextMenuIcons.copy,
    onClick: () => {
      onCopiedNames?.(names);
      void copyTableName(names.join("\n"), t, names.length);
    },
  });

  if (single && sqlCapable) {
    items.push({
      id: "new-query",
      label: t("database.tableMenu.newQuery"),
      icon: contextMenuIcons.play,
      onClick: () => onNewQuery(selection),
    });
  }

  if (single) {
    items.push({
      id: "add-to-ai",
      label: t("database.tableMenu.addToAi"),
      icon: contextMenuIcons.ai,
      onClick: () => addTableToAi(selection, t),
    });
    items.push({ id: "sep-open", label: "", separator: true });
    items.push({
      id: "view-data",
      label: t("database.tableMenu.viewData"),
      icon: contextMenuIcons.open,
      onClick: () => onViewData(selection),
    });
    items.push({
      id: "view-data-tab",
      label: t("database.tableMenu.viewInNewTab"),
      icon: contextMenuIcons.openExternal,
      onClick: () => onViewDataNewTab(selection),
    });
    if (sqlCapable) {
      items.push({
        id: "view-ddl",
        label: t("database.contextMenu.viewDdl"),
        icon: contextMenuIcons.file,
        onClick: () => {
          if (onViewDdl) onViewDdl(selection);
          else void viewTableDdlInSql(selection, t);
        },
      });
    }
    if (canDesign) {
      items.push({
        id: "design-table",
        label: t("database.sqlEditorMenu.designTable"),
        icon: contextMenuIcons.design,
        onClick: () => onDesign(selection),
      });
    }
    if (sqlCapable) {
      items.push({
        id: "rename-table",
        label: t("database.tableMenu.rename"),
        icon: contextMenuIcons.rename,
        onClick: () => void renameTable(selection, t, afterMutation),
      });
      items.push({
        id: "generate-sql",
        label: t("database.tableMenu.generateSql"),
        icon: contextMenuIcons.list,
        children: (
          [
            ["select", "database.tableMenu.generateSelect"],
            ["insert", "database.tableMenu.generateInsert"],
            ["update", "database.tableMenu.generateUpdate"],
            ["delete", "database.tableMenu.generateDelete"],
          ] as const
        ).map(([kind, labelKey]) => ({
          id: `generate-${kind}`,
          label: t(labelKey),
          onClick: () => openGeneratedTableSql(selection, kind),
        })),
      });
      void prefetchTableSqlHistory(selection.connId, selection.dbName, selection.tableName);
      const history = readTableSqlHistory(selection.connId, selection.dbName, selection.tableName);
      items.push({
        id: "query-history",
        label: t("database.tableMenu.history"),
        icon: contextMenuIcons.file,
        children:
          history.length > 0
            ? history.map((entry) => ({
                id: `history-${entry.id}`,
                label: historyLabel(entry.sql),
                onClick: () => {
                  if (!insertSqlAtActiveCursor(entry.sql)) openTableSqlDraft(selection, entry.sql);
                },
              }))
            : [
                {
                  id: "history-empty",
                  label: t("database.tableMenu.historyEmpty"),
                  disabled: true,
                },
              ],
      });
    }
  }

  if (single && sqlCapable) {
    items.push({ id: "sep-export", label: "", separator: true });
    items.push({
      id: "export-data",
      label: t("database.tableMenu.exportData"),
      icon: contextMenuIcons.export,
      children: [
        {
          id: "export-csv",
          label: t("database.tableMenu.exportCsv"),
          onClick: () => void exportTableCsv(selection, t),
        },
        {
          id: "export-insert",
          label: t("database.tableMenu.exportInsert"),
          onClick: () => void exportTableInsertSql(selection, t),
        },
      ],
    });
    if (canExportDatabase) {
      items.push({
        id: "export-database",
        label: t("database.contextMenu.exportDatabase"),
        icon: contextMenuIcons.export,
        onClick: () => {
          if (onExportDatabase) onExportDatabase(selection);
          else exportSelectionDatabase(selection);
        },
      });
    }
    items.push({
      id: "export-structure",
      label: t("database.tableMenu.exportStructure"),
      icon: contextMenuIcons.download,
      onClick: () => void exportTableStructure(selection, t),
    });
    items.push({
      id: "copy-structure",
      label: t("database.tableMenu.copyStructure"),
      icon: contextMenuIcons.copy,
      onClick: () => void copyTableStructure(selection, t),
    });
  }

  if (canClone) {
    items.push({ id: "sep-clone", label: "", separator: true });
    items.push({
      id: "clone-table",
      label:
        names.length > 1
          ? t("database.tablesPanel.cloneTables", { count: names.length })
          : t("database.tableMenu.cloneAsNew"),
      icon: contextMenuIcons.duplicate,
      onClick: () => void cloneTables(selection, names, existingNames, t, afterMutation),
    });
    if (sqlCapable) {
      items.push({
        id: "copy-table",
        label:
          names.length > 1
            ? t("database.tableMenu.copyTables", { count: names.length })
            : t("database.tableMenu.copyTable"),
        icon: contextMenuIcons.duplicate,
        onClick: () => void copyTablesWithData(selection, names, existingNames, t, afterMutation),
      });
    }
  }

  if (single && canAutoIncrement) {
    items.push({
      id: "set-auto-increment",
      label: t("database.tableMenu.setAutoIncrement"),
      icon: contextMenuIcons.edit,
      onClick: () => void setTableAutoIncrement(selection, t, afterMutation),
    });
  }

  const moreChildren: ContextMenuItem[] = [];
  if (single && canTruncate) {
    moreChildren.push({
      id: "truncate-table",
      label: t("database.tableMenu.truncate"),
      danger: true,
      onClick: () => void truncateTable(selection, t, afterMutation),
    });
  }
  if (single && canClear) {
    moreChildren.push({
      id: "clear-table",
      label: t("database.tableMenu.clearData"),
      danger: true,
      onClick: () => void clearTableData(selection, t, afterMutation),
    });
  }
  if (includeDelete && onDelete && isSchemaDropSqlSupported(dbType)) {
    moreChildren.push({
      id: "delete-table",
      label:
        names.length > 1
          ? t("database.tablesPanel.deleteTables", { count: names.length })
          : t("database.schemaTree.deleteTable"),
      danger: true,
      icon: contextMenuIcons.delete,
      onClick: () => onDelete(names),
    });
  }
  if (moreChildren.length > 0) {
    items.push({
      id: "more",
      label: t("database.tableMenu.more"),
      icon: contextMenuIcons.list,
      children: moreChildren,
    });
  }

  if (includeRefresh && onRefresh) {
    items.push({ id: "sep-refresh", label: "", separator: true });
    items.push({
      id: "refresh-tables",
      label: t("common.refresh"),
      icon: contextMenuIcons.refresh,
      onClick: () => onRefresh(),
    });
  }

  return items;
}
