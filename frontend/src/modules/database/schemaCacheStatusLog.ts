import { publishModuleStatusLog } from "../../lib/moduleStatusLog";
import type { SchemaCacheRefreshReporter } from "./schemaCacheRefresh";

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/** 数据库模块 Schema 缓存刷新 → 状态栏进度日志 */
export function createSchemaCacheRefreshReporter(t: TranslateFn): SchemaCacheRefreshReporter {
  return {
    onStart: () => {
      publishModuleStatusLog("database", t("database.statusLog.refreshingAll"), "progress");
    },
    onConnectionStart: ({ name, index, total }) => {
      publishModuleStatusLog(
        "database",
        t("database.statusLog.refreshingConnection", { name, index, total }),
        "progress",
      );
    },
    onDatabaseStart: ({ connectionName, databaseName }) => {
      publishModuleStatusLog(
        "database",
        t("database.statusLog.refreshingDatabase", {
          connection: connectionName,
          database: databaseName,
        }),
        "progress",
      );
    },
    onConnectionComplete: ({ name, index, total }) => {
      publishModuleStatusLog(
        "database",
        t("database.statusLog.connectionDone", { name, index, total }),
        "progress",
      );
    },
    onComplete: () => {
      publishModuleStatusLog("database", t("database.statusLog.allDone"), "success");
    },
    onError: (message) => {
      publishModuleStatusLog(
        "database",
        t("database.statusLog.allFailed", { message }),
        "error",
      );
    },
  };
}

export function publishSchemaNodeRefreshStart(t: TranslateFn, name: string): void {
  publishModuleStatusLog(
    "database",
    t("database.statusLog.refreshingNode", { name }),
    "progress",
  );
}

export function publishSchemaNodeRefreshDone(t: TranslateFn, name: string): void {
  publishModuleStatusLog("database", t("database.statusLog.nodeDone", { name }), "success");
}

export function publishSchemaNodeRefreshFailed(
  t: TranslateFn,
  name: string,
  message: string,
): void {
  publishModuleStatusLog(
    "database",
    t("database.statusLog.nodeFailed", { name, message }),
    "error",
  );
}
