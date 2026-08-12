import { t } from "../../i18n";
import { publishModuleStatusLog } from "../../lib/moduleStatusLog";
import type { RefreshAllDockerSidebarCachesOptions } from "./hooks/useDockerConnectionResources";

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/** Docker 侧栏「刷新全部连接缓存」→ 状态栏进度日志 */
export function createDockerSidebarCacheRefreshReporter(
  translate: TranslateFn,
  getConnectionName: (connectionId: string) => string,
): RefreshAllDockerSidebarCachesOptions {
  return {
    getConnectionName,
    onStart: (total) => {
      publishModuleStatusLog(
        "docker",
        translate("docker.statusLog.refreshingAll", { total }),
        "progress",
      );
    },
    onConnectionDone: ({ done, total, connectionName }) => {
      publishModuleStatusLog(
        "docker",
        translate("docker.statusLog.refreshingConnection", {
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
        translate("docker.statusLog.allDone", { total }),
        "success",
      );
    },
    onSomeFailed: ({ failed, total, message }) => {
      publishModuleStatusLog(
        "docker",
        translate("docker.statusLog.someFailed", { failed, total, message }),
        "error",
      );
    },
  };
}

export function publishDockerSidebarCacheRefreshFailed(
  translate: TranslateFn,
  message: string,
): void {
  publishModuleStatusLog(
    "docker",
    translate("docker.statusLog.allFailed", { message }),
    "error",
  );
}

/** 单连接 / 单分类侧栏缓存刷新失败 → 状态栏错误 */
export function publishDockerSidebarRefreshFailed(message: string): void {
  const text = message.trim();
  if (!text) return;
  publishModuleStatusLog(
    "docker",
    t("docker.statusLog.refreshFailed", { message: text }),
    "error",
  );
}
