import { commands } from "../ipc/bindings";
import { emptySchemaCacheSnapshot } from "../modules/database/schema/schemaCache";
import { useDbDockLayoutStore } from "../stores/dbDockLayoutStore";
import { useDbSchemaCacheStore } from "../stores/dbSchemaCacheStore";
import { useDbSchemaFilterStore } from "../stores/dbSchemaFilterStore";
import { useDbSchemaTreeExpandedStore } from "../stores/dbSchemaTreeExpandedStore";
import { useDbSqlFileStore } from "../stores/dbSqlFileStore";
import { useDbTreeChartFileStore } from "../stores/dbTreeChartFileStore";
import { useDbWorkspaceSessionStore } from "../stores/dbWorkspaceSessionStore";
import { useDbWorkspaceTabStore } from "../stores/dbWorkspaceTabStore";

const DB_SQL_FILES_CACHE_KEY = "omnipanel-db-sql-files";
const DB_TREE_CHART_FILES_CACHE_KEY = "omnipanel-db-tree-chart-files";
const DB_SCHEMA_SIDEBAR_SECTIONS_KEY = "omnipanel-db-schema-sidebar-sections";

const EMPTY_SCHEMA_FILTERS = { databaseFilters: {}, tableFilters: {} };
const EMPTY_SCHEMA_TREE_EXPANDED = { expandedNodeIds: [] as string[] };

/** 清除数据库模块全部用户数据：连接、Schema 缓存/过滤、SQL 文件、工作区会话等。 */
export async function clearDatabaseModuleData(): Promise<void> {
  const listRes = await commands.dbListConnections();
  if (listRes.status === "ok") {
    for (const conn of listRes.data) {
      await commands.dbDeleteConnection(conn.id).catch(() => undefined);
    }
  }

  await Promise.all([
    commands.dbSaveSchemaCache({ connections: {} }).catch(() => undefined),
    commands.dbSaveSchemaFilters(EMPTY_SCHEMA_FILTERS).catch(() => undefined),
    commands.dbSaveSchemaTreeExpanded(EMPTY_SCHEMA_TREE_EXPANDED).catch(() => undefined),
    commands.dbSqlFilesSave({ version: 1, nodes: [] }).catch(() => undefined),
    commands.dbTreeChartFilesSave({ version: 1, nodes: [] }).catch(() => undefined),
  ]);

  useDbWorkspaceSessionStore.setState({
    session: null,
    recentClosedPanels: [],
  });
  useDbWorkspaceTabStore.getState().resetTabWorkspace();
  useDbSchemaCacheStore.setState({
    snapshot: emptySchemaCacheSnapshot(),
    hydrated: true,
    refreshingConnectionIds: {},
    refreshingNodeIds: {},
  });
  useDbSchemaFilterStore.setState({
    databaseFilters: {},
    tableFilters: {},
    hydrated: true,
  });
  useDbSchemaTreeExpandedStore.setState({
    expandedNodeIds: new Set<string>(),
    hydrated: true,
  });
  useDbSqlFileStore.setState({ nodes: [], dirtyFileIds: [] });
  useDbTreeChartFileStore.setState({ nodes: [], dirtyFileIds: [] });
  useDbDockLayoutStore.getState().reset();

  try {
    localStorage.removeItem(DB_SQL_FILES_CACHE_KEY);
    localStorage.removeItem(DB_TREE_CHART_FILES_CACHE_KEY);
    localStorage.removeItem(DB_SCHEMA_SIDEBAR_SECTIONS_KEY);
  } catch {
    // ignore
  }
}
