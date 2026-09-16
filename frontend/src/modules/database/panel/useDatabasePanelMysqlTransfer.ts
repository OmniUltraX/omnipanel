import {
  useCallback,
  useState,
  type MutableRefObject,
} from "react";
import {
  createDatabase,
  isConnectionEnabled,
  listDatabases,
  type DbConnectionConfig,
} from "../api";
import {
  probeMysqlDeployment,
} from "../mysqlDeploymentDetect";
import {
  readMysqlDeploymentCache,
  isMysqlDeploymentCacheUsable,
} from "../mysqlDeploymentCache";
import { ensureSshExecReady } from "../mysqlSlowQueryLog";
import {
  resolveMysqlExportDeployment,
  beginWatchMysqlExportTask,
  submitDbMysqlExport,
  saveMysqlExportAs,
  type MysqlExportDestination,
} from "../mysqlExport";
import {
  beginWatchMysqlImportTask,
  submitDbMysqlImport,
  type MysqlImportSource,
} from "../mysqlImport";
import { submitSchemaCacheRefresh } from "../schema/schemaCacheBackgroundTasks";
import type { SchemaCacheRefreshReporter } from "../schema/schemaCacheRefresh";
import { showToast } from "../../../stores/toastStore";
import type { Connection } from "../../../ipc/bindings";
import type { SchemaDockOpenMode } from "../workspace/workspaceTabs";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export type MysqlTransferDialog = {
  connection: DbConnectionConfig;
  databaseName: string;
};

export type UseDatabasePanelMysqlTransferDeps = {
  t: Translate;
  sshConnections: Connection[];
  schemaCacheReporter: SchemaCacheRefreshReporter;
  openConnectionInfoTabRef: MutableRefObject<
    (connId: string, mode?: SchemaDockOpenMode, options?: { expandTree?: boolean }) => void
  >;
};

export function useDatabasePanelMysqlTransfer(deps: UseDatabasePanelMysqlTransferDeps) {
  const { t, sshConnections, schemaCacheReporter, openConnectionInfoTabRef } = deps;

  const [importDialog, setImportDialog] = useState<MysqlTransferDialog | null>(null);
  const [importSubmitting, setImportSubmitting] = useState(false);
  const [exportDialog, setExportDialog] = useState<MysqlTransferDialog | null>(null);
  const [exportSubmitting, setExportSubmitting] = useState(false);

  const handleOpenExportDatabase = useCallback(
    (connection: DbConnectionConfig, databaseName: string) => {
      if (!isConnectionEnabled(connection)) {
        showToast(t("database.export.connectionDisabled"));
        return;
      }
      setExportDialog({ connection, databaseName });
    },
    [t],
  );

  const resolveExportDeployment = useCallback(
    async (connection: DbConnectionConfig) => {
      let deployment = readMysqlDeploymentCache(connection);
      const cacheUsable = isMysqlDeploymentCacheUsable(deployment);
      const cacheSshStale =
        cacheUsable &&
        deployment?.sshConnectionId != null &&
        !sshConnections.some((c) => c.id === deployment?.sshConnectionId);
      if (!cacheUsable || cacheSshStale) {
        try {
          deployment = await probeMysqlDeployment(connection, sshConnections);
        } catch {
          deployment = deployment ?? null;
        }
      }
      const resolved = resolveMysqlExportDeployment(deployment);
      if (
        resolved.sshConnectionId &&
        (resolved.kind === "host" || resolved.kind === "docker")
      ) {
        const ready = await ensureSshExecReady(
          resolved.sshConnectionId,
          connection,
          sshConnections,
        );
        if (!ready) {
          throw new Error(t("database.contextMenu.slowQueryLogDisabled.sshNotConnected"));
        }
      }
      return resolved;
    },
    [sshConnections, t],
  );

  const handleExportDatabase = useCallback(
    async (connection: DbConnectionConfig, databaseName: string) => {
      handleOpenExportDatabase(connection, databaseName);
    },
    [handleOpenExportDatabase],
  );

  const handleConfirmExportDatabase = useCallback(
    async (destination: MysqlExportDestination) => {
      if (!exportDialog) {
        return;
      }
      const { connection, databaseName } = exportDialog;
      setExportSubmitting(true);
      try {
        const sourceDeployment = await resolveExportDeployment(connection);
        if (destination.kind === "clone") {
          const existing = await listDatabases(destination.targetConnection, { quiet: true });
          if (!existing.includes(destination.targetDatabase)) {
            await createDatabase({
              connection: destination.targetConnection,
              name: destination.targetDatabase,
            });
          }
        }
        const watch = await beginWatchMysqlExportTask(connection.id, (event) => {
          if (event.eventType === "failed") {
            const detail =
              event.error?.trim() ||
              event.export?.error?.trim() ||
              "";
            showToast(
              detail
                ? t("database.export.failedDetail", { error: detail })
                : t("database.connectionInfo.exports.statusFailed"),
            );
            return;
          }
          const exportRecord = event.export;
          if (event.eventType !== "completed" || !exportRecord || !exportRecord.id) {
            return;
          }
          if (destination.kind === "local") {
            void saveMysqlExportAs(connection.id, exportRecord.id, destination.destPath)
              .then(() => {
                showToast(
                  t("database.export.savedLocal", { path: destination.destPath }),
                );
              })
              .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                showToast(
                  message
                    ? t("database.export.failedDetail", { error: message })
                    : t("database.connectionInfo.exports.downloadFailed"),
                );
              });
            return;
          }
          void (async () => {
            try {
              const importDeployment = await resolveExportDeployment(destination.targetConnection);
              showToast(
                t("database.export.cloneImportStarted", {
                  database: destination.targetDatabase,
                }),
              );
              const importWatch = await beginWatchMysqlImportTask((task) => {
                if (task.status === "completed") {
                  showToast(
                    t("database.import.completed", {
                      database: destination.targetDatabase,
                    }),
                  );
                  void submitSchemaCacheRefresh(
                    [destination.targetConnection.id],
                    schemaCacheReporter,
                  ).catch((err) => {
                    schemaCacheReporter.onError?.(String(err));
                  });
                  return;
                }
                if (task.status === "failed") {
                  const detail = task.error?.trim() || "";
                  showToast(
                    detail
                      ? t("database.import.failedDetail", { error: detail })
                      : t("database.import.failed"),
                  );
                }
              });
              try {
                const importTaskId = await submitDbMysqlImport(
                  destination.targetConnection,
                  destination.targetDatabase,
                  importDeployment,
                  exportRecord.filePath
                    ? { kind: "file", filePath: exportRecord.filePath }
                    : { kind: "export", exportId: exportRecord.id },
                );
                importWatch.bindTaskId(importTaskId);
              } catch (error) {
                importWatch.cancel();
                const message = error instanceof Error ? error.message : String(error);
                showToast(
                  message
                    ? t("database.import.failedDetail", { error: message })
                    : t("database.import.failed"),
                );
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              showToast(
                message
                  ? t("database.import.failedDetail", { error: message })
                  : t("database.import.failed"),
              );
            }
          })();
        });
        try {
          const taskId = await submitDbMysqlExport(connection, databaseName, {
            ...sourceDeployment,
            includeCreateDatabase: destination.kind !== "clone",
          });
          watch.bindTaskId(taskId);
          showToast(
            destination.kind === "clone"
              ? t("database.export.cloneStarted", {
                  database: databaseName,
                  target: destination.targetDatabase,
                })
              : t("database.export.started", { database: databaseName }),
          );
          openConnectionInfoTabRef.current(connection.id, "permanent");
          setExportDialog(null);
        } catch (error) {
          watch.cancel();
          const message = error instanceof Error ? error.message : String(error);
          showToast(
            message
              ? t("database.export.failedDetail", { error: message })
              : t("database.export.failed"),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showToast(
          message
            ? t("database.export.createTargetFailed", { error: message })
            : t("database.export.failed"),
        );
      } finally {
        setExportSubmitting(false);
      }
    },
    [exportDialog, openConnectionInfoTabRef, resolveExportDeployment, schemaCacheReporter, t],
  );

  const handleOpenImportDatabase = useCallback(
    (connection: DbConnectionConfig, databaseName: string) => {
      if (!isConnectionEnabled(connection)) {
        showToast(t("database.import.connectionDisabled"));
        return;
      }
      setImportDialog({ connection, databaseName });
    },
    [t],
  );

  const handleConfirmImportDatabase = useCallback(
    async (source: MysqlImportSource) => {
      if (!importDialog) {
        return;
      }
      const { connection, databaseName } = importDialog;
      setImportSubmitting(true);
      try {
        let deployment = readMysqlDeploymentCache(connection);
        if (!deployment || deployment.kind === "unknown") {
          try {
            deployment = await probeMysqlDeployment(connection, sshConnections);
          } catch {
            deployment = deployment ?? null;
          }
        }
        const importDeployment = resolveMysqlExportDeployment(deployment);
        const watch = await beginWatchMysqlImportTask((task) => {
          if (task.status === "completed") {
            showToast(t("database.import.completed", { database: databaseName }));
            return;
          }
          if (task.status === "failed") {
            const detail = task.error?.trim() || "";
            showToast(
              detail
                ? t("database.import.failedDetail", { error: detail })
                : t("database.import.failed"),
            );
          }
        });
        try {
          const taskId = await submitDbMysqlImport(
            connection,
            databaseName,
            importDeployment,
            source,
          );
          watch.bindTaskId(taskId);
          showToast(t("database.import.started", { database: databaseName }));
          setImportDialog(null);
        } catch (error) {
          watch.cancel();
          const message = error instanceof Error ? error.message : String(error);
          showToast(
            message
              ? t("database.import.failedDetail", { error: message })
              : t("database.import.failed"),
          );
        }
      } finally {
        setImportSubmitting(false);
      }
    },
    [importDialog, sshConnections, t],
  );

  return {
    exportDialog,
    setExportDialog,
    exportSubmitting,
    importDialog,
    setImportDialog,
    importSubmitting,
    handleOpenExportDatabase,
    handleExportDatabase,
    handleConfirmExportDatabase,
    handleOpenImportDatabase,
    handleConfirmImportDatabase,
  };
}
