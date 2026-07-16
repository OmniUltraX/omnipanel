import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useI18n } from "../../../i18n";
import { textSearchMatches } from "../../../lib/textSearchMatch";
import { ScopedSearch } from "../../../components/ui/search/ScopedSearch";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useSshConnectionStore } from "../../../stores/sshConnectionStore";
import type { Connection } from "../../../ipc/bindings";
import { isRedisConnection, redisGetClientList, redisGetConfigAll, type DbConnectionConfig } from "../api";
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

type ConnectionInfoSubTab = "connections" | "status" | "cli";

type ConfigSortColumn = "name" | "value";
type ConfigSortDirection = "asc" | "desc";

type ClientSortColumn = "id" | "addr" | "idle" | "cmd" | "db";
type ClientSortDirection = "asc" | "desc";

interface ConfigSortState {
  column: ConfigSortColumn;
  direction: ConfigSortDirection;
}

interface ClientSortState {
  column: ClientSortColumn;
  direction: ClientSortDirection;
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
  const sshConnections = useConnectionStore(
    useShallow((state) => state.connections.filter((conn) => conn.kind === "ssh")),
  );
  const sshSessionActiveMap = useSshConnectionStore((state) => state.sessionActiveMap);
  const [subTab, setSubTab] = useState<ConnectionInfoSubTab>("connections");
  const [search, setSearch] = useState("");
  const [clientsLoading, setClientsLoading] = useState(capable);
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
  const clientsTabEnteredRef = useRef(false);
  const configTabEnteredRef = useRef(false);

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
      if (subTab === "connections") {
        await refreshClients(options);
      } else if (subTab === "status") {
        await refreshConfig(options);
      } else {
        await refreshDeployment({ force: true });
      }
    },
    [refreshClients, refreshConfig, refreshDeployment, subTab],
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
    setSubTab("connections");
    setSearch("");
    setClientSort({ column: "idle", direction: "desc" });
    setConfigSort({ column: "name", direction: "asc" });
    setDeployment(readRedisDeploymentCache(connection));
    setDeploymentLoading(false);
    setClientsResult(null);
    setConfigResult(null);
    setClientsError(null);
    setConfigError(null);
    clientsTabEnteredRef.current = false;
    configTabEnteredRef.current = false;
  }, [connection.id, connection.host, connection.port, connection.db_type]);

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
    () => (clientsResult ? rowsToRecord(clientColumns, clientsResult.rows) : []),
    [clientColumns, clientsResult],
  );

  const configRows = useMemo(
    () => (configResult ? rowsToRecord(configResult.columns, configResult.rows) : []),
    [configResult],
  );

  const configColumns = configResult?.columns ?? [];
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
      <DbTablesPanelGrid
        variant="variables"
        columns={clientGridColumns}
        rows={sortedClientRows}
        rowKey={(_row, rowIndex) => rowIndex}
        sortColumnId={clientSort.column}
        sortDirection={clientSort.direction}
        onSortColumn={(columnId) => toggleClientSort(columnId as ClientSortColumn)}
      />
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
      <DbTablesPanelGrid
        variant="variables"
        columns={configGridColumns}
        rows={sortedConfigRows}
        rowKey={(_row, rowIndex) => rowIndex}
        sortColumnId={configSort.column}
        sortDirection={configSort.direction}
        onSortColumn={(columnId) => toggleConfigSort(columnId as ConfigSortColumn)}
      />
    );
  };

  const cliSections = useMemo(
    () => buildRedisCliSections(t, connection, deployment, sshConnections),
    [connection, deployment, sshConnections, t],
  );

  const tabLoading =
    subTab === "connections"
      ? clientsLoading
      : subTab === "status"
        ? configLoading
        : deploymentLoading;

  const tabCount =
    subTab === "connections"
      ? sortedClientRows.length
      : subTab === "status"
        ? sortedConfigRows.length
        : cliSections.length;

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
      {capable && active ? renderCliSession() : null}
      {subTab === "connections"
        ? renderClientsTable()
        : subTab === "status"
          ? renderConfigTable()
          : null}
    </>
  );

  const panelBody = (content: ReactNode) => (
    <ScopedSearch
      className="db-tables-panel db-tables-panel--dock"
      value={search}
      onChange={setSearch}
      placeholder={
        subTab === "connections"
          ? t("database.redisConnectionInfo.clientsSearch")
          : subTab === "status"
            ? t("database.redisConnectionInfo.configSearch")
            : ""
      }
      enabled={capable && subTab !== "cli"}
    >
      {capable ? (
        <div className="db-connection-info-deploy">
          <span className="db-connection-info-deploy-label">
            {t("database.connectionInfo.deployment.label")}
          </span>
          <div className="db-connection-info-deploy-tags">
            <RedisDeploymentTags
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
              onOpenConfig={handleOpenRedisConfig}
              configPath={redisConfigPathHint}
            />
          ) : null}
        </div>
      ) : null}
      {capable ? (
        <div className="db-connection-info-tabs" role="tablist">
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
          subTab === "connections"
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
