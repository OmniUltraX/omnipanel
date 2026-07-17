import { publishModuleStatusLog } from "../../lib/moduleStatusLog";
import type { RefreshAllDockerSidebarCachesOptions } from "./hooks/useDockerConnectionResources";

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/** Docker 侧栏「刷新全部连接缓存」→ 状态栏进度日志 */
export function createDockerSidebarCacheRefreshReporter(
  t: TranslateFn,
  getConnectionName: (connectionId: string) => string,
): RefreshAllDockerSidebarCachesOptions {
  return {
    getConnectionName,
    onStart: (total) => {
      publishModuleStatusLog(
        "docker",
        t("docker.statusLog.refreshingAll", { total }),
        "progress",
      );
    },
    onConnectionDone: ({ done, total, connectionName }) => {
      publishModuleStatusLog(
        "docker",
        t("docker.statusLog.refreshingConnection", {
          name: connectionName,
          done,
          total,
        }),
        "progress",
      );
    },
    onComplete: (total) => {
      publishModuleStatusLog(
        "docker",
        t("docker.statusLog.allDone", { total }),
        "success",
      );
    },
  };
}

export function publishDockerSidebarCacheRefreshFailed(
  t: TranslateFn,
  message: string,
): void {
  publishModuleStatusLog(
    "docker",
    t("docker.statusLog.allFailed", { message }),
    "error",
  );
}
