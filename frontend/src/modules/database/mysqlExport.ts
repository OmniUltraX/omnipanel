import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatIpcError, type IpcErrorLike } from "../../ipc/result";
import type { DbConnectionConfig } from "./api";
import type { MysqlDeploymentInfo } from "./mysqlDeploymentDetect";
import { resolveDockerExecTarget } from "./dockerContainerResolve";

export type MysqlExportDeploymentOption = {
  kind: "local" | "host" | "docker";
  sshConnectionId?: string;
  containerId?: string;
  /** Docker 容器内监听端口；勿传宿主机 publish 端口 */
  mysqlPort?: number;
};

export type MysqlExportRecord = {
  id: string;
  connectionId: string;
  databaseName: string;
  fileName: string;
  filePath: string;
  createdAt: number;
  fileSize: number;
  status: "running" | "completed" | "failed" | string;
  error?: string | null;
  taskId?: string | null;
};

export type MysqlExportEvent = {
  taskId: string;
  eventType: string;
  connectionId: string;
  export?: MysqlExportRecord | null;
  error?: string | null;
};

export function resolveMysqlExportDeployment(
  deployment: MysqlDeploymentInfo | null | undefined,
): MysqlExportDeploymentOption {
  const mysqlPort =
    typeof deployment?.mysqlPort === "number" && deployment.mysqlPort > 0
      ? deployment.mysqlPort
      : undefined;
  if (deployment?.kind === "docker" && deployment.sshConnectionId) {
    const containerId = resolveDockerExecTarget({
      containerId: deployment.containerId,
      containerName: deployment.containerName,
      locationTag: deployment.locationTag,
    });
    if (containerId) {
      return {
        kind: "docker",
        sshConnectionId: deployment.sshConnectionId,
        containerId,
        mysqlPort: mysqlPort ?? 3306,
      };
    }
  }
  if (deployment?.kind === "host" && deployment.sshConnectionId) {
    return {
      kind: "host",
      sshConnectionId: deployment.sshConnectionId,
    };
  }
  return { kind: "local" };
}

function formatMysqlExportError(error: unknown): string {
  return formatIpcError(error as IpcErrorLike);
}

export async function listMysqlExports(connectionId: string): Promise<MysqlExportRecord[]> {
  try {
    return await invoke<MysqlExportRecord[]>("db_mysql_export_list", { connectionId });
  } catch (error) {
    throw new Error(formatMysqlExportError(error));
  }
}

export async function saveMysqlExportAs(
  connectionId: string,
  exportId: string,
  destPath: string,
): Promise<string> {
  try {
    return await invoke<string>("db_mysql_export_save_as", {
      connectionId,
      exportId,
      destPath,
    });
  } catch (error) {
    throw new Error(formatMysqlExportError(error));
  }
}

export async function deleteMysqlExport(
  connectionId: string,
  exportId: string,
): Promise<void> {
  try {
    await invoke<void>("db_mysql_export_delete", {
      connectionId,
      exportId,
    });
  } catch (error) {
    throw new Error(formatMysqlExportError(error));
  }
}

export async function submitDbMysqlExport(
  connection: DbConnectionConfig,
  databaseName: string,
  deployment: MysqlExportDeploymentOption,
): Promise<string> {
  try {
    return await invoke<string>("bg_task_submit_db_mysql_export", {
      connection,
      databaseName,
      deployment,
    });
  } catch (error) {
    throw new Error(formatMysqlExportError(error));
  }
}

export function listenMysqlExportEvents(
  connectionId: string,
  onEvent: (event: MysqlExportEvent) => void,
): Promise<() => void> {
  return listen<MysqlExportEvent>("bg-task-mysql-export-event", (payload) => {
    if (payload.payload.connectionId !== connectionId) {
      return;
    }
    onEvent(payload.payload);
  });
}

/**
 * 在提交导出前注册监听，避免任务极快失败时漏掉终态事件。
 * `bindTaskId` 在拿到 taskId 后调用；终态后自动取消订阅。
 */
export async function beginWatchMysqlExportTask(
  connectionId: string,
  onTerminal: (event: MysqlExportEvent) => void,
): Promise<{ bindTaskId: (taskId: string) => void; cancel: () => void }> {
  let settled = false;
  let taskId: string | null = null;
  let unlisten: (() => void) | undefined;
  const cancel = () => {
    if (settled) return;
    settled = true;
    unlisten?.();
  };
  unlisten = await listenMysqlExportEvents(connectionId, (event) => {
    if (settled || !taskId || event.taskId !== taskId) return;
    if (event.eventType !== "failed" && event.eventType !== "completed") return;
    onTerminal(event);
    cancel();
  });
  window.setTimeout(cancel, 2 * 60 * 60 * 1000);
  return {
    bindTaskId: (id) => {
      taskId = id;
    },
    cancel,
  };
}

export function formatExportFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}
