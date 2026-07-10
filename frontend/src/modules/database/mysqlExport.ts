import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DbConnectionConfig } from "./api";
import type { MysqlDeploymentInfo } from "./mysqlDeploymentDetect";
import { resolveDockerExecTarget } from "./dockerContainerResolve";

export type MysqlExportDeploymentOption = {
  kind: "local" | "host" | "docker";
  sshConnectionId?: string;
  containerId?: string;
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

export async function listMysqlExports(connectionId: string): Promise<MysqlExportRecord[]> {
  return invoke<MysqlExportRecord[]>("db_mysql_export_list", { connectionId });
}

export async function saveMysqlExportAs(
  connectionId: string,
  exportId: string,
  destPath: string,
): Promise<string> {
  return invoke<string>("db_mysql_export_save_as", {
    connectionId,
    exportId,
    destPath,
  });
}

export async function submitDbMysqlExport(
  connection: DbConnectionConfig,
  databaseName: string,
  deployment: MysqlExportDeploymentOption,
): Promise<string> {
  return invoke<string>("bg_task_submit_db_mysql_export", {
    connection,
    databaseName,
    deployment,
  });
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
