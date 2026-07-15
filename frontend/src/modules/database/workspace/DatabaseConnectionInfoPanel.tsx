import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
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
import type { Connection } from "../../../ipc/bindings";
import { isMysqlConnectionInfoCapable, type DbConnectionConfig } from "../api";
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
import { DbTablesPanelGrid, type DbTablesPanelGridColumn } from "./DbTablesPanelGrid";
import { rowsToRecord, type QueryResult } from "./dbWorkspaceState";
import { DbDeploymentNavTag } from "./DbDeploymentNavTag";
import { DeploymentConfigEditorSubWindow } from "./DeploymentConfigEditorSubWindow";
import { DeploymentServiceActionButtons } from "./DeploymentServiceActionButtons";
import { DeploymentServiceLogSubWindow } from "./DeploymentServiceLogSubWindow";
import { DbPanelMetaRefreshButton } from "./DbPanelMetaRefreshButton";
import { useDeploymentConfigEditor } from "./useDeploymentConfigEditor";
import { useDeploymentServiceActions } from "./useDeploymentServiceActions";

import { buildMysqlCliSections } from "./connectionCliCommands";
import { ConnectionCliTabPanel } from "./ConnectionCliTabPanel";
import { ConnectionExportTabPanel } from "./ConnectionExportTabPanel";
import { useDbConnectionInfoNavStore } from "../stores/dbConnectionInfoNavStore";

const PROCESSLIST_SQL = "SHOW FULL PROCESSLIST;";
const VARIABLES_SQL = "SHOW VARIABLES;";

type ConnectionInfoSubTab = "connections" | "status" | "cli" | "exports";

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

const VARIABLE_NAME_COLUMNS = ["Variable_name", "variable_name"];
const VARIABLE_VALUE_COLUMNS = ["Value", "value"];

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
  const capable = isMysqlConnectionInfoCapable(connection);
  const sshConnections = useConnectionStore(
    useShallow((state) => state.connections.filter((conn) => conn.kind === "ssh")),
  );
  const sshSessionActiveMap = useSshConnectionStore((state) => state.sessionActiveMap);
  const [subTab, setSubTab] = useState<ConnectionInfoSubTab>("connections");
  const [search, setSearch] = useState("");
  const [connectionsLoading, setConnectionsLoading] = useState(capable);
  const [variablesLoading, setVariablesLoading] = useState(false);
  const [deploymentLoading, setDeploymentLoading] = useState(false);
  const [deployment, setDeployment] = useState<MysqlDeploymentInfo | null>(() =>
    capable ? readMysqlDeploymentCache(connection) : null,
  );
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [variablesError, setVariablesError] = useState<string | null>(null);
  const [connectionsResult, setConnectionsResult] = useState<QueryResult | null>(null);
  const [variablesResult, setVariablesResult] = useState<QueryResult | null>(null);
  const [processSort, setProcessSort] = useState<ProcessSortState>({
    column: "time",
    direction: "desc",
  });
  const [variablesSort, setVariablesSort] = useState<VariablesSortState>({
    column: "name",
    direction: "asc",
  });
  const [killingId, setKillingId] = useState<number | null>(null);
  const [exportsCount, setExportsCount] = useState(0);
  const [exportsRefreshToken, setExportsRefreshToken] = useState(0);
  const consumeSubTab = useDbConnectionInfoNavStore((state) => state.consumeSubTab);

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

  const refreshConnections = useCallback(async (options?: { silent?: boolean }) => {
    if (!capable) {
      return;
    }

    const silent = options?.silent ?? false;
    if (!silent) {
      setConnectionsLoading(true);
      setConnectionsResult(null);
    }
    setConnectionsError(null);
    try {
      const queryResult = await invoke<QueryResult>("db_execute_query", {
        connection,
        sql: PROCESSLIST_SQL,
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
  }, [capable, connection]);

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
        sql: VARIABLES_SQL,
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
  }, [capable, connection]);

  const refreshDeployment = useCallback(async (options?: { force?: boolean }) => {
    if (!capable) {
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
  }, [capable, connection, sshConnections]);

  const refreshActiveTab = useCallback(
    async (options?: { silent?: boolean }) => {
      if (subTab === "connections") {
        await refreshConnections(options);
      } else if (subTab === "status") {
        await refreshVariables(options);
      } else if (subTab === "exports") {
        setExportsRefreshToken((value) => value + 1);
      } else {
        await refreshDeployment({ force: true });
      }
    },
    [refreshConnections, refreshDeployment, refreshVariables, subTab],
  );

  const handleRestartService = useCallback(() => {
    void restartService(deployment, "mysql", async () => {
      await refreshDeployment({ force: true });
      await refreshActiveTab();
    });
  }, [deployment, refreshActiveTab, refreshDeployment, restartService]);

  useEffect(() => {
    setSubTab("connections");
    setSearch("");
    setProcessSort({ column: "time", direction: "desc" });
    setVariablesSort({ column: "name", direction: "asc" });
    setDeployment(readMysqlDeploymentCache(connection));
    setDeploymentLoading(false);
    setConnectionsResult(null);
    setVariablesResult(null);
    setConnectionsError(null);
    setVariablesError(null);
    setExportsCount(0);
  }, [connection.id, connection.host, connection.port, connection.db_type]);

  useEffect(() => {
    const requested = consumeSubTab(connection.id);
    if (requested) {
      setSubTab(requested);
      setSearch("");
    }
  }, [connection.id, consumeSubTab, active]);

  useEffect(() => {
    if (!active || !capable) {
      return;
    }
    void refreshConnections();
    // 有有效部署缓存则直接展示，不再每次进 Tab 重查
    void refreshDeployment();
  }, [active, capable, connection.id, refreshConnections, refreshDeployment]);

  /** SSH 列表或会话就绪后重试（仅 unknown / 缺 SSH 时） */
  useEffect(() => {
    if (!active || !capable || deploymentLoading) {
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
    subTab === "connections"
      ? connectionsLoading
      : subTab === "status"
        ? variablesLoading
        : subTab === "exports"
          ? false
          : deploymentLoading;

  const tabCount =
    subTab === "connections"
      ? sortedProcessRows.length
      : subTab === "status"
        ? sortedVariableRows.length
        : subTab === "exports"
          ? exportsCount
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
    if (connectionsLoading) {
      return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
    }
    if (connectionsError) {
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
      client="mysql"
      deployment={deployment}
      deploymentLoading={deploymentLoading}
      sshConnections={sshConnections}
      panelActive={active}
      visible={subTab === "cli"}
    />
  );

  const renderExportsTable = () => (
    <ConnectionExportTabPanel
      connection={connection}
      active={active && subTab === "exports"}
      refreshToken={exportsRefreshToken}
      onRecordsChange={setExportsCount}
    />
  );

  const renderPanelMainContent = () => (
    <>
      {capable && active ? renderCliSession() : null}
      {subTab === "connections"
        ? renderConnectionsTable()
        : subTab === "status"
          ? renderVariablesTable()
          : subTab === "exports"
            ? renderExportsTable()
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
          ? t("database.connectionInfo.search")
          : subTab === "status"
            ? t("database.connectionInfo.variablesSearch")
            : ""
      }
      enabled={capable && subTab !== "cli" && subTab !== "exports"}
    >
      {capable ? (
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
          <button
            type="button"
            role="tab"
            className={`db-toolbox-tab${subTab === "exports" ? " active" : ""}`}
            aria-selected={subTab === "exports"}
            onClick={() => {
              setSubTab("exports");
              setSearch("");
            }}
          >
            {t("database.connectionInfo.tabs.exports")}
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
              : subTab === "exports"
                ? t("database.connectionInfo.tabs.exports")
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
              : subTab === "exports"
                ? t("database.connectionInfo.exports.count", { count: tabCount })
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
    </>
  );
}
