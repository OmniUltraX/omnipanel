import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useI18n } from "../../../i18n";
import { textSearchMatches } from "../../../lib/textSearchMatch";
import { ScopedSearch } from "../../../components/ui/search/ScopedSearch";
import { Button } from "../../../components/ui/primitives/Button";
import { TextInput } from "../../../components/ui/form/TextInput";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useSshConnectionStore } from "../../../stores/sshConnectionStore";
import { useDbSchemaCacheStore } from "../../../stores/dbSchemaCacheStore";
import type { Connection } from "../../../ipc/bindings";
import { useDbWorkspace } from "../../../contexts/DbWorkspaceContext";
import {
  isRedisConnection,
  listDatabasesWithStats,
  redisClientKill,
  redisConfigRewrite,
  redisConfigSet,
  redisFlushDb,
  redisGetClientList,
  redisGetConfigAll,
  redisInfo,
  type DbConnectionConfig,
  type DbDatabaseMeta,
  type RedisInfoResult,
} from "../api";
import { findSshConnectionForDbHostSync } from "../mysqlSlowQueryLog";
import {
  probeRedisDeployment,
  type RedisDeploymentInfo,
} from "../redisDeploymentDetect";
import {
  isRedisDeploymentCacheUsable,
  readRedisDeploymentCache,
  writeRedisDeploymentCache,
} from "../redisDeploymentCache";
import { displayDetailValue } from "./databaseTablesPanelFormat";
import { DbTablesPanelGrid, type DbTablesPanelGridColumn } from "./DbTablesPanelGrid";
import { rowsToRecord, type QueryResult } from "./dbWorkspaceState";
import { DbDeploymentNavTag } from "./DbDeploymentNavTag";
import { DeploymentConfigEditorSubWindow } from "./DeploymentConfigEditorSubWindow";
import { DeploymentServiceActionButtons } from "./DeploymentServiceActionButtons";
import { DeploymentServiceLogSubWindow } from "./DeploymentServiceLogSubWindow";
import { DbPanelMetaRefreshButton } from "./DbPanelMetaRefreshButton";
import { useDeploymentConfigEditor } from "./useDeploymentConfigEditor";
import { useDeploymentServiceActions } from "./useDeploymentServiceActions";

import { buildRedisCliSections } from "./connectionCliCommands";
import { ConnectionCliTabPanel } from "./ConnectionCliTabPanel";
import {
  RedisAclPanel,
  RedisConnectionSlowlogPanel,
  RedisMemoryPanel,
  RedisReplicationPanel,
} from "./RedisConnectionOpsPanels";
import { RedisOverviewCards } from "../redis/RedisOverviewCards";
type ConnectionInfoSubTab =
  | "overview"
  | "databases"
  | "connections"
  | "memory"
  | "replication"
  | "status"
  | "slowlog"
  | "acl"
  | "cli";

type ConfigSortColumn = "name" | "value";
type ConfigSortDirection = "asc" | "desc";

type ClientSortColumn = "id" | "addr" | "idle" | "cmd" | "db";
type ClientSortDirection = "asc" | "desc";

type DatabaseSortColumn = "name" | "keys";
type DatabaseSortDirection = "asc" | "desc";

interface ConfigSortState {
  column: ConfigSortColumn;
  direction: ConfigSortDirection;
}

interface ClientSortState {
  column: ClientSortColumn;
  direction: ClientSortDirection;
}

interface DatabaseSortState {
  column: DatabaseSortColumn;
  direction: DatabaseSortDirection;
}

function formatRedisDbLabel(name: string): string {
  return /^\d+$/.test(name) ? `db${name}` : name;
}

const CLIENT_SORT_COLUMN_CANDIDATES: Record<ClientSortColumn, string[]> = {
  id: ["id"],
  addr: ["addr"],
  idle: ["idle"],
  cmd: ["cmd"],
  db: ["db"],
};

const PARAMETER_COLUMNS = ["parameter", "Parameter", "name", "Name"];
const VALUE_COLUMNS = ["value", "Value"];

interface RedisConnectionInfoPanelProps {
  connection: DbConnectionConfig;
  /** 当前 Tab 是否处于激活态；激活时自动拉取一次配置。 */
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

function formatConfigCell(value: unknown): string {
  if (value == null) {
    return "—";
  }
  if (typeof value === "object") {
    return displayDetailValue(JSON.stringify(value));
  }
  return displayDetailValue(String(value));
}

function rowMatchesSearch(row: Record<string, unknown>, query: string): boolean {
  return Object.values(row).some((value) => {
    if (value == null) {
      return false;
    }
    return textSearchMatches(query, String(value));
  });
}

function compareConfigRows(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  nameKey: string,
  valueKey: string,
  column: ConfigSortColumn,
  direction: ConfigSortDirection,
): number {
  const key = column === "name" ? nameKey : valueKey;
  const cmp = formatConfigCell(a[key]).localeCompare(
    formatConfigCell(b[key]),
    undefined,
    { sensitivity: "base", numeric: true },
  );
  return direction === "asc" ? cmp : -cmp;
}

function compareClientRows(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  columnKey: string,
  column: ClientSortColumn,
  direction: ClientSortDirection,
): number {
  if (column === "id" || column === "idle" || column === "db") {
    const aNum = Number(a[columnKey]);
    const bNum = Number(b[columnKey]);
    const aVal = Number.isFinite(aNum) ? aNum : -1;
    const bVal = Number.isFinite(bNum) ? bNum : -1;
    const cmp = aVal - bVal;
    return direction === "asc" ? cmp : -cmp;
  }
  const cmp = formatConfigCell(a[columnKey]).localeCompare(
    formatConfigCell(b[columnKey]),
    undefined,
    { sensitivity: "base", numeric: true },
  );
  return direction === "asc" ? cmp : -cmp;
}

function resolveClientSortColumn(
  columns: string[],
  sortColumn: ClientSortColumn,
): string | null {
  return resolveColumnName(columns, CLIENT_SORT_COLUMN_CANDIDATES[sortColumn]);
}

function RedisDeploymentTags({
  loading,
  deployment,
  connection,
  sshConnections,
}: {
  loading: boolean;
  deployment: RedisDeploymentInfo | null;
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
  const deployReason = deployment?.reason;

  return (
    <>
      <span className={`db-mysql-deploy-tag db-mysql-deploy-tag--${kind}`}>
        {t(`database.connectionInfo.deployment.kind.${kind}`)}
      </span>
      {kind === "host" ? (
        <>
          {serverName || connection.host ? (
            <DbDeploymentNavTag
              label={t("database.connectionInfo.deployment.server")}
              value={serverName || connection.host}
            />
          ) : null}
          {(deployment?.dir?.trim() || locationTag) ? (
            <DbDeploymentNavTag
              label={t("database.connectionInfo.deployment.installDir")}
              value={deployment?.dir?.trim() || locationTag || ""}
            />
          ) : null}
        </>
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
      {kind === "unknown" && deployReason ? (
        <span
          className="db-connection-info-deploy-hint"
          title={deployment?.pidFile?.trim() || undefined}
        >
          {t(`database.redisConnectionInfo.deployment.reason.${deployReason}`, {
            pidFile: deployment?.pidFile?.trim() || "—",
            container: containerName || "—",
            port: String(connection.port),
          })}
        </span>
      ) : null}
    </>
  );
}

export function RedisConnectionInfoPanel({
  connection,
  active = true,
}: RedisConnectionInfoPanelProps) {
  const { t } = useI18n();
  const capable = isRedisConnection(connection);
  const { selectDatabase } = useDbWorkspace();
  const sshConnections = useConnectionStore(
    useShallow((state) => state.connections.filter((conn) => conn.kind === "ssh")),
  );
  const sshSessionActiveMap = useSshConnectionStore((state) => state.sessionActiveMap);
  const cachedDatabases = useDbSchemaCacheStore(
    (s) => s.snapshot.connections?.[connection.id]?.databases,
  );
  const [subTab, setSubTab] = useState<ConnectionInfoSubTab>("overview");
  const [search, setSearch] = useState("");
  /** 首次进入「命令行」后再挂载 REPL，避免打开连接就初始化命令行会话。 */
  const [cliMounted, setCliMounted] = useState(false);
  const [databasesLoading, setDatabasesLoading] = useState(capable);
  const [databasesError, setDatabasesError] = useState<string | null>(null);
  const [databasesList, setDatabasesList] = useState<DbDatabaseMeta[]>(() =>
    (cachedDatabases ?? []).map((db) => ({
      name: db.name,
      charset: null,
      collation: null,
      tableCount: null,
      sizeBytes: null,
      rowsEstimate: typeof db.keyCount === "number" ? db.keyCount : null,
    })),
  );
  const [clientsLoading, setClientsLoading] = useState(false);
  const [configLoading, setConfigLoading] = useState(false);
  const [deploymentLoading, setDeploymentLoading] = useState(false);
  const [deployment, setDeployment] = useState<RedisDeploymentInfo | null>(() =>
    capable ? readRedisDeploymentCache(connection) : null,
  );
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [clientsResult, setClientsResult] = useState<QueryResult | null>(null);
  const [configResult, setConfigResult] = useState<QueryResult | null>(null);
  const [clientSort, setClientSort] = useState<ClientSortState>({
    column: "idle",
    direction: "desc",
  });
  const [configSort, setConfigSort] = useState<ConfigSortState>({
    column: "name",
    direction: "asc",
  });
  const [databaseSort, setDatabaseSort] = useState<DatabaseSortState>({
    column: "name",
    direction: "asc",
  });
  const [selectedDbName, setSelectedDbName] = useState<string | null>(null);
  const [selectedClientRow, setSelectedClientRow] = useState<number | null>(null);
  const [selectedConfigRow, setSelectedConfigRow] = useState<number | null>(null);
  const [configEditValue, setConfigEditValue] = useState("");
  const [overviewInfo, setOverviewInfo] = useState<RedisInfoResult | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const clientsTabEnteredRef = useRef(false);
  const configTabEnteredRef = useRef(false);
  const databasesTabEnteredRef = useRef(false);
  const overviewTabEnteredRef = useRef(false);

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
    openRedisConfig,
  } = useDeploymentConfigEditor(connectionLabel);

  const handleOpenRedisConfig = useCallback(() => {
    void openRedisConfig(connection, deployment);
  }, [connection, deployment, openRedisConfig]);

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
    void viewServiceLog(connection, deployment, "redis");
  }, [connection, deployment, viewServiceLog]);

  const openDatabase = useCallback(
    (dbName: string) => {
      selectDatabase({ connId: connection.id, dbName, connection }, "permanent");
    },
    [connection, selectDatabase],
  );

  const refreshDatabases = useCallback(async (options?: { silent?: boolean }) => {
    if (!capable) {
      return;
    }
    const silent = options?.silent ?? false;
    if (!silent) {
      setDatabasesLoading(true);
    }
    setDatabasesError(null);
    try {
      const result = await listDatabasesWithStats(connection, { quiet: true });
      setDatabasesList(result);
    } catch (e) {
      setDatabasesError(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      if (!silent) {
        setDatabasesLoading(false);
      }
    }
  }, [capable, connection]);

  const refreshClients = useCallback(async (options?: { silent?: boolean }) => {
    if (!capable) {
      return;
    }
    const silent = options?.silent ?? false;
    if (!silent) {
      setClientsLoading(true);
    }
    setClientsError(null);
    try {
      const queryResult = await redisGetClientList(connection);
      setClientsResult({ ...queryResult, rowsAffected: 0 });
    } catch (e) {
      setClientsError(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      if (!silent) {
        setClientsLoading(false);
      }
    }
  }, [capable, connection]);

  const refreshOverview = useCallback(async (options?: { silent?: boolean }) => {
    if (!capable) {
      return;
    }
    const silent = options?.silent ?? false;
    if (!silent) {
      setOverviewLoading(true);
    }
    setOverviewError(null);
    try {
      setOverviewInfo(await redisInfo(connection));
    } catch (e) {
      setOverviewError(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      if (!silent) {
        setOverviewLoading(false);
      }
    }
  }, [capable, connection]);

  const refreshConfig = useCallback(async (options?: { silent?: boolean }) => {
    if (!capable) {
      return;
    }

    const silent = options?.silent ?? false;
    if (!silent) {
      setConfigLoading(true);
    }
    setConfigError(null);
    try {
      const queryResult = await redisGetConfigAll(connection);
      setConfigResult({ ...queryResult, rowsAffected: 0 });
    } catch (e) {
      setConfigError(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      if (!silent) {
        setConfigLoading(false);
      }
    }
  }, [capable, connection]);

  const refreshDeployment = useCallback(async (options?: { force?: boolean }) => {
    if (!capable) {
      setDeployment(null);
      setDeploymentLoading(false);
      return;
    }

    const cached = readRedisDeploymentCache(connection);
    if (!options?.force && isRedisDeploymentCacheUsable(cached)) {
      setDeployment(cached);
      setDeploymentLoading(false);
      return;
    }

    if (!isRedisDeploymentCacheUsable(cached)) {
      setDeploymentLoading(true);
    }
    try {
      const info = await probeRedisDeployment(connection, sshConnections);
      writeRedisDeploymentCache(connection, info);
      setDeployment(info);
    } catch {
      const fallback: RedisDeploymentInfo = { kind: "unknown", reason: "probe_failed" };
      writeRedisDeploymentCache(connection, fallback);
      setDeployment(fallback);
    } finally {
      setDeploymentLoading(false);
    }
  }, [capable, connection, sshConnections]);

  const refreshActiveTab = useCallback(
    async (options?: { silent?: boolean }) => {
      if (subTab === "overview") {
        await refreshOverview(options);
      } else if (subTab === "databases") {
        await refreshDatabases(options);
      } else if (subTab === "connections") {
        await refreshClients(options);
      } else if (subTab === "status") {
        await refreshConfig(options);
      } else if (subTab === "cli") {
        await refreshDeployment({ force: true });
      }
    },
    [
      refreshClients,
      refreshConfig,
      refreshDatabases,
      refreshDeployment,
      refreshOverview,
      subTab,
    ],
  );

  const handleRestartService = useCallback(() => {
    void restartService(deployment, "redis", async () => {
      await refreshDeployment({ force: true });
      await refreshActiveTab();
    });
  }, [deployment, refreshActiveTab, refreshDeployment, restartService]);

  const redisConfigPathHint = useMemo(() => {
    if (!deployment?.dir?.trim()) {
      return undefined;
    }
    return `${deployment.dir.trim().replace(/\/+$/, "")}/redis.conf`;
  }, [deployment?.dir]);

  useEffect(() => {
    setSubTab("overview");
    setSearch("");
    setCliMounted(false);
    setClientSort({ column: "idle", direction: "desc" });
    setConfigSort({ column: "name", direction: "asc" });
    setDatabaseSort({ column: "name", direction: "asc" });
    setSelectedDbName(null);
    setDeployment(readRedisDeploymentCache(connection));
    setDeploymentLoading(false);
    setClientsResult(null);
    setConfigResult(null);
    setClientsError(null);
    setConfigError(null);
    setDatabasesError(null);
    setDatabasesList(
      (useDbSchemaCacheStore.getState().snapshot.connections?.[connection.id]?.databases ?? []).map(
        (db) => ({
          name: db.name,
          charset: null,
          collation: null,
          tableCount: null,
          sizeBytes: null,
          rowsEstimate: typeof db.keyCount === "number" ? db.keyCount : null,
        }),
      ),
    );
    clientsTabEnteredRef.current = false;
    configTabEnteredRef.current = false;
    databasesTabEnteredRef.current = false;
    overviewTabEnteredRef.current = false;
  }, [connection.id, connection.host, connection.port, connection.db_type]);

  useEffect(() => {
    if (subTab === "cli") {
      setCliMounted(true);
    }
  }, [subTab]);

  useEffect(() => {
    if (!active || !capable || subTab !== "overview") {
      overviewTabEnteredRef.current = false;
      return;
    }
    if (overviewTabEnteredRef.current) {
      return;
    }
    overviewTabEnteredRef.current = true;
    void refreshOverview();
  }, [active, capable, refreshOverview, subTab]);

  // 库列表 tab：默认首屏硬加载；再次进入静默刷新
  useEffect(() => {
    if (!active || !capable || subTab !== "databases") {
      databasesTabEnteredRef.current = false;
      return;
    }
    if (databasesTabEnteredRef.current) {
      return;
    }
    databasesTabEnteredRef.current = true;
    if (databasesList.length === 0) {
      void refreshDatabases();
    } else {
      void refreshDatabases({ silent: true });
    }
  }, [active, capable, subTab, databasesList.length, refreshDatabases]);

  // 客户端 tab：首次硬加载；再次进入静默刷新（保留旧数据）
  useEffect(() => {
    if (!active || !capable || subTab !== "connections") {
      clientsTabEnteredRef.current = false;
      return;
    }
    if (clientsTabEnteredRef.current) {
      return;
    }
    clientsTabEnteredRef.current = true;
    if (clientsResult == null) {
      void refreshClients();
    } else {
      void refreshClients({ silent: true });
    }
  }, [active, capable, subTab, clientsResult, clientsLoading, clientsError, refreshClients]);

  // 配置 tab：首次硬加载；再次进入静默刷新
  useEffect(() => {
    if (!active || !capable || subTab !== "status") {
      configTabEnteredRef.current = false;
      return;
    }
    if (configTabEnteredRef.current) {
      return;
    }
    configTabEnteredRef.current = true;
    if (configResult == null) {
      void refreshConfig();
    } else {
      void refreshConfig({ silent: true });
    }
  }, [active, capable, subTab, configResult, configLoading, configError, refreshConfig]);

  useEffect(() => {
    if (!active || !capable) {
      return;
    }
    void refreshDeployment();
  }, [active, capable, connection.id, refreshDeployment]);

  /** SSH 列表或会话就绪后重试（仅 unknown / 缺 SSH 时） */
  useEffect(() => {
    if (!active || !capable || deploymentLoading) {
      return;
    }
    if (isRedisDeploymentCacheUsable(deployment)) {
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
    deploymentLoading,
    deployment,
    connection.host,
    sshConnections,
    sshSessionActiveMap,
    refreshDeployment,
  ]);

  const clientColumns = clientsResult?.columns ?? [];
  const clientRows = useMemo(
    () =>
      clientsResult && clientColumns.length > 0
        ? rowsToRecord(clientColumns, clientsResult.rows)
        : [],
    [clientColumns, clientsResult],
  );

  const configColumns = configResult?.columns ?? [];
  const configRows = useMemo(
    () =>
      configResult && configColumns.length > 0
        ? rowsToRecord(configColumns, configResult.rows)
        : [],
    [configResult, configColumns],
  );
  const parameterColumn = resolveColumnName(configColumns, PARAMETER_COLUMNS);
  const valueColumn = resolveColumnName(configColumns, VALUE_COLUMNS);

  const clientSortColumnKeys = useMemo(
    () =>
      ({
        id: resolveClientSortColumn(clientColumns, "id"),
        addr: resolveClientSortColumn(clientColumns, "addr"),
        idle: resolveClientSortColumn(clientColumns, "idle"),
        cmd: resolveClientSortColumn(clientColumns, "cmd"),
        db: resolveClientSortColumn(clientColumns, "db"),
      }) satisfies Record<ClientSortColumn, string | null>,
    [clientColumns],
  );

  const filteredClientRows = useMemo(() => {
    const query = search.trim();
    if (!query) {
      return clientRows;
    }
    return clientRows.filter((row) => rowMatchesSearch(row, query));
  }, [clientRows, search]);

  const sortedClientRows = useMemo(() => {
    const columnKey = clientSortColumnKeys[clientSort.column];
    if (!columnKey) {
      return filteredClientRows;
    }
    const sorted = [...filteredClientRows];
    sorted.sort((a, b) =>
      compareClientRows(a, b, columnKey, clientSort.column, clientSort.direction),
    );
    return sorted;
  }, [
    clientSort.column,
    clientSort.direction,
    clientSortColumnKeys,
    filteredClientRows,
  ]);

  const filteredConfigRows = useMemo(() => {
    const query = search.trim();
    if (!query) {
      return configRows;
    }
    return configRows.filter((row) => rowMatchesSearch(row, query));
  }, [configRows, search]);

  const sortedConfigRows = useMemo(() => {
    if (!parameterColumn || !valueColumn) {
      return filteredConfigRows;
    }
    const sorted = [...filteredConfigRows];
    sorted.sort((a, b) =>
      compareConfigRows(a, b, parameterColumn, valueColumn, configSort.column, configSort.direction),
    );
    return sorted;
  }, [configSort.column, configSort.direction, filteredConfigRows, parameterColumn, valueColumn]);

  const toggleClientSort = useCallback((column: ClientSortColumn) => {
    setClientSort((prev) => {
      if (prev.column === column) {
        return { column, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { column, direction: column === "idle" ? "desc" : "asc" };
    });
  }, []);

  const toggleConfigSort = useCallback((column: ConfigSortColumn) => {
    setConfigSort((prev) => {
      if (prev.column === column) {
        return { column, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { column, direction: "asc" };
    });
  }, []);

  const toggleDatabaseSort = useCallback((column: DatabaseSortColumn) => {
    setDatabaseSort((prev) => {
      if (prev.column === column) {
        return { column, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { column, direction: "asc" };
    });
  }, []);

  const filteredDatabases = useMemo(() => {
    const query = search.trim();
    if (!query) {
      return databasesList;
    }
    return databasesList.filter((db) => {
      const label = formatRedisDbLabel(db.name);
      return textSearchMatches(query, label) || textSearchMatches(query, db.name);
    });
  }, [databasesList, search]);

  const sortedDatabases = useMemo(() => {
    const sorted = [...filteredDatabases];
    sorted.sort((a, b) => {
      if (databaseSort.column === "keys") {
        const aVal = a.rowsEstimate ?? -1;
        const bVal = b.rowsEstimate ?? -1;
        const cmp = aVal - bVal;
        return databaseSort.direction === "asc" ? cmp : -cmp;
      }
      const aName = Number.isFinite(Number(a.name)) ? Number(a.name) : a.name;
      const bName = Number.isFinite(Number(b.name)) ? Number(b.name) : b.name;
      let cmp = 0;
      if (typeof aName === "number" && typeof bName === "number") {
        cmp = aName - bName;
      } else {
        cmp = String(aName).localeCompare(String(bName), undefined, {
          numeric: true,
          sensitivity: "base",
        });
      }
      return databaseSort.direction === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [databaseSort.column, databaseSort.direction, filteredDatabases]);

  const databaseGridColumns = useMemo((): DbTablesPanelGridColumn<DbDatabaseMeta>[] => {
    return [
      {
        id: "name",
        header: t("database.connectionInfo.databases.colName"),
        sortable: true,
        sortId: "name",
        nameCell: true,
        defaultWidth: 160,
        minWidth: 100,
        render: (db) => formatRedisDbLabel(db.name),
        getTitle: (db) => formatRedisDbLabel(db.name),
        getCopyValue: (db) => db.name,
      },
      {
        id: "keys",
        header: t("database.redisConnectionInfo.colKeys"),
        sortable: true,
        sortId: "keys",
        defaultWidth: 96,
        minWidth: 64,
        render: (db) =>
          db.rowsEstimate != null ? db.rowsEstimate.toLocaleString() : "—",
        getTitle: (db) =>
          db.rowsEstimate != null ? String(db.rowsEstimate) : "",
        getCopyValue: (db) =>
          db.rowsEstimate != null ? String(db.rowsEstimate) : "",
      },
    ];
  }, [t]);

  const clientGridColumns = useMemo((): DbTablesPanelGridColumn<Record<string, unknown>>[] => {
    return clientColumns.map((column, index) => {
      const sortColumn = (Object.keys(CLIENT_SORT_COLUMN_CANDIDATES) as ClientSortColumn[]).find(
        (candidate) => clientSortColumnKeys[candidate] === column,
      );
      return {
        id: column,
        sortId: sortColumn ?? undefined,
        header: column,
        sortable: sortColumn != null,
        nameCell: index === 0,
        render: (row: Record<string, unknown>) => formatConfigCell(row[column]),
        getTitle: (row: Record<string, unknown>) => formatConfigCell(row[column]),
        getCopyValue: (row: Record<string, unknown>) => formatConfigCell(row[column]),
      };
    });
  }, [clientColumns, clientSortColumnKeys]);

  const configGridColumns = useMemo((): DbTablesPanelGridColumn<Record<string, unknown>>[] => {
    return configColumns.map((column, index) => {
      const isNameColumn = parameterColumn === column;
      const isValueColumn = valueColumn === column;
      const sortColumn: ConfigSortColumn | null = isNameColumn
        ? "name"
        : isValueColumn
          ? "value"
          : null;
      return {
        id: column,
        sortId: sortColumn ?? undefined,
        header: column,
        sortable: sortColumn != null,
        nameCell: index === 0,
        render: (row: Record<string, unknown>) => formatConfigCell(row[column]),
        getTitle: (row: Record<string, unknown>) => formatConfigCell(row[column]),
        getCopyValue: (row: Record<string, unknown>) => formatConfigCell(row[column]),
      };
    });
  }, [configColumns, parameterColumn, valueColumn]);

  const renderDatabasesTable = () => {
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
      <>
        <div className="redis-conn-toolbar">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void redisFlushDb(connection).then(() => refreshDatabases());
            }}
          >
            FLUSHDB
          </Button>
        </div>
        <DbTablesPanelGrid
          variant="processlist"
          className="db-tables-panel-grid--fit"
          columns={databaseGridColumns}
          rows={sortedDatabases}
          rowKey={(db) => db.name}
          sortColumnId={databaseSort.column}
          sortDirection={databaseSort.direction}
          onSortColumn={(columnId) => toggleDatabaseSort(columnId as DatabaseSortColumn)}
          selectedRowKey={selectedDbName}
          onRowClick={(db) => setSelectedDbName(db.name)}
          onRowDoubleClick={(db) => openDatabase(db.name)}
          onActivateSelectedRows={() => {
            if (selectedDbName) {
              openDatabase(selectedDbName);
            }
          }}
        />
      </>
    );
  };

  const selectedClientAddr = useMemo(() => {
    if (selectedClientRow == null || selectedClientRow < 0) {
      return null;
    }
    const row = sortedClientRows[selectedClientRow];
    if (!row) {
      return null;
    }
    const addrKey = clientColumns.find((c) => c.toLowerCase() === "addr") ?? "addr";
    const addr = row[addrKey];
    return typeof addr === "string" && addr.includes(":") ? addr : null;
  }, [clientColumns, selectedClientRow, sortedClientRows]);

  const selectedConfigParameter = useMemo(() => {
    if (selectedConfigRow == null || !parameterColumn) {
      return null;
    }
    const row = sortedConfigRows[selectedConfigRow];
    if (!row) {
      return null;
    }
    const value = row[parameterColumn];
    return typeof value === "string" ? value : String(value ?? "");
  }, [parameterColumn, selectedConfigRow, sortedConfigRows]);

  const renderClientsTable = () => {
    if (clientsLoading && clientsResult == null) {
      return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
    }
    if (clientsError && clientsResult == null) {
      return <div className="db-tables-panel-error">{clientsError}</div>;
    }
    if (clientColumns.length === 0 || clientRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("database.connectionInfo.empty")}</div>;
    }
    if (sortedClientRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("database.connectionInfo.noResults")}</div>;
    }

    return (
      <>
        <div className="redis-conn-toolbar">
          <Button
            variant="ghost"
            size="sm"
            disabled={!selectedClientAddr}
            onClick={() => {
              if (!selectedClientAddr) return;
              void redisClientKill(connection, selectedClientAddr).then(() => refreshClients());
            }}
          >
            {t("database.redisOps.killClient")}
          </Button>
        </div>
        <DbTablesPanelGrid
          variant="variables"
          columns={clientGridColumns}
          rows={sortedClientRows}
          rowKey={(_row, rowIndex) => rowIndex}
          sortColumnId={clientSort.column}
          sortDirection={clientSort.direction}
          onSortColumn={(columnId) => toggleClientSort(columnId as ClientSortColumn)}
          columnResizeStorageKey={`db-redis-clients:${connection.id}`}
          selectedRowKey={selectedClientRow ?? undefined}
          onRowClick={(row) => {
            const idx = sortedClientRows.indexOf(row);
            setSelectedClientRow(idx >= 0 ? idx : null);
          }}
        />
      </>
    );
  };

  const renderConfigTable = () => {
    if (configLoading && configResult == null) {
      return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
    }
    if (configError && configResult == null) {
      return <div className="db-tables-panel-error">{configError}</div>;
    }
    if (configColumns.length === 0 || configRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("database.redisConnectionInfo.empty")}</div>;
    }
    if (sortedConfigRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("database.redisConnectionInfo.noResults")}</div>;
    }

    return (
      <>
        <div className="redis-conn-toolbar">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void redisConfigRewrite(connection)}
          >
            CONFIG REWRITE
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!selectedConfigParameter}
            onClick={() => {
              if (!selectedConfigParameter) {
                return;
              }
              void redisConfigSet(connection, selectedConfigParameter, configEditValue).then(
                () => refreshConfig({ silent: true }),
              );
            }}
          >
            {t("database.redisOps.configSave")}
          </Button>
          {selectedConfigParameter ? (
            <TextInput
              className="redis-conn-config-input"
              value={configEditValue}
              onChange={setConfigEditValue}
              placeholder={selectedConfigParameter}
            />
          ) : null}
        </div>
        <DbTablesPanelGrid
          variant="variables"
          columns={configGridColumns}
          rows={sortedConfigRows}
          rowKey={(_row, rowIndex) => rowIndex}
          sortColumnId={configSort.column}
          sortDirection={configSort.direction}
          onSortColumn={(columnId) => toggleConfigSort(columnId as ConfigSortColumn)}
          selectedRowKey={selectedConfigRow ?? undefined}
          onRowClick={(row) => {
            const idx = sortedConfigRows.indexOf(row);
            setSelectedConfigRow(idx >= 0 ? idx : null);
            if (valueColumn) {
              setConfigEditValue(formatConfigCell(row[valueColumn]));
            }
          }}
        />
      </>
    );
  };

  const cliSections = useMemo(
    () => buildRedisCliSections(t, connection, deployment, sshConnections),
    [connection, deployment, sshConnections, t],
  );

  const tabLoading =
    subTab === "overview"
      ? overviewLoading
      : subTab === "databases"
        ? databasesLoading
        : subTab === "connections"
          ? clientsLoading
          : subTab === "status"
            ? configLoading
            : deploymentLoading;

  const tabCount =
    subTab === "databases"
      ? sortedDatabases.length
      : subTab === "connections"
        ? sortedClientRows.length
        : subTab === "status"
          ? sortedConfigRows.length
          : subTab === "cli"
            ? cliSections.length
            : 0;

  const renderCliSession = () => (
    <ConnectionCliTabPanel
      connection={connection}
      client="redis"
      deployment={deployment}
      deploymentLoading={deploymentLoading}
      sshConnections={sshConnections}
      panelActive={active}
      visible={subTab === "cli"}
    />
  );

  const renderPanelMainContent = () => (
    <>
      {capable && cliMounted ? renderCliSession() : null}
      {subTab === "overview" ? (
        <RedisOverviewCards
          connection={connection}
          info={overviewInfo}
          loading={overviewLoading}
          error={overviewError}
          onRefresh={() => void refreshOverview()}
        />
      ) : subTab === "databases" ? (
        renderDatabasesTable()
      ) : subTab === "connections" ? (
        renderClientsTable()
      ) : subTab === "memory" ? (
        <RedisMemoryPanel connection={connection} active={active && subTab === "memory"} />
      ) : subTab === "replication" ? (
        <RedisReplicationPanel connection={connection} active={active && subTab === "replication"} />
      ) : subTab === "status" ? (
        renderConfigTable()
      ) : subTab === "slowlog" ? (
        <RedisConnectionSlowlogPanel connection={connection} active={active && subTab === "slowlog"} />
      ) : subTab === "acl" ? (
        <RedisAclPanel connection={connection} active={active && subTab === "acl"} />
      ) : null}
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
          : subTab === "connections"
            ? t("database.redisConnectionInfo.clientsSearch")
            : subTab === "status"
              ? t("database.redisConnectionInfo.configSearch")
              : ""
      }
      enabled={capable && !["cli", "overview", "memory", "replication", "slowlog", "acl"].includes(subTab)}
    >
      {capable ? (
        <div className="db-tables-panel-header db-connection-info-header">
          <span className="db-tables-panel-header-label">
            {t("database.connectionInfo.headerLabel")}
          </span>
          <div className="db-tables-panel-header-tags">
            <span
              className="db-tables-panel-header-tag db-tables-panel-header-tag--name"
              title={connectionLabel}
            >
              {connectionLabel}
            </span>
            <span className="db-tables-panel-header-tag" title={connection.db_type}>
              {connection.db_type}
            </span>
            <span
              className="db-tables-panel-header-tag"
              title={t("database.tablesPanel.headerHost")}
            >
              {`${connection.host?.trim() || "—"}:${connection.port}`}
            </span>
            <div className="db-connection-info-deploy-tags">
              <RedisDeploymentTags
                loading={deploymentLoading}
                deployment={deployment}
                connection={connection}
                sshConnections={sshConnections}
              />
            </div>
          </div>
          <div className="db-tables-panel-header-actions">
            {deployment?.kind === "host" || deployment?.kind === "docker" ? (
              <DeploymentServiceActionButtons
                canManage={canManageDeployedService(deployment)}
                logBusy={serviceLogBusy}
                restartBusy={serviceRestartBusy}
                configBusy={configOpening}
                onViewLog={handleViewServiceLog}
                onRestart={handleRestartService}
                onOpenConfig={handleOpenRedisConfig}
                configPath={redisConfigPathHint}
              />
            ) : null}
          </div>
        </div>
      ) : null}
      {capable ? (
        <div className="db-connection-info-tabs" role="tablist">
          {(
            [
              ["overview", t("database.redisOps.tabs.overview")],
              ["databases", t("database.connectionInfo.tabs.databases")],
              ["connections", t("database.connectionInfo.tabs.connections")],
              ["memory", t("database.redisOps.tabs.memory")],
              ["replication", t("database.redisOps.tabs.replication")],
              ["status", t("database.connectionInfo.tabs.status")],
              ["slowlog", t("database.redisOps.tabs.slowlog")],
              ["acl", t("database.redisOps.tabs.acl")],
              ["cli", t("database.connectionInfo.tabs.cli")],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              className={`db-toolbox-tab${subTab === id ? " active" : ""}`}
              aria-selected={subTab === id}
              onClick={() => {
                setSubTab(id);
                setSearch("");
              }}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      <div
        className="db-tables-panel-body"
        role="tabpanel"
        aria-label={
          subTab === "databases"
            ? t("database.connectionInfo.tabs.databases")
            : subTab === "connections"
              ? t("database.connectionInfo.tabs.connections")
              : subTab === "status"
                ? t("database.connectionInfo.tabs.status")
                : t("database.connectionInfo.tabs.cli")
        }
      >
        <div
          className={`db-tables-panel-grid-wrap${subTab === "cli" ? " db-tables-panel-grid-wrap--cli" : ""}`}
        >
          {content}
        </div>
      </div>
      <div className="db-tables-panel-meta">
        <DbPanelMetaRefreshButton
          onClick={() => {
            void refreshActiveTab();
            void refreshDeployment({ force: true });
          }}
          disabled={tabLoading || deploymentLoading || !capable}
        />
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
            {t("database.redisConnectionInfo.unsupportedEngine", { engine: connection.db_type })}
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
    </>
  );
}
