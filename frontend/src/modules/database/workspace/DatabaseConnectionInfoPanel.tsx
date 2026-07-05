import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useShallow } from "zustand/react/shallow";
import { useI18n } from "../../../i18n";
import { appConfirm } from "../../../lib/appConfirm";
import { appAlert } from "../../../lib/appAlert";
import { textSearchMatches } from "../../../lib/textSearchMatch";
import { Button } from "../../../components/ui/Button";
import { ScopedSearch } from "../../../components/ui/ScopedSearch";
import { TextEditorSubWindow } from "../../../components/textEditor";
import {
  createMysqlConfigTextIO,
  findMysqlConfigPath,
} from "../../../components/textEditor/io/mysqlConfigIO";
import type { TextEditorIO } from "../../../components/textEditor/types";
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
  readMysqlDeploymentCache,
  writeMysqlDeploymentCache,
} from "../mysqlDeploymentCache";
import { makeQueryRunId } from "../sql/queryRun";
import { displayDetailValue } from "./databaseTablesPanelFormat";
import { DbTablesPanelGrid, type DbTablesPanelGridColumn } from "./DbTablesPanelGrid";
import { rowsToRecord, type QueryResult } from "./dbWorkspaceState";

const PROCESSLIST_SQL = "SHOW FULL PROCESSLIST;";
const VARIABLES_SQL = "SHOW VARIABLES;";

type ConnectionInfoSubTab = "connections" | "status";

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

function DeploymentNavTag({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <button
      type="button"
      className="db-mysql-deploy-tag db-mysql-deploy-tag--nav"
      title={`${label}: ${value}`}
      disabled
    >
      {value}
    </button>
  );
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
        <DeploymentNavTag
          label={t("database.connectionInfo.deployment.hostLocation")}
          value={locationTag}
        />
      ) : null}
      {kind === "docker" ? (
        <>
          {serverName ? (
            <DeploymentNavTag
              label={t("database.connectionInfo.deployment.server")}
              value={serverName}
            />
          ) : null}
          {containerName ? (
            <DeploymentNavTag
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
  useSshConnectionStore((state) => state.sessionActiveMap);
  const [subTab, setSubTab] = useState<ConnectionInfoSubTab>("connections");
  const [search, setSearch] = useState("");
  const [connectionsLoading, setConnectionsLoading] = useState(capable);
  const [variablesLoading, setVariablesLoading] = useState(false);
  const initialDeployment = capable ? readMysqlDeploymentCache(connection) : null;
  const [deploymentLoading, setDeploymentLoading] = useState(
    () => capable && initialDeployment == null,
  );
  const [deployment, setDeployment] = useState<MysqlDeploymentInfo | null>(
    () => initialDeployment,
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
  const [editingVarName, setEditingVarName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [savingVarName, setSavingVarName] = useState<string | null>(null);
  const [configEditor, setConfigEditor] = useState<{
    path: string;
    io: TextEditorIO;
  } | null>(null);

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

  const refreshDeployment = useCallback(
    async (options?: { silent?: boolean }): Promise<MysqlDeploymentInfo | null> => {
      if (!capable) {
        setDeployment(null);
        setDeploymentLoading(false);
        return null;
      }

      if (!options?.silent) {
        setDeploymentLoading(true);
      }
      try {
        const info = await probeMysqlDeployment(connection, sshConnections);
        writeMysqlDeploymentCache(connection, info);
        setDeployment(info);
        return info;
      } catch {
        const fallback: MysqlDeploymentInfo = { kind: "unknown", reason: "probe_failed" };
        writeMysqlDeploymentCache(connection, fallback);
        setDeployment(fallback);
        return fallback;
      } finally {
        if (!options?.silent) {
          setDeploymentLoading(false);
        }
      }
    },
    [capable, connection, sshConnections],
  );

  const refreshActiveTab = useCallback(
    async (options?: { silent?: boolean }) => {
      if (subTab === "connections") {
        await refreshConnections(options);
      } else {
        await refreshVariables(options);
      }
    },
    [refreshConnections, refreshVariables, subTab],
  );

  useEffect(() => {
    setSubTab("connections");
    setSearch("");
    setProcessSort({ column: "time", direction: "desc" });
    setVariablesSort({ column: "name", direction: "asc" });
    const cached = readMysqlDeploymentCache(connection);
    setDeployment(cached);
    setDeploymentLoading(cached == null && isMysqlConnectionInfoCapable(connection));
    setConnectionsResult(null);
    setVariablesResult(null);
    setConnectionsError(null);
    setVariablesError(null);
  }, [connection.id, connection.host, connection.port, connection.db_type]);

  useEffect(() => {
    if (!active || !capable) {
      return;
    }
    void refreshConnections();
  }, [active, capable, connection.id, refreshConnections]);

  useEffect(() => {
    if (!active || !capable) {
      return;
    }
    const cached = readMysqlDeploymentCache(connection);
    void refreshDeployment({ silent: cached != null });
  }, [active, capable, connection.id, connection.host, connection.port, refreshDeployment]);

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

  const tabLoading = subTab === "connections" ? connectionsLoading : variablesLoading;
  const tabCount =
    subTab === "connections" ? sortedProcessRows.length : sortedVariableRows.length;

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

  const handleVariableSave = useCallback(
    async (varName: string, value: string, scope: "SESSION" | "GLOBAL") => {
      if (savingVarName !== null) {
        return;
      }
      setSavingVarName(varName);
      try {
        const safeValue = value.replace(/'/g, "\\'");
        await invoke<QueryResult>("db_execute_query", {
          connection,
          sql: `SET ${scope} \`${varName}\` = '${safeValue}'`,
          runId: makeQueryRunId(),
        });
        await refreshVariables({ silent: true });
        setEditingVarName(null);
      } catch (e) {
        const message = typeof e === "string" ? e : JSON.stringify(e);
        void appAlert(
          message,
          t("database.connectionInfo.variablesSaveFailed"),
        );
      } finally {
        setSavingVarName(null);
      }
    },
    [connection, refreshVariables, savingVarName, t],
  );

  const handleOpenConfig = useCallback(async () => {
    try {
      let activeDeployment = deployment;
      const needsRefresh =
        !activeDeployment ||
        (activeDeployment.kind === "docker" && !activeDeployment.containerId) ||
        (activeDeployment.kind === "unknown" &&
          activeDeployment.reason !== "no_ssh" &&
          !activeDeployment.sshConnectionId);
      if (needsRefresh) {
        activeDeployment = await refreshDeployment();
      }
      if (!activeDeployment) {
        return;
      }

      const host = connection.host.trim().toLowerCase();
      const isLocalHost =
        host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (
        !activeDeployment.sshConnectionId &&
        activeDeployment.reason === "no_ssh" &&
        !isLocalHost
      ) {
        void appAlert(t("database.connectionInfo.configEditor.noSsh"));
        return;
      }

      const path = await findMysqlConfigPath(activeDeployment);
      if (!path) {
        void appAlert(t("database.connectionInfo.configEditor.notFound"));
        return;
      }
      setConfigEditor({
        path,
        io: createMysqlConfigTextIO(path, activeDeployment),
      });
    } catch (e) {
      const message = typeof e === "string" ? e : JSON.stringify(e);
      void appAlert(message, t("database.connectionInfo.configEditor.saveFailed"));
    }
  }, [connection, deployment, refreshDeployment, t]);

  const handleCloseConfig = useCallback(() => {
    setConfigEditor(null);
  }, []);

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
              onClick={(event) => {
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
    const dataColumns = variablesColumns.map((column, index) => {
      const sortColumn = resolveVariablesSortColumn(
        column,
        variableNameColumn,
        variableValueColumn,
      );
      const isValueColumn = !!variableValueColumn && column === variableValueColumn;
      return {
        id: column,
        sortId: sortColumn ?? undefined,
        header: column,
        sortable: sortColumn != null,
        nameCell: index === 0,
        render: (row: Record<string, unknown>) => {
          if (!isValueColumn || !variableNameColumn) {
            return formatProcessCell(row[column]);
          }
          const varName = String(row[variableNameColumn] ?? "");
          if (editingVarName === varName) {
            return (
              <input
                type="text"
                className="db-variables-edit-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setEditingVarName(null);
                  }
                }}
                onBlur={(e) => {
                  if (!e.relatedTarget?.closest(".db-variables-actions")) {
                    setEditingVarName(null);
                  }
                }}
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            );
          }
          return (
            <span
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditingVarName(varName);
                setEditValue(String(row[variableValueColumn] ?? ""));
              }}
            >
              {formatProcessCell(row[column])}
            </span>
          );
        },
        getTitle: (row: Record<string, unknown>) => formatProcessCell(row[column]),
        getCopyValue: isValueColumn
          ? (row: Record<string, unknown>) => {
              if (!variableValueColumn) return undefined;
              return String(row[variableValueColumn] ?? "");
            }
          : (row: Record<string, unknown>) => formatProcessCell(row[column]),
      };
    });

    return [
      ...dataColumns,
      {
        id: "__variables_actions",
        variant: "actionsSticky" as const,
        header: t("database.connectionInfo.variablesActions"),
        headerAriaLabel: t("database.connectionInfo.variablesActions"),
        cellClassName: "db-variables-actions-col",
        render: (row: Record<string, unknown>) => {
          const varName = String(variableNameColumn ? row[variableNameColumn] ?? "" : "");
          const isEditing = variableNameColumn && editingVarName === varName;
          const isSaving = savingVarName === varName;
          return (
            <div className="db-variables-actions">
              <Button
                variant="secondary"
                size="xs"
                disabled={!isEditing || isSaving}
                onClick={(event) => {
                  event.stopPropagation();
                  if (isEditing) {
                    void handleVariableSave(varName, editValue, "SESSION");
                  }
                }}
              >
                {t("database.connectionInfo.variablesSessionSave")}
              </Button>
              <Button
                variant="secondary"
                size="xs"
                disabled={!isEditing || isSaving}
                onClick={(event) => {
                  event.stopPropagation();
                  if (isEditing) {
                    void handleVariableSave(varName, editValue, "GLOBAL");
                  }
                }}
              >
                {t("database.connectionInfo.variablesGlobalSave")}
              </Button>
            </div>
          );
        },
      },
    ];
  }, [
    editingVarName,
    editValue,
    handleVariableSave,
    savingVarName,
    variableNameColumn,
    variableValueColumn,
    variablesColumns,
    t,
  ]);

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

  const panelBody = (content: ReactNode) => (
    <ScopedSearch
      className="db-tables-panel db-tables-panel--dock"
      value={search}
      onChange={setSearch}
      placeholder={
        subTab === "connections"
          ? t("database.connectionInfo.search")
          : t("database.connectionInfo.variablesSearch")
      }
      enabled={capable}
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
          <button
            type="button"
            className="db-mysql-config-btn"
            title={t("database.connectionInfo.configEditor.open")}
            onClick={() => void handleOpenConfig()}
            disabled={deploymentLoading || !!configEditor}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
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
            {t("database.connectionInfo.tabs.variables")}
          </button>
        </div>
      ) : null}
      <div
        className="db-tables-panel-body"
        role="tabpanel"
        aria-label={
          subTab === "connections"
            ? t("database.connectionInfo.tabs.connections")
            : t("database.connectionInfo.tabs.variables")
        }
      >
        <div className="db-tables-panel-grid-wrap">{content}</div>
      </div>
      <div className="db-tables-panel-meta">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void refreshActiveTab();
            void refreshDeployment();
          }}
          disabled={tabLoading || deploymentLoading || !capable}
        >
          {t("database.sidebar.refresh")}
        </Button>
        <span className="db-tables-panel-meta-text">
          {tabLoading
            ? t("common.loading")
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
        <TextEditorSubWindow
          open={configEditor !== null}
          title={configEditor?.path.split("/").pop() ?? "my.cnf"}
          subtitle={configEditor?.path}
          io={configEditor?.io ?? null}
          language="text"
          onClose={handleCloseConfig}
        />
      </>
    );
  }

  return (
    <>
      {panelBody(subTab === "connections" ? renderConnectionsTable() : renderVariablesTable())}
      <TextEditorSubWindow
        open={configEditor !== null}
        title={configEditor?.path.split("/").pop() ?? "my.cnf"}
        subtitle={configEditor?.path}
        io={configEditor?.io ?? null}
        language="text"
        onClose={handleCloseConfig}
      />
    </>
  );
}
