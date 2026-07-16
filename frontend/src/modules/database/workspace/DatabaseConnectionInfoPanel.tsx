import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useShallow } from "zustand/react/shallow";
import { useI18n } from "../../../i18n";
import { appConfirm } from "../../../lib/appConfirm";
import { appAlert } from "../../../lib/appAlert";
import { textSearchMatches } from "../../../lib/textSearchMatch";
import { Button } from "../../../components/ui/primitives/Button";
import { ScopedSearch } from "../../../components/ui/search/ScopedSearch";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useSshConnectionStore } from "../../../stores/sshConnectionStore";
import { useDbWorkspace } from "../../../contexts/DbWorkspaceContext";
import { useDbSchemaCacheStore } from "../../../stores/dbSchemaCacheStore";
import type { Connection } from "../../../ipc/bindings";
import {
  isMysqlConnectionInfoCapable,
  isPostgresConnectionInfoCapable,
  listDatabasesWithStats,
  type DbConnectionConfig,
  type DbDatabaseMeta,
} from "../api";
import {
  probeMysqlDeployment,
  type MysqlDeploymentInfo,
} from "../mysqlDeploymentDetect";
import { findSshConnectionForDbHostSync } from "../mysqlSlowQueryLog";
import {
  isMysqlDeploymentCacheUsable,
  readMysqlDeploymentCache,
  writeMysqlDeploymentCache,
} from "../mysqlDeploymentCache";
import { makeQueryRunId } from "../sql/queryRun";
import { displayDetailValue } from "./databaseTablesPanelFormat";
import { formatBytes } from "../../../stores/sshStatsStore";
import { DbTablesPanelGrid, type DbTablesPanelGridColumn } from "./DbTablesPanelGrid";
import { rowsToRecord, type QueryResult } from "./dbWorkspaceState";
import { DbDeploymentNavTag } from "./DbDeploymentNavTag";
import { DeploymentConfigEditorSubWindow } from "./DeploymentConfigEditorSubWindow";
import { DeploymentServiceActionButtons } from "./DeploymentServiceActionButtons";
import { DeploymentServiceLogSubWindow } from "./DeploymentServiceLogSubWindow";
import { DbPanelMetaRefreshButton } from "./DbPanelMetaRefreshButton";
import { useDeploymentConfigEditor } from "./useDeploymentConfigEditor";
import { useDeploymentServiceActions } from "./useDeploymentServiceActions";
import { CreateDatabaseDialog } from "./CreateDatabaseDialog";

import { buildMysqlCliSections } from "./connectionCliCommands";
import { ConnectionCliTabPanel } from "./ConnectionCliTabPanel";
import { ConnectionUsersTabPanel } from "./ConnectionUsersTabPanel";
import { useDbConnectionInfoNavStore } from "../stores/dbConnectionInfoNavStore";

const MYSQL_PROCESSLIST_SQL = "SHOW FULL PROCESSLIST;";
const MYSQL_VARIABLES_SQL = "SHOW VARIABLES;";
// PostgreSQL：进程列表来自 pg_stat_activity，变量来自 pg_settings
// 列别名与 MySQL 的 User/Host/Time 对齐，复用 SORTABLE_COLUMN_CANDIDATES 排序逻辑
const PG_PROCESSLIST_SQL =
  "SELECT pid AS Id, usename AS User, client_addr AS Host, datname AS db, state AS State, query AS Query, " +
  "EXTRACT(EPOCH FROM now() - query_start)::bigint AS Time " +
  "FROM pg_stat_activity WHERE datname IS NOT NULL ORDER BY Time DESC";
const PG_VARIABLES_SQL =
  "SELECT name, setting, source, context FROM pg_settings ORDER BY name";

/** localStorage 缓存 key：按 connection.id 持久化 databasesList，重开 tab 先用缓存 */
const DATABASES_CACHE_PREFIX = "db-conn-info-databases-cache:";

function readDatabasesCache(connectionId: string): DbDatabaseMeta[] | null {
  try {
    const raw = localStorage.getItem(DATABASES_CACHE_PREFIX + connectionId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as DbDatabaseMeta[];
  } catch {
    return null;
  }
}

function writeDatabasesCache(connectionId: string, list: DbDatabaseMeta[]): void {
  try {
    localStorage.setItem(DATABASES_CACHE_PREFIX + connectionId, JSON.stringify(list));
  } catch {
    // localStorage 满或不可用时静默忽略
  }
}

type DatabaseSortColumn = "name" | "charset" | "collation" | "tableCount" | "sizeBytes" | "rowsEstimate";
type DatabaseSortDirection = "asc" | "desc";

interface DatabaseSortState {
  column: DatabaseSortColumn;
  direction: DatabaseSortDirection;
}

type ConnectionInfoSubTab = "databases" | "users" | "connections" | "status" | "cli";

type ProcessSortColumn = "user" | "host" | "db" | "time";
type ProcessSortDirection = "asc" | "desc";
type VariablesSortColumn = "name" | "value";

interface ProcessSortState {
  column: ProcessSortColumn;
  direction: ProcessSortDirection;
}

interface VariablesSortState {
  column: VariablesSortColumn;
  direction: ProcessSortDirection;
}

const SORTABLE_COLUMN_CANDIDATES: Record<ProcessSortColumn, string[]> = {
  user: ["User"],
  host: ["Host"],
  db: ["db", "DB", "Db"],
  time: ["Time"],
};

const ID_COLUMN_CANDIDATES = ["Id", "ID", "id"];

const VARIABLE_NAME_COLUMNS = ["Variable_name", "variable_name", "name"];
const VARIABLE_VALUE_COLUMNS = ["Value", "value", "setting"];

interface DatabaseConnectionInfoPanelProps {
  connection: DbConnectionConfig;
  /** 当前 Tab 是否处于激活态；激活时自动拉取一次进程列表。 */
  active?: boolean;
}

function resolveColumnName(columns: string[], candidates: string[]): string | null {
  const byLower = new Map(columns.map((column) => [column.toLowerCase(), column]));
  for (const candidate of candidates) {
    const resolved = byLower.get(candidate.toLowerCase());
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function formatProcessCell(value: unknown): string {
  if (value == null) {
    return "—";
  }
  if (typeof value === "object") {
    return displayDetailValue(JSON.stringify(value));
  }
  return displayDetailValue(String(value));
}

function resolveProcessId(row: Record<string, unknown>, idColumn: string | null): number | null {
  if (!idColumn) {
    return null;
  }
  const raw = row[idColumn];
  const num = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  return num;
}

function rowMatchesSearch(row: Record<string, unknown>, query: string): boolean {
  return Object.values(row).some((value) => {
    if (value == null) {
      return false;
    }
    return textSearchMatches(query, String(value));
  });
}

function compareProcessRows(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  columnKey: string,
  column: ProcessSortColumn,
  direction: ProcessSortDirection,
): number {
  if (column === "time") {
    const aNum = Number(a[columnKey]);
    const bNum = Number(b[columnKey]);
    const aVal = Number.isFinite(aNum) ? aNum : -1;
    const bVal = Number.isFinite(bNum) ? bNum : -1;
    if (aVal !== bVal) {
      const cmp = aVal - bVal;
      return direction === "asc" ? cmp : -cmp;
    }
    return 0;
  }

  const cmp = formatProcessCell(a[columnKey]).localeCompare(
    formatProcessCell(b[columnKey]),
    undefined,
    { sensitivity: "base", numeric: true },
  );
  return direction === "asc" ? cmp : -cmp;
}

function resolveSortColumn(column: string, sortColumnKeys: Record<ProcessSortColumn, string | null>): ProcessSortColumn | null {
  for (const [sortColumn, key] of Object.entries(sortColumnKeys) as [ProcessSortColumn, string | null][]) {
    if (key === column) {
      return sortColumn;
    }
  }
  return null;
}

function compareVariableRows(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  nameKey: string,
  valueKey: string,
  column: VariablesSortColumn,
  direction: ProcessSortDirection,
): number {
  const key = column === "name" ? nameKey : valueKey;
  const cmp = formatProcessCell(a[key]).localeCompare(
    formatProcessCell(b[key]),
    undefined,
    { sensitivity: "base", numeric: true },
  );
  return direction === "asc" ? cmp : -cmp;
}

function resolveVariablesSortColumn(
  column: string,
  nameKey: string | null,
  valueKey: string | null,
): VariablesSortColumn | null {
  if (nameKey && column === nameKey) {
    return "name";
  }
  if (valueKey && column === valueKey) {
    return "value";
  }
  return null;
}

function MysqlDeploymentTags({
  loading,
  deployment,
  connection,
  sshConnections,
}: {
  loading: boolean;
  deployment: MysqlDeploymentInfo | null;
  connection: DbConnectionConfig;
  sshConnections: Connection[];
}) {
  const { t } = useI18n();

  const serverName = useMemo(() => {
    if (deployment?.serverName?.trim()) {
      return deployment.serverName.trim();
    }
    const ssh = findSshConnectionForDbHostSync(sshConnections, connection.host);
    return ssh?.name?.trim() ?? "";
  }, [connection.host, deployment?.serverName, sshConnections]);

  if (loading) {
    return (
      <span className="db-mysql-deploy-tag db-mysql-deploy-tag--checking">
        {t("database.connectionInfo.deployment.detecting")}
      </span>
    );
  }

  const kind = deployment?.kind ?? "unknown";
  const locationTag = deployment?.locationTag?.trim();
  const containerName =
    deployment?.containerName?.trim() || (kind === "docker" ? locationTag : "");

  return (
    <>
      <span className={`db-mysql-deploy-tag db-mysql-deploy-tag--${kind}`}>
        {t(`database.connectionInfo.deployment.kind.${kind}`)}
      </span>
      {kind === "host" && locationTag ? (
        <DbDeploymentNavTag
          label={t("database.connectionInfo.deployment.hostLocation")}
          value={locationTag}
        />
      ) : null}
      {kind === "docker" ? (
        <>
          {serverName ? (
            <DbDeploymentNavTag
              label={t("database.connectionInfo.deployment.server")}
              value={serverName}
            />
          ) : null}
          {containerName ? (
            <DbDeploymentNavTag
              label={t("database.connectionInfo.deployment.dockerContainer")}
              value={containerName}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

export function DatabaseConnectionInfoPanel({
  connection,
  active = true,
}: DatabaseConnectionInfoPanelProps) {
  const { t } = useI18n();
  const isMysql = isMysqlConnectionInfoCapable(connection);
  const isPostgres = isPostgresConnectionInfoCapable(connection);
  /** 连接信息面板是否支持该连接（MySQL/MariaDB 或 PostgreSQL） */
  const capable = isMysql || isPostgres;
  const sshConnections = useConnectionStore(
    useShallow((state) => state.connections.filter((conn) => conn.kind === "ssh")),
  );
  const sshSessionActiveMap = useSshConnectionStore((state) => state.sessionActiveMap);
  const { selectDatabase, databasesByConnId } = useDbWorkspace();
  const [subTab, setSubTab] = useState<ConnectionInfoSubTab>("databases");
  const [search, setSearch] = useState("");
  const [databasesLoading, setDatabasesLoading] = useState(false);
  const [databasesError, setDatabasesError] = useState<string | null>(null);
  const [databasesList, setDatabasesList] = useState<DbDatabaseMeta[]>(() => {
    // 优先用 localStorage 缓存（重开 tab 时立即可用），其次用 schema cache 库名
    const cached = readDatabasesCache(connection.id);
    if (cached && cached.length > 0) {
      return cached;
    }
    return (databasesByConnId[connection.id] ?? []).map((name) => ({
      name,
      charset: null,
      collation: null,
      tableCount: null,
      sizeBytes: null,
      rowsEstimate: null,
    }));
  });
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [variablesLoading, setVariablesLoading] = useState(false);
  const [deploymentLoading, setDeploymentLoading] = useState(false);
  const [deployment, setDeployment] = useState<MysqlDeploymentInfo | null>(() =>
    capable ? readMysqlDeploymentCache(connection) : null,
  );
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [variablesError, setVariablesError] = useState<string | null>(null);
  const [connectionsResult, setConnectionsResult] = useState<QueryResult | null>(null);
  const [variablesResult, setVariablesResult] = useState<QueryResult | null>(null);
  const [usersActions, setUsersActions] = useState<ReactNode | null>(null);
  const [usersRefreshNonce, setUsersRefreshNonce] = useState(0);
  const [createDbOpen, setCreateDbOpen] = useState(false);
  const [processSort, setProcessSort] = useState<ProcessSortState>({
    column: "time",
    direction: "desc",
  });
  const [variablesSort, setVariablesSort] = useState<VariablesSortState>({
    column: "name",
    direction: "asc",
  });
  const [databaseSort, setDatabaseSort] = useState<DatabaseSortState>({
    column: "name",
    direction: "asc",
  });
  const [killingId, setKillingId] = useState<number | null>(null);
  const consumeSubTab = useDbConnectionInfoNavStore((state) => state.consumeSubTab);
  // 标记是否已进入过 connections tab，用于切换回来时静默刷新（保留旧数据可见）
  const connectionsTabEnteredRef = useRef(false);

  // 从 schema cache 派生 users 可用性（schema cache 刷新时已拉取 users 列表，
  // 后端遇到 1142 会返回空数组；MySQL 的 mysql.user 不可能为空，空即无权限）
  // schema cache 尚未加载时（undefined）默认显示 tab
  const cachedUsers = useDbSchemaCacheStore(
    (s) => s.snapshot.connections?.[connection.id]?.users,
  );
  const usersAvailable = cachedUsers === undefined || cachedUsers.length > 0;

  const connectionLabel = useMemo(() => {
    const name = connection.name?.trim();
    if (name) return name;
    return `${connection.host}:${connection.port}`;
  }, [connection.host, connection.name, connection.port]);

  const {
    open: configEditorOpen,
    io: configEditorIo,
    configPath,
    opening: configOpening,
    close: closeConfigEditor,
    openMysqlConfig,
  } = useDeploymentConfigEditor(connectionLabel);

  const handleOpenMysqlConfig = useCallback(() => {
    void openMysqlConfig(deployment);
  }, [deployment, openMysqlConfig]);

  const {
    logOpen: serviceLogOpen,
    logIo: serviceLogIo,
    logSubtitle: serviceLogSubtitle,
    logBusy: serviceLogBusy,
    restartBusy: serviceRestartBusy,
    closeLog: closeServiceLog,
    viewServiceLog,
    restartService,
    canManageDeployedService,
  } = useDeploymentServiceActions();

  const handleViewServiceLog = useCallback(() => {
    void viewServiceLog(connection, deployment, "mysql");
  }, [connection, deployment, viewServiceLog]);

  const refreshDatabases = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!silent) {
      setDatabasesLoading(true);
    }
    setDatabasesError(null);
    try {
      const result = await listDatabasesWithStats(connection);
      setDatabasesList(result);
    } catch (e) {
      setDatabasesError(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      if (!silent) {
        setDatabasesLoading(false);
      }
    }
  }, [connection]);

  const refreshConnections = useCallback(async (options?: { silent?: boolean }) => {
    if (!capable) {
      return;
    }

    const silent = options?.silent ?? false;
    if (!silent) {
      setConnectionsLoading(true);
    }
    setConnectionsError(null);
    try {
      const queryResult = await invoke<QueryResult>("db_execute_query", {
        connection,
        sql: isPostgres ? PG_PROCESSLIST_SQL : MYSQL_PROCESSLIST_SQL,
        runId: makeQueryRunId(),
      });
      setConnectionsResult(queryResult);
    } catch (e) {
      setConnectionsError(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      if (!silent) {
        setConnectionsLoading(false);
      }
    }
  }, [capable, connection, isPostgres]);

  const refreshVariables = useCallback(async (options?: { silent?: boolean }) => {
    if (!capable) {
      return;
    }

    const silent = options?.silent ?? false;
    if (!silent) {
      setVariablesLoading(true);
      setVariablesResult(null);
    }
    setVariablesError(null);
    try {
      const queryResult = await invoke<QueryResult>("db_execute_query", {
        connection,
        sql: isPostgres ? PG_VARIABLES_SQL : MYSQL_VARIABLES_SQL,
        runId: makeQueryRunId(),
      });
      setVariablesResult(queryResult);
    } catch (e) {
      setVariablesError(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      if (!silent) {
        setVariablesLoading(false);
      }
    }
  }, [capable, connection, isPostgres]);

  const refreshDeployment = useCallback(async (options?: { force?: boolean }) => {
    // 部署探测目前仅支持 MySQL；PG 跳过，CLI tab 走 direct / SSH 隧道模式
    if (!isMysql) {
      setDeployment(null);
      setDeploymentLoading(false);
      return;
    }

    const cached = readMysqlDeploymentCache(connection);
    if (!options?.force && isMysqlDeploymentCacheUsable(cached)) {
      setDeployment(cached);
      setDeploymentLoading(false);
      return;
    }

    // 已有可展示缓存时静默刷新，避免顶部「部署方式」反复转圈
    if (!isMysqlDeploymentCacheUsable(cached)) {
      setDeploymentLoading(true);
    }
    try {
      const info = await probeMysqlDeployment(connection, sshConnections);
      writeMysqlDeploymentCache(connection, info);
      setDeployment(info);
    } catch {
      const fallback: MysqlDeploymentInfo = { kind: "unknown", reason: "probe_failed" };
      writeMysqlDeploymentCache(connection, fallback);
      setDeployment(fallback);
    } finally {
      setDeploymentLoading(false);
    }
  }, [isMysql, connection, sshConnections]);

  const refreshActiveTab = useCallback(
    async (options?: { silent?: boolean }) => {
      if (subTab === "databases") {
        await refreshDatabases();
      } else if (subTab === "users") {
        setUsersRefreshNonce((n) => n + 1);
      } else if (subTab === "connections") {
        await refreshConnections(options);
      } else if (subTab === "status") {
        await refreshVariables(options);
      } else if (subTab === "cli") {
        await refreshDeployment({ force: true });
      }
    },
    [refreshConnections, refreshDatabases, refreshDeployment, refreshVariables, subTab],
  );

  const handleRestartService = useCallback(() => {
    void restartService(deployment, "mysql", async () => {
      await refreshDeployment({ force: true });
      await refreshActiveTab();
    });
  }, [deployment, refreshActiveTab, refreshDeployment, restartService]);

  // 连接切换时重置所有状态（不含 databasesByConnId，避免 schema cache 刷新时误清 connections/variables）
  useEffect(() => {
    setSubTab("databases");
    setSearch("");
    setProcessSort({ column: "time", direction: "desc" });
    setVariablesSort({ column: "name", direction: "asc" });
    setDeployment(readMysqlDeploymentCache(connection));
    setDeploymentLoading(false);
    setConnectionsResult(null);
    setVariablesResult(null);
    setConnectionsError(null);
    setVariablesError(null);
    setDatabasesError(null);
    // 重置 connectionsTabEnteredRef，让新连接首次进入 connections tab 时正常加载
    connectionsTabEnteredRef.current = false;
  }, [connection.id, connection.host, connection.port, connection.db_type]);

  // databasesByConnId 变化时 merge：保留已有统计字段，只更新库名列表
  useEffect(() => {
    const names = databasesByConnId[connection.id] ?? [];
    setDatabasesList((prev) => {
      const prevMap = new Map(prev.map((db) => [db.name, db]));
      return names.map((name) => {
        const existing = prevMap.get(name);
        if (existing) {
          return existing;
        }
        return {
          name,
          charset: null,
          collation: null,
          tableCount: null,
          sizeBytes: null,
          rowsEstimate: null,
        };
      });
    });
  }, [connection.id, databasesByConnId]);

  // databasesList 变化时持久化到 localStorage（重开 tab 可先用缓存）
  useEffect(() => {
    if (databasesList.length > 0) {
      writeDatabasesCache(connection.id, databasesList);
    }
  }, [connection.id, databasesList]);

  useEffect(() => {
    const requested = consumeSubTab(connection.id);
    if (requested) {
      setSubTab(requested);
      setSearch("");
    }
  }, [connection.id, consumeSubTab, active]);

  // 权限丢失后若停在「用户」tab，回退到「库列表」
  useEffect(() => {
    if (!usersAvailable && subTab === "users") {
      setSubTab("databases");
      setSearch("");
    }
  }, [usersAvailable, subTab]);

  // 默认 tab（库列表）加载数据：优先用 context 缓存，无缓存则拉取
  // schema cache 正在刷新该连接时，不重复调 listDatabases（刷新完成后 databasesByConnId 会自动更新）
  const schemaRefreshing = useDbSchemaCacheStore(
    (s) => Boolean(s.refreshingConnectionIds[connection.id]),
  );

  useEffect(() => {
    if (!active) {
      return;
    }
    const cached = databasesByConnId[connection.id];
    if (cached && cached.length > 0) {
      // schema cache 只有库名，merge 到已有 databasesList（保留已加载的统计字段）
      // 实际 merge 逻辑由上面的 databasesByConnId useEffect 处理，这里只负责触发静默刷新
      void refreshDatabases({ silent: true });
      return;
    }
    // schema cache 正在刷新，等它完成后通过 databasesByConnId 自动更新，不重复调
    if (schemaRefreshing) {
      return;
    }
    void refreshDatabases();
  }, [active, connection.id, databasesByConnId, schemaRefreshing, refreshDatabases]);

  // 连接 tab：首次切到时拉取 processlist；后续重新进入时静默刷新（保留旧数据可见）
  useEffect(() => {
    if (!active || !capable || subTab !== "connections") {
      connectionsTabEnteredRef.current = false;
      return;
    }
    // 已进入过则不重复触发（避免 connectionsResult 更新后无限循环）
    if (connectionsTabEnteredRef.current) {
      return;
    }
    connectionsTabEnteredRef.current = true;
    if (connectionsResult == null) {
      // 首次加载：无数据，正常显示 loading
      void refreshConnections();
    } else {
      // 重新进入：有旧数据，静默刷新
      void refreshConnections({ silent: true });
    }
  }, [active, capable, subTab, connectionsResult, connectionsLoading, connectionsError, refreshConnections]);

  /** CLI tab 激活时才探测部署（懒加载，避免默认 tab 卡顿） */
  useEffect(() => {
    if (!active || !capable || subTab !== "cli") {
      return;
    }
    if (isMysqlDeploymentCacheUsable(deployment)) {
      return;
    }
    void refreshDeployment();
  }, [active, capable, subTab, deployment, refreshDeployment]);

  /** SSH 列表或会话就绪后重试（仅 CLI tab 且 unknown / 缺 SSH 时） */
  useEffect(() => {
    if (!active || !capable || subTab !== "cli" || deploymentLoading) {
      return;
    }
    if (isMysqlDeploymentCacheUsable(deployment)) {
      return;
    }
    if (deployment?.reason !== "ssh_not_connected" && deployment?.reason !== "no_ssh") {
      return;
    }
    const ssh = findSshConnectionForDbHostSync(sshConnections, connection.host);
    if (!ssh) {
      return;
    }
    if (deployment?.reason === "ssh_not_connected" && !sshSessionActiveMap[ssh.id]) {
      return;
    }
    void refreshDeployment({ force: true });
  }, [
    active,
    capable,
    subTab,
    deploymentLoading,
    deployment,
    connection.host,
    sshConnections,
    sshSessionActiveMap,
    refreshDeployment,
  ]);

  useEffect(() => {
    if (!active || !capable || subTab !== "status") {
      return;
    }
    if (variablesResult == null && !variablesLoading && variablesError == null) {
      void refreshVariables();
    }
  }, [
    active,
    capable,
    subTab,
    variablesResult,
    variablesLoading,
    variablesError,
    refreshVariables,
  ]);

  const processColumns = connectionsResult?.columns ?? [];
  const processRows = useMemo(
    () =>
      connectionsResult && processColumns.length > 0
        ? rowsToRecord(processColumns, connectionsResult.rows)
        : [],
    [connectionsResult, processColumns],
  );

  const variablesColumns = variablesResult?.columns ?? [];
  const variablesRows = useMemo(
    () =>
      variablesResult && variablesColumns.length > 0
        ? rowsToRecord(variablesColumns, variablesResult.rows)
        : [],
    [variablesResult, variablesColumns],
  );

  const processSortColumnKeys = useMemo(
    () =>
      ({
        user: resolveColumnName(processColumns, SORTABLE_COLUMN_CANDIDATES.user),
        host: resolveColumnName(processColumns, SORTABLE_COLUMN_CANDIDATES.host),
        db: resolveColumnName(processColumns, SORTABLE_COLUMN_CANDIDATES.db),
        time: resolveColumnName(processColumns, SORTABLE_COLUMN_CANDIDATES.time),
      }) satisfies Record<ProcessSortColumn, string | null>,
    [processColumns],
  );

  const idColumn = useMemo(
    () => resolveColumnName(processColumns, ID_COLUMN_CANDIDATES),
    [processColumns],
  );

  const variableNameColumn = useMemo(
    () => resolveColumnName(variablesColumns, VARIABLE_NAME_COLUMNS),
    [variablesColumns],
  );

  const variableValueColumn = useMemo(
    () => resolveColumnName(variablesColumns, VARIABLE_VALUE_COLUMNS),
    [variablesColumns],
  );

  const filteredDatabases = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return databasesList;
    return databasesList.filter((db) => db.name.toLowerCase().includes(q));
  }, [databasesList, search]);

  const toggleDatabaseSort = useCallback((column: DatabaseSortColumn) => {
    setDatabaseSort((prev) => {
      if (prev.column === column) {
        return { column, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { column, direction: "asc" };
    });
  }, []);

  const sortedDatabases = useMemo(() => {
    const { column, direction } = databaseSort;
    const sorted = [...filteredDatabases];
    sorted.sort((a, b) => {
      let cmp = 0;
      if (column === "name" || column === "charset" || column === "collation") {
        const av = (a[column] ?? "").toLowerCase();
        const bv = (b[column] ?? "").toLowerCase();
        cmp = av.localeCompare(bv, undefined, { numeric: true });
      } else {
        // 数值列：null 视为 -∞ 排在最前（asc 时）
        const av = a[column] ?? -Infinity;
        const bv = b[column] ?? -Infinity;
        cmp = av - bv;
      }
      return direction === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [filteredDatabases, databaseSort]);

  const filteredProcessRows = useMemo(() => {
    const q = search.trim();
    if (!q) {
      return processRows;
    }
    return processRows.filter((row) => rowMatchesSearch(row, q));
  }, [processRows, search]);

  const sortedProcessRows = useMemo(() => {
    const sortKey = processSortColumnKeys[processSort.column];
    if (!sortKey) {
      return filteredProcessRows;
    }
    const list = [...filteredProcessRows];
    list.sort((a, b) =>
      compareProcessRows(a, b, sortKey, processSort.column, processSort.direction),
    );
    return list;
  }, [filteredProcessRows, processSort, processSortColumnKeys]);

  const filteredVariableRows = useMemo(() => {
    const q = search.trim();
    if (!q) {
      return variablesRows;
    }
    return variablesRows.filter((row) => rowMatchesSearch(row, q));
  }, [variablesRows, search]);

  const sortedVariableRows = useMemo(() => {
    if (!variableNameColumn || !variableValueColumn) {
      return filteredVariableRows;
    }
    const list = [...filteredVariableRows];
    list.sort((a, b) =>
      compareVariableRows(
        a,
        b,
        variableNameColumn,
        variableValueColumn,
        variablesSort.column,
        variablesSort.direction,
      ),
    );
    return list;
  }, [
    filteredVariableRows,
    variableNameColumn,
    variableValueColumn,
    variablesSort.column,
    variablesSort.direction,
  ]);

  const cliSections = useMemo(
    () => buildMysqlCliSections(t, connection, deployment, sshConnections),
    [connection, deployment, sshConnections, t],
  );

  const tabLoading =
    subTab === "databases"
      ? databasesLoading
      : subTab === "connections"
        ? connectionsLoading
        : subTab === "status"
          ? variablesLoading
          : subTab === "cli"
            ? deploymentLoading
            : false;

  const tabCount =
    subTab === "databases"
      ? filteredDatabases.length
      : subTab === "connections"
        ? sortedProcessRows.length
        : subTab === "status"
          ? sortedVariableRows.length
          : cliSections.length;

  const toggleProcessSort = useCallback((column: ProcessSortColumn) => {
    setProcessSort((prev) => {
      if (prev.column === column) {
        return { column, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return {
        column,
        direction: column === "time" ? "desc" : "asc",
      };
    });
  }, []);

  const toggleVariablesSort = useCallback((column: VariablesSortColumn) => {
    setVariablesSort((prev) => {
      if (prev.column === column) {
        return { column, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { column, direction: "asc" };
    });
  }, []);

  const handleKill = useCallback(
    async (row: Record<string, unknown>) => {
      const id = resolveProcessId(row, idColumn);
      if (id == null || killingId != null) {
        return;
      }

      const user = formatProcessCell(row[processSortColumnKeys.user ?? "User"]);
      const host = formatProcessCell(row[processSortColumnKeys.host ?? "Host"]);
      const confirmed = await appConfirm(
        t("database.connectionInfo.killConfirm", { id: String(id), user, host }),
        t("database.connectionInfo.killConfirmTitle"),
        { confirmLabel: t("database.connectionInfo.kill") },
      );
      if (!confirmed) {
        return;
      }

      setKillingId(id);
      try {
        await invoke<QueryResult>("db_execute_query", {
          connection,
          sql: `KILL ${id};`,
          runId: makeQueryRunId(),
        });
        await refreshConnections({ silent: true });
      } catch (e) {
        const message = typeof e === "string" ? e : JSON.stringify(e);
        void appAlert(message, t("database.connectionInfo.killFailed"));
      } finally {
        setKillingId(null);
      }
    },
    [
      connection,
      idColumn,
      killingId,
      processSortColumnKeys.host,
      processSortColumnKeys.user,
      refreshConnections,
      t,
    ],
  );

  const processGridColumns = useMemo((): DbTablesPanelGridColumn<Record<string, unknown>>[] => {
    const dataColumns = processColumns.map((column, index) => {
      const sortColumn = resolveSortColumn(column, processSortColumnKeys);
      return {
        id: column,
        sortId: sortColumn ?? undefined,
        header: column,
        sortable: sortColumn != null,
        nameCell: index === 0,
        render: (row: Record<string, unknown>) => formatProcessCell(row[column]),
        getTitle: (row: Record<string, unknown>) => formatProcessCell(row[column]),
        getCopyValue: (row: Record<string, unknown>) => formatProcessCell(row[column]),
      };
    });

    return [
      ...dataColumns,
      {
        id: "__actions",
        variant: "actionsSticky" as const,
        header: t("database.connectionInfo.actions"),
        headerAriaLabel: t("database.connectionInfo.actions"),
        render: (row: Record<string, unknown>) => {
          const processId = resolveProcessId(row, idColumn);
          const isKilling = processId != null && killingId === processId;
          return (
            <Button
              variant="danger"
              size="xs"
              disabled={processId == null || killingId != null}
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                event.stopPropagation();
                void handleKill(row);
              }}
            >
              {isKilling ? t("database.connectionInfo.killing") : t("database.connectionInfo.kill")}
            </Button>
          );
        },
      },
    ];
  }, [handleKill, idColumn, killingId, processColumns, processSortColumnKeys, t]);

  const variablesGridColumns = useMemo((): DbTablesPanelGridColumn<Record<string, unknown>>[] => {
    return variablesColumns.map((column, index) => {
      const sortColumn = resolveVariablesSortColumn(
        column,
        variableNameColumn,
        variableValueColumn,
      );
      return {
        id: column,
        sortId: sortColumn ?? undefined,
        header: column,
        sortable: sortColumn != null,
        nameCell: index === 0,
        render: (row: Record<string, unknown>) => formatProcessCell(row[column]),
        getTitle: (row: Record<string, unknown>) => formatProcessCell(row[column]),
        getCopyValue: (row: Record<string, unknown>) => formatProcessCell(row[column]),
      };
    });
  }, [variableNameColumn, variableValueColumn, variablesColumns]);

  const renderConnectionsTable = () => {
    // 有旧数据时保留显示，仅首次加载（无数据时）显示 loading
    if (connectionsLoading && !connectionsResult) {
      return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
    }
    if (connectionsError && !connectionsResult) {
      return <div className="db-tables-panel-error">{connectionsError}</div>;
    }
    if (processColumns.length === 0 || processRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("database.connectionInfo.empty")}</div>;
    }
    if (sortedProcessRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("database.connectionInfo.noResults")}</div>;
    }

    return (
      <DbTablesPanelGrid
        variant="processlist"
        columns={processGridColumns}
        rows={sortedProcessRows}
        rowKey={(row, rowIndex) => resolveProcessId(row, idColumn) ?? rowIndex}
        sortColumnId={processSort.column}
        sortDirection={processSort.direction}
        onSortColumn={(columnId) => toggleProcessSort(columnId as ProcessSortColumn)}
      />
    );
  };

  const renderVariablesTable = () => {
    if (variablesLoading) {
      return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
    }
    if (variablesError) {
      return <div className="db-tables-panel-error">{variablesError}</div>;
    }
    if (variablesColumns.length === 0 || variablesRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("database.connectionInfo.empty")}</div>;
    }
    if (sortedVariableRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("database.connectionInfo.noResults")}</div>;
    }

    return (
      <DbTablesPanelGrid
        variant="variables"
        columns={variablesGridColumns}
        rows={sortedVariableRows}
        rowKey={(_row, rowIndex) => rowIndex}
        sortColumnId={variablesSort.column}
        sortDirection={variablesSort.direction}
        onSortColumn={(columnId) => toggleVariablesSort(columnId as VariablesSortColumn)}
      />
    );
  };

  const renderCliSession = () => (
    <ConnectionCliTabPanel
      connection={connection}
      client={isPostgres ? "psql" : "mysql"}
      deployment={deployment}
      deploymentLoading={deploymentLoading}
      sshConnections={sshConnections}
      panelActive={active}
      visible={subTab === "cli"}
    />
  );

  const databaseGridColumns = useMemo<DbTablesPanelGridColumn<DbDatabaseMeta>[]>(
    () => [
      {
        id: "name",
        header: t("database.connectionInfo.databases.colName"),
        sortable: true,
        sortId: "name",
        nameCell: true,
        defaultWidth: 200,
        minWidth: 120,
        render: (db) => db.name,
        getTitle: (db) => db.name,
        getCopyValue: (db) => db.name,
      },
      {
        id: "charset",
        header: t("database.connectionInfo.databases.colCharset"),
        sortable: true,
        sortId: "charset",
        defaultWidth: 120,
        minWidth: 80,
        render: (db) => db.charset ?? "—",
        getTitle: (db) => db.charset ?? "",
        getCopyValue: (db) => db.charset ?? "",
      },
      {
        id: "collation",
        header: t("database.connectionInfo.databases.colCollation"),
        sortable: true,
        sortId: "collation",
        defaultWidth: 140,
        minWidth: 80,
        render: (db) => db.collation ?? "—",
        getTitle: (db) => db.collation ?? "",
        getCopyValue: (db) => db.collation ?? "",
      },
      {
        id: "tableCount",
        header: t("database.connectionInfo.databases.colTables"),
        sortable: true,
        sortId: "tableCount",
        headerClassName: "db-cell-num",
        cellClassName: "db-cell-num",
        defaultWidth: 90,
        minWidth: 64,
        render: (db) =>
          db.tableCount != null ? db.tableCount.toLocaleString() : "—",
        getTitle: (db) =>
          db.tableCount != null ? String(db.tableCount) : "",
        getCopyValue: (db) =>
          db.tableCount != null ? String(db.tableCount) : "",
      },
      {
        id: "sizeBytes",
        header: t("database.connectionInfo.databases.colSize"),
        sortable: true,
        sortId: "sizeBytes",
        headerClassName: "db-cell-num",
        cellClassName: "db-cell-num",
        defaultWidth: 100,
        minWidth: 72,
        render: (db) =>
          db.sizeBytes != null ? formatBytes(db.sizeBytes) : "—",
        getTitle: (db) =>
          db.sizeBytes != null ? formatBytes(db.sizeBytes) : "",
        getCopyValue: (db) =>
          db.sizeBytes != null ? String(db.sizeBytes) : "",
      },
      {
        id: "rowsEstimate",
        header: t("database.connectionInfo.databases.colRows"),
        sortable: true,
        sortId: "rowsEstimate",
        headerClassName: "db-cell-num",
        cellClassName: "db-cell-num",
        defaultWidth: 100,
        minWidth: 72,
        render: (db) =>
          db.rowsEstimate != null ? db.rowsEstimate.toLocaleString() : "—",
        getTitle: (db) =>
          db.rowsEstimate != null ? String(db.rowsEstimate) : "",
        getCopyValue: (db) =>
          db.rowsEstimate != null ? String(db.rowsEstimate) : "",
      },
      {
        id: "__actions",
        variant: "actionsSticky" as const,
        header: t("database.connectionInfo.users.colActions"),
        headerAriaLabel: t("database.connectionInfo.users.colActions"),
        render: (db) => (
          <Button
            variant="ghost"
            size="xs"
            onClick={(e: MouseEvent<HTMLButtonElement>) => {
              e.stopPropagation();
              selectDatabase(
                { connId: connection.id, dbName: db.name, connection },
                "permanent",
              );
            }}
          >
            {t("database.connectionInfo.databases.open")}
          </Button>
        ),
      },
    ],
    [connection, selectDatabase, t],
  );

  const renderDatabasesList = () => {
    // 有旧数据时保留显示，仅首次加载（无数据时）显示 loading
    if (databasesLoading && databasesList.length === 0) {
      return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
    }
    if (databasesError && databasesList.length === 0) {
      return <div className="db-tables-panel-error">{databasesError}</div>;
    }
    if (databasesList.length === 0) {
      return <div className="db-tables-panel-empty">{t("database.connectionInfo.empty")}</div>;
    }
    if (sortedDatabases.length === 0) {
      return <div className="db-tables-panel-empty">{t("database.connectionInfo.noResults")}</div>;
    }
    return (
      <DbTablesPanelGrid
        variant="processlist"
        columns={databaseGridColumns}
        rows={sortedDatabases}
        rowKey={(db) => db.name}
        sortColumnId={databaseSort.column}
        sortDirection={databaseSort.direction}
        onSortColumn={(columnId) => toggleDatabaseSort(columnId as DatabaseSortColumn)}
        columnResizeStorageKey={`db-conn-info-databases-${connection.id}`}
      />
    );
  };

  const renderUsersPanel = () => (
    <ConnectionUsersTabPanel
      connection={connection}
      active={active && subTab === "users"}
      search={search}
      refreshNonce={usersRefreshNonce}
      onActionsReady={setUsersActions}
    />
  );

  const renderPanelMainContent = () => (
    <>
      {capable && active ? renderCliSession() : null}
      {subTab === "databases"
        ? renderDatabasesList()
        : subTab === "users"
          ? renderUsersPanel()
          : subTab === "connections"
            ? renderConnectionsTable()
            : subTab === "status"
              ? renderVariablesTable()
              : null}
    </>
  );

  const panelBody = (content: ReactNode) => (
    <ScopedSearch
      className="db-tables-panel db-tables-panel--dock"
      value={search}
      onChange={setSearch}
      placeholder={
        subTab === "databases"
          ? t("database.connectionInfo.databases.search")
          : subTab === "users"
            ? t("database.connectionInfo.users.search")
            : subTab === "connections"
              ? t("database.connectionInfo.search")
              : subTab === "status"
                ? t("database.connectionInfo.variablesSearch")
                : ""
      }
      enabled={capable && subTab !== "cli" && subTab !== "users"}
    >
      {isMysql ? (
        <div className="db-connection-info-deploy">
          <span className="db-connection-info-deploy-label">
            {t("database.connectionInfo.deployment.label")}
          </span>
          <div className="db-connection-info-deploy-tags">
            <MysqlDeploymentTags
              loading={deploymentLoading}
              deployment={deployment}
              connection={connection}
              sshConnections={sshConnections}
            />
          </div>
          {deployment?.kind === "host" || deployment?.kind === "docker" ? (
            <DeploymentServiceActionButtons
              canManage={canManageDeployedService(deployment)}
              logBusy={serviceLogBusy}
              restartBusy={serviceRestartBusy}
              configBusy={configOpening}
              onViewLog={handleViewServiceLog}
              onRestart={handleRestartService}
              onOpenConfig={handleOpenMysqlConfig}
            />
          ) : null}
        </div>
      ) : null}
      {capable ? (
        <div className="db-connection-info-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className={`db-toolbox-tab${subTab === "databases" ? " active" : ""}`}
            aria-selected={subTab === "databases"}
            onClick={() => {
              setSubTab("databases");
              setSearch("");
            }}
          >
            {t("database.connectionInfo.tabs.databases")}
          </button>
          {usersAvailable ? (
            <button
              type="button"
              role="tab"
              className={`db-toolbox-tab${subTab === "users" ? " active" : ""}`}
              aria-selected={subTab === "users"}
              onClick={() => {
                setSubTab("users");
                setSearch("");
              }}
            >
              {t("database.connectionInfo.tabs.users")}
            </button>
          ) : null}
          <button
            type="button"
            role="tab"
            className={`db-toolbox-tab${subTab === "connections" ? " active" : ""}`}
            aria-selected={subTab === "connections"}
            onClick={() => {
              setSubTab("connections");
              setSearch("");
            }}
          >
            {t("database.connectionInfo.tabs.connections")}
          </button>
          <button
            type="button"
            role="tab"
            className={`db-toolbox-tab${subTab === "status" ? " active" : ""}`}
            aria-selected={subTab === "status"}
            onClick={() => {
              setSubTab("status");
              setSearch("");
            }}
          >
            {t("database.connectionInfo.tabs.status")}
          </button>
          <button
            type="button"
            role="tab"
            className={`db-toolbox-tab${subTab === "cli" ? " active" : ""}`}
            aria-selected={subTab === "cli"}
            onClick={() => {
              setSubTab("cli");
              setSearch("");
            }}
          >
            {t("database.connectionInfo.tabs.cli")}
          </button>
        </div>
      ) : null}
      <div
        className="db-tables-panel-body"
        role="tabpanel"
        aria-label={
          subTab === "databases"
            ? t("database.connectionInfo.tabs.databases")
            : subTab === "users"
              ? t("database.connectionInfo.tabs.users")
              : subTab === "connections"
                ? t("database.connectionInfo.tabs.connections")
                : subTab === "status"
                  ? t("database.connectionInfo.tabs.status")
                  : t("database.connectionInfo.tabs.cli")
        }
      >
        <div
          className={`db-tables-panel-grid-wrap${subTab === "cli" ? " db-tables-panel-grid-wrap--cli" : ""}${subTab === "users" ? " db-tables-panel-grid-wrap--users" : ""}`}
        >
          {content}
        </div>
      </div>
      <div className="db-tables-panel-meta">
        <DbPanelMetaRefreshButton
          onClick={() => {
            void refreshActiveTab();
          }}
          disabled={tabLoading || !capable}
        />
        {subTab === "databases" && capable ? (
          <div className="db-tables-panel-meta-actions">
            <Button
              variant="default"
              size="xs"
              onClick={() => setCreateDbOpen(true)}
            >
              {t("database.connectionInfo.databases.create")}
            </Button>
          </div>
        ) : null}
        {usersActions ? (
          <div className="db-tables-panel-meta-actions">{usersActions}</div>
        ) : null}
        <span className="db-tables-panel-meta-text">
          {tabLoading
            ? t("common.loading")
            : subTab === "cli"
              ? t("database.connectionInfo.cli.sectionCount", { count: tabCount })
              : t("database.connectionInfo.count", { count: tabCount })}
        </span>
      </div>
    </ScopedSearch>
  );

  if (!capable) {
    return (
      <>
        {panelBody(
          <div className="db-tables-panel-empty">
            {t("database.connectionInfo.unsupportedEngine", { engine: connection.db_type })}
          </div>,
        )}
        <DeploymentConfigEditorSubWindow
          open={configEditorOpen}
          io={configEditorIo}
          configPath={configPath}
          connectionLabel={connectionLabel}
          onClose={closeConfigEditor}
        />
        <DeploymentServiceLogSubWindow
          open={serviceLogOpen}
          io={serviceLogIo}
          logSubtitle={serviceLogSubtitle}
          connectionLabel={connectionLabel}
          onClose={closeServiceLog}
        />
      </>
    );
  }

  return (
    <>
      {panelBody(renderPanelMainContent())}
      <DeploymentConfigEditorSubWindow
        open={configEditorOpen}
        io={configEditorIo}
        configPath={configPath}
        connectionLabel={connectionLabel}
        onClose={closeConfigEditor}
      />
      <DeploymentServiceLogSubWindow
        open={serviceLogOpen}
        io={serviceLogIo}
        logSubtitle={serviceLogSubtitle}
        connectionLabel={connectionLabel}
        onClose={closeServiceLog}
      />
      <CreateDatabaseDialog
        open={createDbOpen}
        connection={connection}
        onCancel={() => setCreateDbOpen(false)}
        onCreated={() => {
          setCreateDbOpen(false);
          void refreshDatabases({ silent: false });
        }}
      />
    </>
  );
}
