import type { ContextMenuItem } from "../../../components/ui/menu";
import type { DbConnectionConfig } from "../api";
import type { DbSqlFileNode } from "../../../stores/dbSqlFileStore";
import type { SchemaTreeItem } from "./schemaTreeItem";
import type { SchemaCacheConnectionEntry } from "./schemaCache";
import type { SchemaSidebarSectionConfig } from "./SchemaSidebarSection";
import type { SchemaDockOpenMode } from "../workspace/workspaceTabs";

export type SchemaTableSelection = {
  connId: string;
  dbName: string;
  tableName: string;
  connection: DbConnectionConfig;
};

export type SchemaDatabaseSelection = {
  connId: string;
  dbName: string;
  connection: DbConnectionConfig;
};

export type SchemaContextMenuContext = {
  connection?: DbConnectionConfig;
  tableSelection?: SchemaTableSelection;
  /** 多选删除连接时传入（含当前右键连接） */
  selectedConnections?: DbConnectionConfig[];
};

export interface SchemaBrowserProps {
  activeConnId?: string | null;
  onCreateConnection?: () => void;
  onNewSqlQuery?: () => void;
  onImportNavicat?: () => void;
  onSelectConnection?: (
    connId: string,
    mode?: SchemaDockOpenMode,
    options?: { expandTree?: boolean },
  ) => void;
  onSelectTable?: (selection: SchemaTableSelection, mode?: SchemaDockOpenMode) => void;
  onSelectDatabase?: (selection: SchemaDatabaseSelection, mode?: SchemaDockOpenMode) => void;
  onOpenSqlFile?: (file: DbSqlFileNode) => void;
  buildSchemaContextMenuItems?: (
    item: SchemaTreeItem,
    context: SchemaContextMenuContext,
  ) => ContextMenuItem[];
  /** Delete 快捷键删除连接时由 DatabasePanel 处理确认与落库 */
  onDeleteConnections?: (
    connections: DbConnectionConfig[],
  ) => boolean | Promise<boolean>;
  onSchemaCacheConnectionPatched?: (connId: string, entry: SchemaCacheConnectionEntry) => void;
  activeTableKey?: string | null;
  activeDatabaseKey?: string | null;
  /** 所有已在工作区打开 Tab 的树节点 id 集合（用于标记"已打开"状态） */
  openTabNodeIds?: Set<string>;
  refreshToken?: number;
  section?: SchemaSidebarSectionConfig;
  /** 由 DatabasePanel 注入，避免重复 listConnections 与 remount 后空白加载 */
  connectionConfigs?: DbConnectionConfig[];
  connectionsReady?: boolean;
}
